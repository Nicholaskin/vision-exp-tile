/**
 * batch.js — 批量/目录级识别流水线编排（v1.0.0 大更新①）
 *
 * 一句话：把「一次一张图」的工具，升级成「一次一个目录」的流水线——
 * 枚举 → 逐图识别（可并发）→ 进度索引 → 报告三件套 → **可中断、可续跑**。
 *
 * 与单图工具的关系：本模块**不重新实现识别**，而是复用既有链路：
 *   - strategy='pipeline' → runPipeline()（预检 → 本地 OCR → 兴趣点识别 → 汇总，全自动无交互）
 *   - strategy='full'     → splitImage() + recognize()（整图网格切块识别）
 * （smart 策略需要会话模型逐步编排，不适合无人值守批处理，工具层会明确拒绝。）
 *
 * 三条工程约束（都是踩过坑换来的）：
 *   1. **可续跑**：`index.jsonl` 是唯一进度真相；报告每次全量重建，跑一半中断也不丢数据；
 *   2. **失败隔离**：单图失败写 `failed` 继续下一张（批处理不能因一张坏图全批报废）；
 *   3. **时间可控**：`timeBudgetMs` 到点即收工，返回剩余张数供再次调用，避免超宿主工具超时被砍。
 *
 * @module vision-exp-tile/batch
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { openImageSource } from './host-io.js';
import { splitImage } from './tile-engine.js';
import { runPipeline } from './pipeline.js';
import { recognize } from './vision-client.js';
import { mapLimit, resolveBudget } from './concurrency.js';
import {
  listImages, hashFile, readIndex, appendIndex, planBatch,
  writeReports, batchDirName, safeItemDirName
} from './batch-report.js';

/** 单图字节上限（与 index.js 的 IMAGE_BYTE_CAP 一致：512MB） */
const IMAGE_BYTE_CAP = 512 * 1024 * 1024;

/**
 * 执行一批（或一次续跑）。
 *
 * @param {object} opts
 * @param {string} opts.inputDir - 输入目录（必填）
 * @param {string} [opts.outDir] - 报告根目录（默认 = 输入目录）
 * @param {string} [opts.batchId] - 指定批次号（续跑到已有批次）；缺省新建
 * @param {string} [opts.pattern] - 图片扩展名模式（默认内建集合）
 * @param {boolean} [opts.recursive=false] - 递归子目录
 * @param {string} [opts.question=''] - 识别侧重点
 * @param {'pipeline'|'full'} [opts.strategy='pipeline'] - 识别策略
 * @param {number} [opts.limit=5] - 本次最多处理多少张
 * @param {number} [opts.concurrency] - 图级并发（默认由算力预算给出）
 * @param {boolean} [opts.resume=true] - 跳过已完成项
 * @param {number} [opts.timeBudgetMs=240000] - 本次运行时间预算（到点收工）
 * @param {object} opts.cfg - 插件配置（baseURL/model/maxTokens/blockSize/…）
 * @param {string} [opts.apiKey] - API key（本地端点可空）
 * @param {AbortSignal} [opts.signal] - 取消信号
 * @param {Function} [opts.fetchImpl] - 注入 fetch（测试用）
 * @param {Function} [opts.pipelineOverride] - 注入单图 pipeline（测试用，避免真实 API）
 * @param {number} [opts.now] - 注入当前时间（测试用）
 * @returns {Promise<object>} 批次摘要（供工具层渲染）
 */
