/**
 * result-cache.js — 视觉 API 结果缓存（内容哈希 + 参数指纹）
 *
 * v1.0.0 新增（性能大改造 P2）。与既有的 OCR 文本缓存（ocr-local.js 的
 * `~/.vision-exp-tile-ocr-cache`，键 = PNG 字节哈希）区别：
 *   - 本缓存缓存的是**视觉 API 的返回文本**（预检 JSON / 区域描述 / 整图识别答案），
 *     即「花了钱的那一步」；批量重跑同一目录时可直接命中，省时省钱。
 *   - 键 = sha256(图片字节) + **参数指纹**（model / base_url / 切块参数 / 提示词版本…），
 *     避免「换了模型或提示词却命中旧答案」这类静默错误。
 *
 * 目录：`~/.vision-exp-tile-result-cache/`（env `DSH_RESULT_CACHE_DIR` 覆盖）
 * 开关：`DSH_RESULT_CACHE=0` 禁用（默认启用）
 * TTL ：`DSH_RESULT_CACHE_TTL_HOURS`（默认 168 小时 = 7 天；**≤0 = 永不过期**）
 * 上限：`DSH_RESULT_CACHE_MAX_MB`（默认 512MB，超出后按写入时间从旧到新清理）
 *
 * 纪律（写在代码里，防止后来人踩）：
 *   1. **只缓存成功结果**——错误/空结果绝不入缓存（否则错误被固化，且用户"重试"永远无效）；
 *   2. **写入原子化**（临时文件 + rename），断电/中断不会留下半截 JSON；
 *   3. **读失败一律当 miss**（损坏条目顺手删除），缓存永不阻断主流程；
 *   4. 缓存键里必须带 `PROMPT_VERSION`——提示词一改，旧答案立即失效。
 *
 * @module vision-exp-tile/result-cache
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 提示词/编排版本号：**修改 prompts.js 或识别编排语义时必须 +1**，
 * 否则旧缓存会在语义不兼容的情况下被命中。
 */
export const PROMPT_VERSION = 1;

/** 缓存目录（env 覆盖 > $HOME/.vision-exp-tile-result-cache） */
export function resultCacheDir() {
  return process.env.DSH_RESULT_CACHE_DIR ?? join(homedir(), '.vision-exp-tile-result-cache');
}

/** 缓存是否启用（DSH_RESULT_CACHE=0 → 禁用） */
export function resultCacheEnabled() {
  return String(process.env.DSH_RESULT_CACHE ?? '1').trim() !== '0';
}

/** 缓存 TTL（毫秒；**≤0 或非法 = 永不过期**，与「上限 0 = 不限制」语义一致） */
export function resultCacheTtlMs() {
  const h = Number(process.env.DSH_RESULT_CACHE_TTL_HOURS ?? 168);
  const hours = Number.isFinite(h) && h > 0 ? h : 0;
  return hours * 3600 * 1000;
}

/** 缓存体积上限（字节；默认 512MB，0 = 不限制） */
export function resultCacheMaxBytes() {
  const mb = Number(process.env.DSH_RESULT_CACHE_MAX_MB ?? 512);
  const v = Number.isFinite(mb) && mb > 0 ? mb : 0;
  return v * 1024 * 1024;
}

/**
 * 图片字节哈希（sha256 前 32 hex，与 OCR 缓存同口径便于人工比对）。
 * @param {Buffer|Uint8Array} buffer - 图片字节
 * @returns {string} 32 位十六进制串
 */
export function hashBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

/**
 * 参数指纹：把影响结果的参数按**固定键序**序列化后哈希。
 * 键序固定是关键——否则同样的参数换个书写顺序就会 miss。
 * @param {object} params - 影响结果的参数（model/baseURL/blockSize/…）
 * @returns {string} 16 位十六进制指纹
 */
export function fingerprint(params = {}) {
  const keys = Object.keys(params).sort();
  const parts = keys.map((k) => `${k}=${String(params[k])}`);
  parts.push(`promptVersion=${PROMPT_VERSION}`);
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 16);
}

/**
 * 组装缓存键：`<图片哈希>-<参数指纹>`（含子目录分片，避免单目录文件过多）。
 * @param {Buffer|Uint8Array} buffer - 图片字节
 * @param {object} params - 参数指纹来源
 * @returns {string} 缓存键（形如 `ab12…-9f8e…`）
 */
export function resultCacheKey(buffer, params = {}) {
  return `${hashBytes(buffer)}-${fingerprint(params)}`;
}

/**
 * 缓存文件路径：键的前两位作为子目录（分片）。
 * @param {string} key - resultCacheKey() 的返回值
 * @returns {string} 绝对路径
 */
export function resultCachePath(key) {
  return join(resultCacheDir(), key.slice(0, 2), `${key}.json`);
}

/**
 * 读取缓存。
 * @param {string} key - 缓存键
 * @returns {Promise<{value:any, ts:number, cached:true}|null>} 命中返回条目，否则 null
 */
