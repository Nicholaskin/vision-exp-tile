/**
 * temp-cleanup.js — 过期临时文件清理（轻量，无第三方依赖）
 *
 * 只处理插件自己在系统临时目录产生的两类产物：
 *   - 目录：vision-tile-pipeline-*
 *   - 文件：region-*.png、vision-tile-ocr-*.png
 * 默认只删除 mtime 早于 now - ttlMs（默认 24 小时）的项；
 * 绝不删除用户显式指定的 out_dir（可经 opts.excludePaths 排除）。
 */

import { readdir, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const PIPELINE_DIR_PREFIX = 'vision-tile-pipeline-';
const REGION_FILE_RE = /^region-.*\.png$/;
const OCR_FILE_RE = /^vision-tile-ocr-.*\.png$/;

/**
 * 清理过期的插件临时产物。
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=24h] 过期阈值（毫秒）。
 * @param {number} [opts.now=Date.now()] 当前时间（毫秒，可注入便于测试）。
 * @param {string} [opts.tmpRoot=tmpdir()] 扫描根目录（默认系统临时目录）。
 * @param {string[]} [opts.excludePaths=[]] 需要绝对排除的目录/文件路径。
 * @param {boolean} [opts.force=true] 删除时 force。
 * @returns {Promise<void>} 静默：任何失败都不抛出。
 */
export async function cleanupOldTempArtifacts(opts = {}) {
  const {
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now(),
    tmpRoot = tmpdir(),
    excludePaths = [],
    force = true
  } = opts;

  const cutoff = now - ttlMs;
  const exclusions = Array.isArray(excludePaths)
    ? excludePaths.map((p) => resolve(String(p))).filter(Boolean)
    : [];

  try {
    const entries = await readdir(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      let matched = false;
      if (entry.isDirectory()) {
        matched = entry.name.startsWith(PIPELINE_DIR_PREFIX);
      } else if (entry.isFile()) {
        matched = REGION_FILE_RE.test(entry.name) || OCR_FILE_RE.test(entry.name);
      }
      if (!matched) continue;

      const full = resolve(join(tmpRoot, entry.name));
      if (exclusions.some((ex) => full === ex || full.startsWith(ex + '/') || full.startsWith(ex + '\\'))) {
        continue;
      }

      try {
        const st = await stat(full);
        if (st.mtimeMs < cutoff) {
          await rm(full, { recursive: true, force });
        }
      } catch {
        // 单个项失败不影响其它清理
      }
    }
  } catch {
    // 扫描失败（如目录不可读）静默忽略
  }
}
