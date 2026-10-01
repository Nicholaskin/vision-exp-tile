/**
 * batch-report.js — 批量识别的「文件枚举 + 进度索引 + 报告生成」（零依赖，可单测）
 *
 * v1.0.0 新增（大更新①：批量/目录级识别流水线）。
 * 本模块只管**不确定性的另一面**——文件系统与文本拼装（确定的事交给脚本，交给模型的是识别本身）：
 *   1. `parsePatterns` / `listImages`：目录枚举（扩展名过滤、递归、稳定排序）
 *   2. `readIndex` / `appendIndex`：`index.jsonl` 增量进度（**续跑的唯一依据**）
 *   3. `buildMarkdownReport` / `buildFullReport` / `writeReports`：人读 + 机读报告
 *
 * 目录结构约定（批量工具产出）：
 * ```
 * <out_dir>/batch-<yyyymmdd-HHMMSS>/
 *   index.jsonl        每图一行 JSON（状态/耗时/哈希/错误）——续跑据此跳过已完成项
 *   report.md          人读汇总（逐图摘要 + 统计）
 *   report-full.md     全文合并（每图完整答案）
 *   report.json        机读汇总
 *   <文件名>/           每图的明细目录（precheck.json / ocr.txt / answer.md / 区域 PNG）
 * ```
 *
 * @module vision-exp-tile/batch-report
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

/** 默认图片扩展名（可与 `pattern` 合并） */
export const DEFAULT_PATTERNS = ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.gif', '*.bmp'];

/**
 * 解析 pattern 字符串为扩展名集合（小写，含点）。
 * 支持 `"*.png;*.jpg"`、`"png,jpg"`、`"*.PNG"` 等写法；空值回落默认集合。
 * @param {string} [pattern] - 用户输入的模式串
 * @returns {Set<string>} 形如 {'.png', '.jpg'}
 */
export function parsePatterns(pattern) {
  const raw = String(pattern ?? '').trim();
  const list = raw.length > 0 ? raw.split(/[;,、\s]+/).filter(Boolean) : DEFAULT_PATTERNS;
  const set = new Set();
  for (const item of list) {
    const cleaned = item.replace(/^\*/, '').trim().toLowerCase();
    if (cleaned.length === 0) continue;
    set.add(cleaned.startsWith('.') ? cleaned : `.${cleaned}`);
  }
  return set.size > 0 ? set : new Set(DEFAULT_PATTERNS.map((p) => p.replace('*', '')));
}

/**
 * 枚举目录下的图片文件（稳定排序：相对路径字典序 → 保证多次运行顺序一致，续跑可复现）。
 * @param {string} inputDir - 输入目录（绝对或相对路径）
 * @param {object} [opts]
 * @param {string} [opts.pattern] - 模式串（见 parsePatterns）
 * @param {boolean} [opts.recursive=false] - 是否递归子目录
 * @param {number} [opts.maxFiles=100000] - 安全上限（防误指到根目录）
 * @returns {Promise<Array<{path:string, rel:string, name:string, ext:string, size:number}>>}
 */
export async function listImages(inputDir, opts = {}) {
  const { recursive = false, maxFiles = 100000, pattern } = opts;
  const exts = parsePatterns(pattern);
  /** @type {Array<{path:string, rel:string, name:string, ext:string, size:number}>} */
  const out = [];
  const walk = async (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读：跳过（批量工具不应因个别子目录崩掉）
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.')) continue; // 跳过隐藏项
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      if (!exts.has(ext)) continue;
      let size = 0;
      try { size = (await stat(full)).size; } catch { /* 读不到大小也收录 */ }
      // rel 统一用正斜杠：报告可读性 + 索引键跨平台一致（Windows 反斜杠会污染 Markdown / JSON）
      const rel = relative(inputDir, full).split('\\').join('/');
      out.push({ path: full, rel, name: e.name, ext, size });
    }
  };
  await walk(inputDir);
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
  return out;
}

/**
 * 计算文件内容哈希（sha256 前 32 hex；与 OCR/结果缓存同口径）。
 * 用流式读取，避免大图一次性进内存。
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} 32 位十六进制串；读取失败返回空串
 */