export async function runBatch(opts) {
  const {
    inputDir, outDir, batchId: batchIdIn, pattern, recursive = false,
    question = '', strategy = 'pipeline', limit = 5, resume = true,
    timeBudgetMs = 240000, cfg = {}, apiKey, signal, fetchImpl,
    pipelineOverride, ocrOverride, now = Date.now()
  } = opts;

  if (!inputDir || String(inputDir).trim().length === 0) {
    throw new Error('batch: input_dir 必须是非空字符串');
  }
  if (!['pipeline', 'full'].includes(strategy)) {
    throw new Error(`batch: strategy 仅支持 pipeline/full（smart 需要会话模型编排，不适合批处理）`);
  }
  if (!existsSync(inputDir)) {
    throw new Error(`batch: 输入目录不存在：${inputDir}`);
  }

  // ── 并发预算：显式 > 性能档位（本机核数）────────────────────────────
  const budget = resolveBudget({
    performanceTier: cfg.performanceTier,
    imageConcurrency: opts.concurrency,
    ocrPool: cfg.ocrPool,
    apiConcurrency: cfg.apiConcurrency
  });
  const imageConcurrency = Math.max(1, Math.min(4, Math.floor(opts.concurrency ?? budget.image)));

  // ── 批次目录（新建 or 续跑指定）────────────────────────────────────
  const root = String(outDir ?? '').trim().length > 0 ? String(outDir) : String(inputDir);
  await mkdir(root, { recursive: true });
  const batchId = String(batchIdIn ?? '').trim() || batchDirName(new Date(now));
  const batchDir = join(root, batchId);
  await mkdir(batchDir, { recursive: true });

  // ── 1. 枚举 + 读索引 + 排计划 ─────────────────────────────────────
  const files = await listImages(inputDir, { pattern, recursive });
  const index = await readIndex(batchDir);
  const plan = planBatch(files, index, { resume, limit });
  const startedAt = Date.now();

  /** 本次运行的结果（含失败）；用于报告与返回值 */
  const results = [];
  /** 批内内容去重表：sha → 首个 rel（同一批里完全相同的图不重复烧 API） */
  const seenSha = new Map();
  /** 因时间预算被跳过的项（下一轮续跑自动处理） */
  const budgetSkipped = [];

  // ── 2. 逐图处理（限并发；错误收集不中断）────────────────────────────
  const jobs = await mapLimit(plan.todo, imageConcurrency, async (item) => {
    const t0 = Date.now();
    // 时间预算：已超时 → 直接跳过（占位为空，最终并入 budgetSkipped）
    if (Date.now() - startedAt > timeBudgetMs) {
      budgetSkipped.push(item.rel);
      return null;
    }
    const sha = await hashFile(item.path);
    // 批内去重：同内容第二次出现 → 复用首张结果，不再发请求
    if (sha && seenSha.has(sha)) {
      const firstRel = seenSha.get(sha);
      const entry = {
        rel: item.rel, status: 'done', ms: Date.now() - t0, sha,
        duplicateOf: firstRel, cached: true, outDir: null,
        answer: `（与 \`${firstRel}\` 内容完全相同，已复用其识别结果，未重复请求 API）`
      };
      await appendIndex(batchDir, {
        rel: item.rel, status: 'done', ms: entry.ms, sha, duplicateOf: firstRel, at: new Date().toISOString()
      });
      return entry;
    }
    if (sha) seenSha.set(sha, item.rel);

    const itemDir = join(batchDir, safeItemDirName(item.rel));
    try {
      const outcome = await recognizeOne({
        item, itemDir, strategy, question, cfg, apiKey, signal, fetchImpl, pipelineOverride, ocrOverride
      });
      const entry = {
        rel: item.rel, status: 'done', ms: Date.now() - t0, sha,
        outDir: outcome.outDir ?? itemDir, cached: Boolean(outcome.cached),
        answer: outcome.answer ?? ''
      };
      await appendIndex(batchDir, {
        rel: item.rel, status: 'done', ms: entry.ms, sha, outDir: entry.outDir,
        cached: entry.cached, chars: entry.answer.length, at: new Date().toISOString()
      });
      return entry;
    } catch (error) {
      const msg = String(error?.message ?? error).slice(0, 400);
      const entry = { rel: item.rel, status: 'failed', ms: Date.now() - t0, sha, error: msg };
      await appendIndex(batchDir, { rel: item.rel, status: 'failed', ms: entry.ms, sha, error: msg, at: new Date().toISOString() });
      return entry;
    }
  }, { onError: 'collect' });

  for (const j of jobs) {
    if (!j) continue; // 时间预算跳过的项
    if (j instanceof Error) results.push({ rel: '?', status: 'failed', error: j.message });
    else results.push(j);
  }

  // ── 3. 组装「全部图片的当前状态」（历史索引 + 本次结果）───────────
  const freshIndex = await readIndex(batchDir);
  const resultByRel = new Map(results.map((r) => [r.rel, r]));
  const pendingAll = files.map((f) => {
    const r = resultByRel.get(f.rel);
    const idx = freshIndex.get(f.rel);
    if (r) {
      return {
        rel: f.rel, status: r.status, ms: r.ms, sha: r.sha,
        cached: r.cached, duplicateOf: r.duplicateOf, outDir: r.outDir,
        error: r.error, answer: r.answer
      };
    }
    if (idx?.status === 'done') {
      return { rel: f.rel, status: 'done', ms: idx.ms, sha: idx.sha, outDir: idx.outDir, cached: idx.cached, answer: '' };
    }
    if (idx?.status === 'failed') {
      return { rel: f.rel, status: 'failed', ms: idx.ms, error: idx.error };
    }
    return { rel: f.rel, status: 'pending' };
  });

  // 历史成功项需要能出现在全文报告里 → 从明细目录补读 answer.md
  for (const item of pendingAll) {
    if (item.status === 'done' && !item.answer && item.outDir) {
      item.answer = await readAnswerFile(item.outDir);
    }
  }

  // ── 4. 落盘报告三件套 ─────────────────────────────────────────────
  const cacheHits = results.filter((r) => r.cached).length;
  const duplicates = results.filter((r) => r.duplicateOf).length;
  const reportPaths = await writeReports(batchDir, {
    batchId, inputDir, outDir: batchDir, results, pendingAll,
    meta: {
      model: cfg.model, baseURL: cfg.baseURL, strategy,
      concurrency: imageConcurrency, apiConcurrency: budget.api,
      tier: budget.tier, cores: budget.cores,
      cacheHits, duplicates,
      elapsedMs: Date.now() - startedAt
    }
  });

  const ok = pendingAll.filter((x) => x.status === 'done').length;
  const failed = pendingAll.filter((x) => x.status === 'failed').length;
  const remaining = pendingAll.filter((x) => x.status === 'pending').length;

  return {
    batchId,
    batchDir,
    inputDir,
    total: files.length,
    processed: results.length,
    ok,
    failed,
    remaining,
    skippedByBudget: budgetSkipped,
    cacheHits,
    duplicates,
    elapsedMs: Date.now() - startedAt,
    concurrency: imageConcurrency,
    budget,
    reports: reportPaths,
    items: pendingAll.map((x) => ({
      rel: x.rel, status: x.status, ms: x.ms ?? null, error: x.error ?? null,
      cached: Boolean(x.cached), duplicateOf: x.duplicateOf ?? null
    })),
    answer: pendingAll.filter((x) => x.status === 'done' && x.answer).slice(0, 3)
      .map((x) => `### ${x.rel}\n\n${String(x.answer).slice(0, 800)}`).join('\n\n')
  };
}

