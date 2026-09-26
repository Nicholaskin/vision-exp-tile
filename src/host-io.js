/**
 * host-io.js — vision-exp-tile 文件访问抽象（替代旧 ctx.fs 宿主 API）
 *
 * v0.5.0 生态化改造：标准插件没有 Cordis 的 ctx.fs。本模块提供等价的文件
 * 读取语义，供 src/index.js 的 loadImageAndSplit / loadImageBytes 使用：
 *
 *   - 绝对路径（含 ~ 展开）：node:fs 直读（stat 预检 + cap 校验 + 友好报错）；
 *   - 相对路径：优先委托「执行期标准环境」的 readWorkspaceFile（由 std-facet.js
 *     在执行入口注入标准 ToolExecutionContext；宿主按会话 cwd 解析并打 fs/observed
 *     观察标记，语义与旧 ctx.fs.resolve + emit('fs/observed') 对齐）；
 *     无宿主环境（测试/独立运行）时兜底用 process.cwd() 解析后 node:fs 直读。
 *
 * 本模块只 import node: 内置模块与相对模块。
 *
 * @module vision-exp-tile/host-io
 */

import { resolve as pathResolve, isAbsolute, join, dirname, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { statSync, readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ */
/* 执行期标准环境注入                                                    */
/* ------------------------------------------------------------------ */

/** 当前正在执行的「标准 ToolExecutionContext」（std-facet.js 在执行入口注入/退出时清空）。 */
let activeExecEnv = null;

/**
 * 注入当前工具执行的宿主执行环境（仅 std-facet.js 调用）。
 * @param {object|null} env - 标准 ToolExecutionContext 或 null（执行结束清空）。
 */
export function setActiveExecEnv(env) {
  activeExecEnv = env;
}

/** 读取当前执行环境（内部使用）。 */
function currentExecEnv() {
  return activeExecEnv;
}

/* ------------------------------------------------------------------ */
/* 路径解析与读取                                                        */
/* ------------------------------------------------------------------ */

/**
 * 展开路径中的 ~（用户主目录）。
 * @param {string} p - 原始路径。
 * @returns {string} 展开后的路径。
 */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 读取一张图片的原始字节（替代旧 ctx.fs resolve/stat/readBytes/processPath 组合）。
 *
 * @param {string} filePath - 用户传入的图片路径（绝对或相对）。
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - 字节上限（超出抛错）。
 * @param {AbortSignal} [opts.signal] - 取消信号（node:fs 直读路径不中断，仅保留契约）。
 * @returns {Promise<{bytes:Buffer, ext:string, displayPath:string, hostPath:string, size:number}>}
 *   - bytes：图片字节（Buffer）。
 *   - ext：小写扩展名（含点），如 .png。
 *   - displayPath / hostPath：同一绝对路径（宿主工作区显示路径）；
 *     hostPath 供输出目录定位（源图所在目录）。
 * @throws {Error} 空路径 / 文件不存在 / 非普通文件 / 超过字节上限。
 */
export async function openImageSource(filePath, opts = {}) {
  const signal = opts.signal;
  if (signal?.aborted) throw new Error('已取消');
  const raw = String(filePath ?? '').trim();
  if (raw.length === 0) throw new Error('file_path 必须是非空字符串');
  const ext = extname(raw).toLowerCase();

  // ── 1. 绝对路径（含 ~ 展开）：node:fs 直读 ──────────────────────────
  const absRaw = expandHome(raw);
  if (isAbsolute(absRaw)) {
    return readDirect(absRaw, ext, opts);
  }

  // ── 2. 相对路径：委托标准执行环境（宿主按会话 cwd 解析 + fs/observed）──
  const env = currentExecEnv();
  if (env && typeof env.readWorkspaceFile === 'function') {
    try {
      const cap = opts.maxBytes ?? 0;
      const hostRead = await env.readWorkspaceFile(raw, cap || Number.MAX_SAFE_INTEGER);
      // hostRead = { path: 绝对显示路径, data: Uint8Array, name }
      if (!hostRead || !hostRead.data) throw new Error(`无法读取"${raw}"：文件不存在`);
      const bytes = Buffer.from(hostRead.data);
      if (opts.maxBytes && bytes.byteLength > opts.maxBytes) {
        throw new Error(`"${raw}" 超过 ${opts.maxBytes} 字节上限`);
      }
      const displayPath = hostRead.path || raw;
      return {
        bytes,
        ext: extname(displayPath).toLowerCase() || ext,
        displayPath,
        hostPath: displayPath,
        size: bytes.byteLength
      };
    } catch (error) {
      // 宿主读取失败 → 原样抛（保持友好语义）；不再回退 process.cwd()，避免误读别处同名文件。
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // ── 3. 兜底：相对路径基于进程 cwd 解析后直读（独立运行/测试场景）──────
  return readDirect(pathResolve(process.cwd(), absRaw), ext, opts);
}

/**
 * node:fs 直读一个绝对路径文件（stat 预检 + cap 校验 + 友好报错）。
 * @param {string} absPath - 绝对路径。
 * @param {string} ext - 小写扩展名（含点）。
 * @param {object} opts - 同 openImageSource。
 * @returns {Promise<object>} 同 openImageSource 返回结构。
 */
function readDirect(absPath, ext, opts) {
  let info;
  try {
    info = statSync(absPath);
  } catch {
    throw new Error(`无法读取"${absPath}"：文件不存在`);
  }
  if (!info.isFile()) throw new Error(`无法读取"${absPath}"：不是普通文件`);
  if (opts.maxBytes && info.size > opts.maxBytes) {
    throw new Error(`"${absPath}" 大小 ${info.size} 超过 ${opts.maxBytes} 字节上限`);
  }
  const bytes = readFileSync(absPath);
  return {
    bytes,
    ext: extname(absPath).toLowerCase() || ext,
    displayPath: absPath,
    hostPath: absPath,
    size: info.size
  };
}

/* ------------------------------------------------------------------ */
/* 输出目录语义（v0.5.0：相对 out_dir 基于源图所在目录）                  */
/* ------------------------------------------------------------------ */

/**
 * 解析相对输出目录的基准目录：
 *  v0.4.x 用「会话 cwd」（exec.agent.session.header.cwd——标准协议不提供）；
 *  v0.5.0 改为「源图所在目录」（dirname(hostPath)），更符合直觉且跨宿主稳定。
 * @param {string} hostPath - 源图绝对路径（openImageSource 的 hostPath）。
 * @returns {string} 基准目录绝对路径。
 */
export function outDirBase(hostPath) {
  return dirname(hostPath);
}

/**
 * 路径小工具转出（供 index.js 的 basename 使用保持一致）。
 */
export { basename, dirname, extname, join as pathJoin, pathResolve };