export async function hashFile(filePath) {
  return new Promise((resolve) => {
    try {
      const h = createHash('sha256');
      const rs = createReadStream(filePath);
      rs.on('data', (chunk) => h.update(chunk));
      rs.on('end', () => resolve(h.digest('hex').slice(0, 32)));
      rs.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
}

/* ------------------------------------------------------------------ */
/* index.jsonl（续跑索引）                                              */
/* ------------------------------------------------------------------ */

/** 索引文件路径 */
export function indexPath(batchDir) {
  return join(batchDir, 'index.jsonl');
}

/**
 * 读取索引：以 `rel` 为键返回最新一条记录（同一文件多次运行以最后一次为准）。
 * 文件不存在/行损坏 → 跳过该行（续跑不应因一行坏数据失败）。
 * @param {string} batchDir - 批次目录
 * @returns {Promise<Map<string, object>>} rel → entry
 */
export async function readIndex(batchDir) {
  const map = new Map();
  const file = indexPath(batchDir);
  if (!existsSync(file)) return map;
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s.length === 0) continue;
      try {
        const entry = JSON.parse(s);
        if (entry && typeof entry.rel === 'string') map.set(entry.rel, entry);
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 整文件读失败 → 视为无索引（全部重跑） */ }
  return map;
}

/**
 * 追加一条索引记录（JSONL：一行一条，天然可增量、可人工查看）。
 * @param {string} batchDir - 批次目录
 * @param {object} entry - 记录（至少含 rel / status）
 * @returns {Promise<void>}
 */
export async function appendIndex(batchDir, entry) {
  try {
    await mkdir(batchDir, { recursive: true });
    await appendFile(indexPath(batchDir), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 索引写失败不阻断识别（仅影响续跑能力） */ }
}

/* ------------------------------------------------------------------ */
/* 报告生成                                                             */
/* ------------------------------------------------------------------ */

/**
 * 由索引 + 图片清单推导一批「待处理 / 已完成 / 失败」视图。
 *
 * 续跑语义（写死在这里，避免各处理解不一致）：
 *  - `status === 'done'` 且（resume=true 时）视为已完成 → 跳过；
 *  - `status === 'failed'` → 重试；
 *  - 无记录 → 待处理。
 *
 * @param {Array<object>} files - listImages() 结果
 * @param {Map<string, object>} index - readIndex() 结果
 * @param {object} [opts]
 * @param {boolean} [opts.resume=true] - false 时全量重跑（忽略已完成）
 * @param {number} [opts.limit=Infinity] - 本次最多处理多少张
 * @returns {{todo:Array<object>, done:Array<object>, failed:Array<object>, skipped:Array<object>}}
 */
export function planBatch(files, index, opts = {}) {
  const { resume = true, limit = Infinity } = opts;
  const todo = [];
  const done = [];
  const failed = [];
  const skipped = [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  for (const f of files) {
    const prev = index.get(f.rel);
    const isDone = prev?.status === 'done';
    if (isDone) done.push({ ...f, prev });
    else if (prev?.status === 'failed') failed.push({ ...f, prev });
    // 待处理 = 无记录 或 失败重试；resume=false 时已完成项也重跑
    const needsWork = !isDone || !resume;
    if (!needsWork) continue;
    if (todo.length < max) todo.push({ ...f, prev });
    else skipped.push({ ...f, prev });
  }
  return { todo, done, failed, skipped };
}

/** 把毫秒格式化为人类可读（1.2s / 2m03s / 1h05m） */
export function humanMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'n/a';
  if (n < 1000) return `${Math.round(n)}ms`;
  const s = n / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** 取文本首段作为摘要（用于批量报告，避免把全文塞进汇总） */
export function previewOf(text, maxChars = 600) {
  const s = String(text ?? '').trim();
  if (s.length === 0) return '';
  const para = s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const body = (para[1] ?? para[0] ?? s).replace(/^#+\s*/gm, '');
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

/**
 * 生成人读 Markdown 汇总报告。
 * @param {object} opts
 * @param {string} opts.batchId - 批次号（batch-20261002-101530）
 * @param {string} opts.inputDir - 输入目录
 * @param {string} opts.outDir - 批次目录
 * @param {Array<object>} opts.results - 本次运行结果 [{rel,status,ms,answer?,error?,outDir?,sha?,cached?}]
 * @param {Array<object>} opts.pendingAll - 全部图片的当前状态（含历史已完成项）
 * @param {object} [opts.meta] - 附加信息（模型/端点/并发/缓存命中数等）
 * @returns {string} Markdown 文本
 */
export function buildMarkdownReport({ batchId, inputDir, outDir, results = [], pendingAll = [], meta = {} }) {
  const total = pendingAll.length;
  const done = pendingAll.filter((x) => x.status === 'done');
  const failed = pendingAll.filter((x) => x.status === 'failed');
  const pending = pendingAll.filter((x) => x.status === 'pending');
  const totalMs = results.reduce((a, r) => a + (Number(r.ms) || 0), 0);
  const lines = [];
  lines.push(`# 批量识别报告 · ${batchId}`);
  lines.push('');
  lines.push(`- 输入目录：\`${inputDir}\``);
  lines.push(`- 批次目录：\`${outDir}\``);
  lines.push(`- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`- 图片总数：**${total}**（成功 ${done.length} / 失败 ${failed.length} / 待处理 ${pending.length}）`);
  lines.push(`- 本次运行：处理 ${results.length} 张，用时 ${humanMs(totalMs)}`);
  if (meta.model) lines.push(`- 端点：\`${meta.baseURL ?? '?'}\` · 模型：\`${meta.model}\``);
  if (meta.concurrency !== undefined) lines.push(`- 并发：图级 ${meta.concurrency}${meta.apiConcurrency !== undefined ? ` · API ${meta.apiConcurrency}` : ''}`);
  // 只在实际命中时输出：0 命中时说"未产生 API 请求"会误导（真机验证时踩到过）
  if (meta.cacheHits > 0) lines.push(`- 缓存命中：${meta.cacheHits} 张（这部分未产生 API 请求）`);
  if (meta.duplicates !== undefined && meta.duplicates > 0) lines.push(`- 批内重复图片：${meta.duplicates} 张（复用同批识别结果）`);
  lines.push('');

  if (failed.length > 0) {
    lines.push('## ⚠ 失败清单');
    lines.push('');
    lines.push('| 文件 | 原因 |');
    lines.push('|---|---|');
    for (const f of failed) {
      lines.push(`| \`${f.rel}\` | ${String(f.error ?? f.prev?.error ?? '未知').replace(/\|/g, '\\|').slice(0, 200)} |`);
    }
    lines.push('');
  }

  lines.push('## 逐图结果');
  lines.push('');
  if (pendingAll.length === 0) lines.push('（无图片）');
  for (const item of pendingAll) {
    const head = `### ${item.status === 'done' ? '✅' : item.status === 'failed' ? '❌' : '⏳'} ${item.rel}`;
    lines.push(head);
    lines.push('');
    const bits = [];
    if (item.ms) bits.push(`耗时 ${humanMs(item.ms)}`);
    if (item.cached) bits.push('缓存命中');
    if (item.sha) bits.push(`\`${item.sha.slice(0, 12)}\``);
    if (item.duplicateOf) bits.push(`与 \`${item.duplicateOf}\` 内容相同`);
    if (bits.length > 0) lines.push(`> ${bits.join(' · ')}`);
    if (item.outDir) lines.push(`> 明细目录：\`${item.outDir}\``);
    lines.push('');
    if (item.status === 'done' && item.answer) {
      lines.push(previewOf(item.answer));
    } else if (item.status === 'failed') {
      lines.push(`> 错误：${String(item.error ?? item.prev?.error ?? '未知').slice(0, 400)}`);
    } else {
      lines.push('> 待处理（可再次调用批量工具续跑）');
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 生成全文合并报告（每图完整答案，便于一次性阅读/检索）。
 * @param {object} opts - 同 buildMarkdownReport，另用 results[].answer 全文
 * @returns {string} Markdown 文本
 */
export function buildFullReport({ batchId, inputDir, results = [] }) {
  const lines = [`# 批量识别全文 · ${batchId}`, '', `输入目录：\`${inputDir}\``, ''];
  let n = 0;
  for (const r of results) {
    if (r.status !== 'done' || !r.answer) continue;
    n += 1;
    lines.push(`## ${n}. ${r.rel}`);
    lines.push('');
    lines.push(String(r.answer).trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  if (n === 0) lines.push('（本次运行无成功结果）');
  return lines.join('\n');
}

/**
 * 生成机读 JSON 汇总。
 * @param {object} opts - 同 buildMarkdownReport
 * @returns {string} JSON 文本
 */
export function buildJsonReport({ batchId, inputDir, outDir, results = [], pendingAll = [], meta = {} }) {
  return JSON.stringify({
    batchId,
    inputDir,
    outDir,
    generatedAt: new Date().toISOString(),
    meta,
    stats: {
      total: pendingAll.length,
      done: pendingAll.filter((x) => x.status === 'done').length,
      failed: pendingAll.filter((x) => x.status === 'failed').length,
      pending: pendingAll.filter((x) => x.status === 'pending').length,
      runCount: results.length,
      runMs: results.reduce((a, r) => a + (Number(r.ms) || 0), 0)
    },
    items: pendingAll.map((x) => ({
      rel: x.rel,
      status: x.status,
      ms: x.ms ?? null,
      sha: x.sha ?? null,
      cached: Boolean(x.cached),
      duplicateOf: x.duplicateOf ?? null,
      outDir: x.outDir ?? null,
      error: x.error ?? null
    }))
  }, null, 2);
}

/**
 * 落盘三份报告（report.md / report-full.md / report.json）。
 * @param {string} batchDir - 批次目录
 * @param {object} payload - 传给上述三个 build* 的参数集合
 * @returns {Promise<{report:string, full:string, json:string}>} 三个文件路径
 */
export async function writeReports(batchDir, payload) {
  await mkdir(batchDir, { recursive: true });
  const report = join(batchDir, 'report.md');
  const full = join(batchDir, 'report-full.md');
  const json = join(batchDir, 'report.json');
  await writeFile(report, buildMarkdownReport(payload), 'utf8');
  await writeFile(full, buildFullReport(payload), 'utf8');
  await writeFile(json, buildJsonReport(payload), 'utf8');
  return { report, full, json };
}

/** 批次目录名：batch-<yyyymmdd-HHMMSS>（本地时间；同秒冲突时由调用方加后缀） */
export function batchDirName(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `batch-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** 每图明细子目录名：安全化文件名（去掉扩展名、前导点与非法字符；空则兜底 image） */
export function safeItemDirName(rel) {
  const base = basename(rel, extname(rel)).replace(/^\.+/, '');
  const safe = base.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').replace(/^[.-]+$/, '').slice(0, 60);
  return safe || 'image';
}