/**
 * 识别单张图片（批量内部使用）。策略分派 + 明细落盘。
 *
 * @param {object} p
 * @param {object} p.item - listImages 的一项（含 path/rel/ext）
 * @param {string} p.itemDir - 该图明细目录
 * @param {'pipeline'|'full'} p.strategy
 * @param {string} p.question
 * @param {object} p.cfg
 * @param {string} [p.apiKey]
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.fetchImpl]
 * @param {Function} [p.pipelineOverride]
 * @returns {Promise<{answer:string, outDir:string, cached?:boolean}>}
 */
async function recognizeOne({ item, itemDir, strategy, question, cfg, apiKey, signal, fetchImpl, pipelineOverride, ocrOverride }) {
  await mkdir(itemDir, { recursive: true });
  const src = await openImageSource(item.path, { maxBytes: IMAGE_BYTE_CAP, signal });
  const buf = Buffer.from(src.bytes);

  if (strategy === 'pipeline') {
    const run = typeof pipelineOverride === 'function' ? pipelineOverride : runPipeline;
    const p = await run({
      apiKey,
      apiCfg: cfg.apiCfg, // 端点画像（pipeline 内部的预检/区域识别都按它选画像）
      baseURL: cfg.baseURL,
      model: cfg.model,
      buf,
      ext: src.ext,
      // width/height 传 0：pipeline 会自行探测图片尺寸（v1.0.0 修复：
      // 旧版传 0 会让「相对坐标→像素坐标」被钳成 0，产出的坐标全是错的）
      width: 0,
      height: 0,
      question,
      rotate: 0,
      ocrEngine: cfg.ocrEngine ?? 'auto',
      ocrOverride, // 测试注入：替身 OCR（不传则走真实本地 OCR 降级链）
      preprocess: cfg.preprocess === 'off' ? 'off' : 'auto',
      upgrade: 'default',
      maxTokens: cfg.maxTokens,
      tempDir: itemDir, // 明细直接落盘到本图目录（precheck.json / ocr.txt / answer.md / 区域 PNG）
      signal,
      fetchImpl,
      timeoutMs: cfg.timeoutMs
    });
    // pipeline 已把 answer.md 写进 itemDir；这里再写一份元信息供机器读
    await writeFile(join(itemDir, 'result.json'), JSON.stringify({
      rel: item.rel,
      strategy: 'pipeline',
      hasText: p.hasText,
      textRegions: p.textRegions?.length ?? 0,
      interestRegions: p.interestRegions?.length ?? 0,
      stages: p.stages?.length ?? 0
    }, null, 2), 'utf8');
    return { answer: p.answer ?? '', outDir: p.outputDir ?? itemDir, cached: Number(p.cached) > 0 };
  }

  // ── strategy = 'full'：整图网格切块 → 分层/单请求识别 ──
  const r = await splitImage(buf, src.ext, {
    blockSize: cfg.blockSize ?? 800,
    overlap: cfg.overlap ?? 0,
    threshold: cfg.cutThreshold ?? 800,
    format: cfg.format ?? 'png',
    quality: cfg.quality ?? 90,
    rotate: cfg.rotate ?? 0
  });
  let tiles;
  let grid;
  if (r.splits === false) {
    const mediaType = src.ext === '.jpg' || src.ext === '.jpeg' ? 'image/jpeg' : 'image/png';
    tiles = [{ row: 0, col: 0, x: 0, y: 0, w: r.width, h: r.height, buffer: buf, mediaType }];
    grid = { rows: 1, cols: 1 };
  } else {
    tiles = r.tiles;
    const cols = Math.max(...r.tiles.map((t) => t.col)) + 1;
    const rows = Math.max(...r.tiles.map((t) => t.row)) + 1;
    grid = { rows, cols };
  }
  const result = await recognize({
    apiKey,
    apiCfg: cfg.apiCfg, // 端点画像
    apiConcurrency: cfg.apiConcurrency,
    baseURL: cfg.baseURL,
    model: cfg.model,
    width: r.width,
    height: r.height,
    tiles,
    grid,
    question,
    mode: cfg.mode ?? 'auto',
    groupSize: cfg.groupSize ?? 40,
    maxTokens: cfg.maxTokens,
    json: Boolean(cfg.json),
    signal,
    fetchImpl,
    timeoutMs: cfg.timeoutMs,
    blockSize: cfg.blockSize ?? 800,
    overlap: cfg.overlap ?? 0,
    apiConcurrency: cfg.apiConcurrency
  });
  await writeFile(join(itemDir, 'answer.md'), result.answer ?? '', 'utf8');
  await writeFile(join(itemDir, 'tiles.json'), JSON.stringify({
    rel: item.rel,
    width: r.width,
    height: r.height,
    splits: r.splits !== false,
    tileCount: tiles.length,
    mode: result.mode,
    stages: result.stages?.length ?? 0
  }, null, 2), 'utf8');
  return { answer: result.answer ?? '', outDir: itemDir };
}

/**
 * 读取历史明细目录里的 answer.md（续跑后重建全文报告用）。
 * @param {string} dir - 明细目录
 * @returns {Promise<string>} 文本；读不到返回空串
 */
async function readAnswerFile(dir) {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(join(dir, 'answer.md'), 'utf8');
  } catch {
    return '';
  }
}