export async function resultCacheGet(key) {
  if (!resultCacheEnabled() || !key) return null;
  const file = resultCachePath(key);
  try {
    if (!existsSync(file)) return null;
    const entry = JSON.parse(await readFile(file, 'utf8'));
    if (!entry || typeof entry !== 'object' || !('value' in entry)) return null;
    const ttl = resultCacheTtlMs();
    if (ttl > 0 && Date.now() - Number(entry.ts ?? 0) > ttl) return null; // 过期：当 miss（不删，交给 prune）
    return { value: entry.value, ts: Number(entry.ts ?? 0), cached: true };
  } catch {
    // 损坏条目：顺手删除，避免每次读都失败
    try { await unlink(file); } catch { /* 删不掉也无妨 */ }
    return null;
  }
}

/**
 * 写入缓存（原子写：临时文件 + rename；失败静默，缓存绝不阻断主流程）。
 * @param {string} key - 缓存键
 * @param {any} value - 结果值（必须可 JSON 序列化；失败则跳过不写）
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function resultCacheSet(key, value) {
  if (!resultCacheEnabled() || !key) return false;
  const file = resultCachePath(key);
  let payload;
  try {
    payload = JSON.stringify({ ts: Date.now(), promptVersion: PROMPT_VERSION, value });
  } catch {
    return false; // 值不可序列化（如含函数/Buffer 环）→ 放弃缓存而不是抛错
  }
  try {
    await mkdir(join(resultCacheDir(), key.slice(0, 2)), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, file); // 同目录 rename：原子替换
    return true;
  } catch {
    return false;
  }
}

/**
 * 统计缓存占用与条目数。
 * @returns {Promise<{dir:string, files:number, bytes:number, oldest:number|null, newest:number|null}>}
 */
export async function resultCacheStat() {
  const dir = resultCacheDir();
  const out = { dir, files: 0, bytes: 0, oldest: null, newest: null };
  if (!existsSync(dir)) return out;
  try {
    for (const shard of await readdir(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(dir, shard.name);
      for (const f of await readdir(shardDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        try {
          const st = await stat(join(shardDir, f.name));
          out.files += 1;
          out.bytes += st.size;
          const t = st.mtimeMs;
          if (out.oldest === null || t < out.oldest) out.oldest = t;
          if (out.newest === null || t > out.newest) out.newest = t;
        } catch { /* 单文件失败跳过 */ }
      }
    }
  } catch { /* 目录不可读 → 返回已知部分 */ }
  return out;
}

/**
 * 清理缓存：
 *  - 过期条目（TTL 之外）一律删除；
 *  - 仍超过体积上限时，按 mtime 从旧到新继续删除，直到降到上限的 90% 以下。
 * @returns {Promise<{removed:number, freedBytes:number, kept:number, bytes:number}>}
 */
export async function resultCachePrune() {
  const dir = resultCacheDir();
  const res = { removed: 0, freedBytes: 0, kept: 0, bytes: 0 };
  if (!existsSync(dir)) return res;
  const ttl = resultCacheTtlMs();
  const maxBytes = resultCacheMaxBytes();
  /** @type {Array<{path:string,size:number,mtime:number}>} */
  const entries = [];
  try {
    for (const shard of await readdir(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(dir, shard.name);
      for (const f of await readdir(shardDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        const p = join(shardDir, f.name);
        try {
          const st = await stat(p);
          entries.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch { /* 跳过 */ }
      }
    }
  } catch {
    return res;
  }
  const now = Date.now();
  const doomed = new Set();
  let total = 0;
  for (const e of entries) {
    total += e.size;
    if (ttl > 0 && now - e.mtime > ttl) doomed.add(e.path);
  }
  // 过期清理后的剩余体积仍超限 → 从旧到新继续删
  let remaining = entries.filter((e) => !doomed.has(e.path)).reduce((a, e) => a + e.size, 0);
  if (maxBytes > 0 && remaining > maxBytes) {
    const target = maxBytes * 0.9;
    for (const e of entries.filter((x) => !doomed.has(x.path)).sort((a, b) => a.mtime - b.mtime)) {
      if (remaining <= target) break;
      doomed.add(e.path);
      remaining -= e.size;
    }
  }
  for (const e of entries) {
    if (!doomed.has(e.path)) { res.kept += 1; res.bytes += e.size; continue; }
    try {
      await unlink(e.path);
      res.removed += 1;
      res.freedBytes += e.size;
      total -= e.size;
    } catch { /* 删不掉：计为保留 */ res.kept += 1; res.bytes += e.size; }
  }
  return res;
}

/**
 * 清空缓存（删除全部条目，保留目录本身）。
 * @returns {Promise<{removed:number}>}
 */
export async function resultCacheClear() {
  const r = await resultCachePrune();
  // prune 只删过期/超限部分；clear 需要全删，这里直接遍历删除
  let removed = r.removed;
  const dir = resultCacheDir();
  if (!existsSync(dir)) return { removed };
  try {
    for (const shard of await readdir(dir, { withFileTypes: true })) {
      if (!shard.isDirectory()) continue;
      const shardDir = join(dir, shard.name);
      for (const f of await readdir(shardDir, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.json')) continue;
        try { await unlink(join(shardDir, f.name)); removed += 1; } catch { /* 跳过 */ }
      }
    }
  } catch { /* 忽略 */ }
  return { removed };
}
