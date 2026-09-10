/**
 * index.js — vision-exp-tile 插件入口
 *
 * 为视觉模型 deepseek-v4-flash-vision-exp 定制的大图分块识别插件。
 * 注册两个模型工具：
 *   - vision_tile_split     纯切图 + 坐标标注 + 分块聚合逻辑输出（不调用视觉 API）
 *   - vision_tile_recognize 切图后直连 DeepSeek 视觉 API 识别并聚合，输出结构化答案（不代为统计/不显示 token 与费用，实际计费以 DeepSeek 官方 API 平台账单为准）
 *
 * 形态：裸工具对象 + ctx.tools.register（不引入 defineTool，保持与官方工具一致的注册方式）。
 * 不引入新依赖，仅使用 node:path / node:fs/promises 与既有 src 模块。
 *
 * v0.3.0：新增「图像识别」设置命名空间（NS='vision-exp-tile'），在 DSH Web 设置页
 * 注册配置分区，配置以 settings.yaml 持久化、运行时热生效；工具执行时经
 * getRuntimeConfig() 惰性读最新设置（优先级：工具参数 > 设置页 > 默认值），
 * OCR 引擎/池等参数经 applySettingsEnv() 写入 process.env 于下次工具调用生效。
 *
 * @module vision-exp-tile
 */

import { extname, join, dirname, basename, resolve as pathResolve } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { splitImage, tileFileName, cropRegion, normalizeRect } from './tile-engine.js';
import { buildSplitResultText } from './prompts.js';
import { recognize, previewImage, recognizeRegion } from './vision-client.js';
import { runPipeline } from './pipeline.js';
import { cleanupOldTempArtifacts } from './temp-cleanup.js';
import { NS, normalizeConfig } from './config.js';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { SettingsSchema, toSettingsBase } from './settings-schema.js';
import { setRuntimeSource, getRuntimeConfig, applySettingsEnv, normalizeFromSettings } from './runtime.js';
import { probeDevice, deviceProfileText } from './device.js';
import { isPicturereaderPresent, withCollabIfPresent } from './picturereader-detector.js';
import { readPeerSettings, applyPeerDefaults } from './peer-config.js';

/** 插件名（供 DSH 加载器识别）。 */
export const name = 'vision-exp-tile';

/** 运行时需要的服务注入。 */
export const inject = ['tools', 'fs'];

/** 单张图片文件读取字节上限（512 MiB，大图足够）。 */
const IMAGE_BYTE_CAP = 512 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 通用小工具函数                                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验并读取一个必为整数且在 [min,max] 范围内的参数；非法即抛带工具名前缀的中文错误。
 * @param {unknown} raw - 参数原始值（可为 undefined）。
 * @param {number} fallback - 默认值（raw 为 undefined 时使用）。
 * @param {number} min - 最小允许值（含端点）。
 * @param {number} max - 最大允许值（含端点）。
 * @param {string} label - 参数显示名（如 block_size）。
 * @param {string} tool - 工具名（用于报错前缀）。
 * @returns {number} 通过校验的整数。
 */
function readInt(raw, fallback, min, max, label, tool) {
  const v = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${tool}: ${label} 必须是 ${min}~${max} 的整数（实际：${raw === undefined ? `默认 ${fallback}` : String(raw)}）`);
  }
  return v;
}

/**
 * 读取并校验一个布尔参数（支持 true/false 字符串或布尔）。
 * @param {unknown} raw - 参数原始值。
 * @param {boolean} fallback - 默认值。
 * @param {string} label - 参数显示名。
 * @param {string} tool - 工具名。
 * @returns {boolean} 布尔值。
 */
function readBool(raw, fallback, label, tool) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  throw new Error(`${tool}: ${label} 仅接受 true/false`);
}

/**
 * 调试日志（仅在运行时配置 debug=true 时输出；默认关闭，不影响正常行为）。
 * @param {object} ctx - Cordis 上下文（提供 ctx.logger）。
 * @param {string} message - 日志内容。
 */
function debugLog(ctx, message) {
  try {
    ctx.logger?.info?.(`[vision-exp-tile] ${message}`);
  } catch {
    // 日志失败不影响功能。
  }
}

/**
 * 根据扩展名推断图片 MIME 类型（与官方视觉 API 支持的格式集一致）。
 * @param {string} ext - 小写扩展名（含点，如 .png）。
 * @returns {string|null} image/png / image/jpeg / image/webp / image/gif，或 null（不支持）。
 */
function mediaTypeForExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return null;
}

/**
 * 解析 DeepSeek API key，按「环境变量优先、本机凭据文件兜底」的顺序取值。
 *
 * 背景：插件此前只在 process.env[cfg.apiKeyEnv] 读 key；若 DSH 服务进程被宿主的
 * 环境剥离了该变量（例如由 systemd / 服务管理器启动、或凭据未注入进程环境），
 * 工具会误报「未找到 API key」。本机通常会把凭据写入 ~/.dsh/.credentials.yaml，
 * 形如：
 *   DEEPSEEK_API_KEY: <your-api-key>
 *   或带引号：DEEPSEEK_API_KEY: "<your-api-key>"
 * 该文件由用户的 dsh 配置/凭据管理维护，作为可读的环境变量兜底来源。
 *
 * 取值顺序：
 *   1) 环境变量 process.env[cfg.apiKeyEnv]（最权威，判空后直接返回）；
 *   2) 解析 ~/.dsh/.credentials.yaml 中与 cfg.apiKeyEnv 同名的那一行
 *      （用行级正则 `^\\s*<key>\\s*:\\s*["']?([^"'\\s]+)` 提取值）；
 *   3) 文件不存在 / 读取失败 / 未匹配 → 返回 undefined，交由调用方抛「未找到 key」。
 *
 * @param {object} cfg - 归一化后的配置（需含 apiKeyEnv）。
 * @returns {Promise<string|undefined>} 解析到的 API key；环境变量与凭据文件均无时返回 undefined。
 */
async function resolveApiKey(cfg) {
  const keyEnv = cfg.apiKeyEnv;

  // 1. 环境变量优先；非空trim 值即视为有效。
  const envKey = process.env[keyEnv];
  if (envKey && envKey.trim().length > 0) return envKey.trim();

  // 2. 兜底：读取本机凭据文件，用行级正则匹配同名 key 行。
  try {
    const credFile = join(homedir(), '.dsh', '.credentials.yaml');
    const text = await readFile(credFile, 'utf8');
    // 对 keyEnv 做正则转义，避免特殊字符破坏匹配（环境变量名通常为 [A-Za-z_][A-Za-z0-9_]*）。
    const esc = keyEnv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 行级匹配：行首允许缩进，键=值，值可带单/双引号，捕获非引号/非空白字符作为真实值。
    const matcher = new RegExp(`^\\s*${esc}\\s*:\\s*["']?([^"'\\s]+)`, 'm');
    const m = text.match(matcher);
    return m ? m[1] : undefined;
  } catch {
    // 文件不存在、权限/解析异常等：无法兜底，返回 undefined。
    return undefined;
  }
}

/**
 * 从 tile 数组推导网格行列数（行优先网格，tile 自带 row/col）。
 * @param {Array<{row:number,col:number}>} tiles - 切块数组。
 * @returns {{rows:number, cols:number}} 网格行列。
 */
function calcRowsCols(tiles) {
  let rows = 0;
  let cols = 0;
  for (const t of tiles) {
    if (t.row + 1 > rows) rows = t.row + 1;
    if (t.col + 1 > cols) cols = t.col + 1;
  }
  return { rows, cols };
}

/**
 * 将预检返回的相对矩形（0..1）换算为原图像素矩形（供回写/展示）。
 * @param {{x0:number,y0:number,x1:number,y1:number}} r - 相对坐标矩形
 * @param {number} width - 原图宽
 * @param {number} height - 原图高
 * @returns {{x0:number,y0:number,x1:number,y1:number,w:number,h:number}}
 */
function pixelRect(r, width, height) {
  return normalizeRect([r.x0, r.y0, r.x1, r.y1], width, height);
}

/**
 * 读取并校验切分相关参数（block_size / overlap / cut_threshold / format / quality / rotate）。
 * 参数缺省时回退到配置默认值（cfg），并做与 config.js 相同的区间校验。
 * @param {object} args - 工具参数对象。
 * @param {object} cfg - 归一化后的配置。
 * @param {string} tool - 工具名。
 * @returns {{blockSize:number, overlap:number, cutThreshold:number, format:string, quality:number, rotate:number}}
 */
function readSplitParams(args, cfg, tool) {
  // 先确定 blockSize，因为 overlap 上限依赖它。
  const blockSize = readInt(args.block_size, cfg.blockSize, 64, 4096, 'block_size', tool);
  const overlapMax = Math.floor(blockSize / 2) - 1;
  const overlap = readInt(args.overlap, cfg.overlap, 0, overlapMax, 'overlap', tool);
  const cutThreshold = readInt(args.cut_threshold, cfg.cutThreshold, 64, 8192, 'cut_threshold', tool);
  const formatRaw = args.format === undefined ? cfg.format : String(args.format);
  if (formatRaw !== 'png' && formatRaw !== 'jpeg') {
    throw new Error(`${tool}: format 仅支持 png 或 jpeg`);
  }
  const quality = readInt(args.quality, cfg.quality, 40, 100, 'quality', tool);
  // rotate：识别前旋转角度（0/90/180/270，顺时针），用于"误判方向"场景。
  const rotateRaw = args.rotate === undefined ? cfg.rotate : Number(args.rotate);
  if (![0, 90, 180, 270].includes(rotateRaw)) {
    throw new Error(`${tool}: rotate 仅支持 0/90/180/270 度（实际：${String(args.rotate ?? cfg.rotate)}）`);
  }
  return { blockSize, overlap, cutThreshold, format: formatRaw, quality, rotate: rotateRaw };
}

/**
 * 解析输出目录：
 *  - 非空 out_dir（显式）：相对路径基于 cwd 解析，绝对路径原样使用；
 *  - 否则：原图同目录下 `<原图名>_tiles` 子目录。
 * @param {unknown} rawOutDir - 参数 out_dir。
 * @param {string|undefined} cwd - 会话工作目录。
 * @param {string} hostPath - 原图宿主绝对路径（processPath 结果）。
 * @param {string} base - 原图文件名（不含扩展名）。
 * @returns {string} 输出目录绝对路径。
 */
function resolveOutDir(rawOutDir, cwd, hostPath, base) {
  const p = String(rawOutDir ?? '').trim();
  if (p.length > 0) {
    return pathResolve(cwd ?? process.cwd(), p);
  }
  return join(dirname(hostPath), `${base}_tiles`);
}

/**
 * 落盘切块与 overview 缩略图，并生成块清单。
 * @param {string} outDir - 输出目录。
 * @param {string} base - 原图文件名（不含扩展名）。
 * @param {string} format - 块格式（png/jpeg）。
 * @param {object} r - splitImage 结果（含 tiles / overview）。
 * @param {boolean} withOverview - 是否生成 overview。
 * @returns {Promise<{rows:number, cols:number, list:Array<{id,row,col,x,y,w,h,file,bytes}>, overviewPath?:string}>}
 */
async function writeTilesAndOverview(outDir, base, format, r, withOverview) {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  await mkdir(outDir, { recursive: true });
  const { rows, cols } = calcRowsCols(r.tiles);

  // 先写 overview（网格 + 块号缩略图），供模型建立全局布局。
  let overviewPath;
  if (withOverview && r.overview) {
    overviewPath = join(outDir, `${base}_overview.png`);
    await writeFile(overviewPath, r.overview);
  }

  // 逐块写盘，并生成带坐标/文件路径的清单。
  const list = [];
  for (const t of r.tiles) {
    const file = join(outDir, tileFileName(base, t, ext));
    await writeFile(file, t.buffer);
    list.push({
      id: t.row * cols + t.col, // 行优先编号（从 0 开始）
      row: t.row,
      col: t.col,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      file,
      bytes: t.buffer.byteLength
    });
  }
  return { rows, cols, list, ...(overviewPath !== undefined ? { overviewPath } : {}) };
}

/**
 * 读取目标图片文件并完成切分（两个工具共用的前置流程）。
 * 负责：路径解析、按 cwd 定位、stat 校验、读取字节、调用 splitImage、计算宿主路径与原图 base 名。
 * @param {object} ctx - Cordis 上下文（提供 ctx.fs）。
 * @param {object} exec - 工具执行上下文（提供 exec.signal / exec.agent）。
 * @param {object} args - 工具参数。
 * @param {object} cfg - 归一化后的配置。
 * @param {string} tool - 工具名。
 * @returns {Promise<object>} 包含 filePath/ext/target/hostPath/base/width/height/r/切分参数/cwd/bytes。
 */
async function loadImageAndSplit(ctx, exec, args, cfg, tool) {
  // 1. 路径参数。
  const filePath = String(args.file_path ?? '').trim();
  if (filePath.length === 0) throw new Error(`${tool}: file_path 必须是非空字符串`);
  const ext = extname(filePath).toLowerCase();

  // 2. 用 ctx.fs 解析目标（相对路径基于会话 cwd），并校验存在性/类型。
  const cwd = exec.agent?.session?.header?.cwd;
  const target = await ctx.fs.resolve(filePath, {
    ...(cwd !== undefined ? { cwd } : {}),
    signal: exec.signal
  });
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info) throw new Error(`${tool}: 无法读取"${target.displayPath}"：文件不存在`);
  if (info.type !== 'file') throw new Error(`${tool}: 无法读取"${target.displayPath}"：不是普通文件`);

  // 3. 读取原始字节（512 MiB 上限）。
  const bytes = await ctx.fs.readBytes(target, exec.signal, IMAGE_BYTE_CAP);
  // 标记源文件已被观察（供文件观察策略追踪；失败不影响功能）。
  try {
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
  } catch {}

  // 4. 读切分参数并执行切图。
  const params = readSplitParams(args, cfg, tool);
  let r;
  try {
    r = await splitImage(Buffer.from(bytes), ext, {
      blockSize: params.blockSize,
      overlap: params.overlap,
      threshold: params.cutThreshold,
      format: params.format,
      quality: params.quality,
      rotate: params.rotate
    });
  } catch (err) {
    const msg = String(err?.message ?? err);
    // —— 损坏图/不支持的格式（如 HEIC/AVIF/CMYK 异常）友好提示（不裸抛栈）——
    if (/unsupported|not supported|unknown format|decode|libheif|heif|avif/i.test(msg) || /\.(heic|heif|avif)$/i.test(ext)) {
      throw new Error(`${tool}: 图片格式 ${ext || '未知'} 可能不受支持或文件损坏（常见：HEIC/AVIF 需先转 PNG/JPEG；CMYK 或损坏文件需先转图）。原始错误：${msg.slice(0, 140)}`);
    }
    throw err;
  }

  // 5. 宿主可用绝对路径（用于定位输出目录）与原图文件名（不含扩展名）。
  const hostPath = ctx.fs.processPath(target);
  const base = basename(hostPath, extname(hostPath));

  return {
    filePath,
    ext,
    target,
    hostPath,
    base,
    cwd,
    width: r.width,
    height: r.height,
    r,
    bytes,
    blockSize: params.blockSize,
    overlap: params.overlap,
    cutThreshold: params.cutThreshold,
    format: params.format,
    quality: params.quality,
    rotate: params.rotate
  };
}

/* ------------------------------------------------------------------ */
/* 工具 1：vision_tile_split                                            */
/* ------------------------------------------------------------------ */

/**
 * 构建 vision_tile_split 工具：纯切图 + 坐标标注 + 聚合逻辑输出，不调用视觉 API。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 归一化后的配置。
 */
export function createSplitTool(ctx, cfg) {
  const tool = 'vision_tile_split';
  return {
    name: tool,
    description: [
      '把一张大图按正方形网格切成 800×800 无损小块（官方缩放甜蜜点），并为每块标注原图坐标，输出分块聚合逻辑。',
      '参数：file_path（必填，图片路径）；block_size（integer，默认 800，块边长，官方缩放甜蜜点为 800）；cut_threshold（integer，默认 800，长边超过此值才切分，800×800 及以下不切）；overlap（integer，默认 0，相邻块交叠像素，推荐 64 防跨块切断）；out_dir（string，可选，块输出目录，默认原图同目录下 <原名>_tiles）；format（enum[png,jpeg]，默认 png，png 无损保真、jpeg 更省请求体）；quality（integer 40..100，默认 90，仅 jpeg 有效）。',
      '返回切块清单（每块含 id/行列/原图坐标/绝对文件路径/字节数）、网格行列、输出目录、引擎与可选的 overview 缩略图路径。',
      '本工具不调用视觉 API，只负责切分与标注；继续识别请用 vision_tile_recognize。'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: '待切分图片的路径（由文件系统后端解析）。' },
        block_size: { type: 'integer', description: '块边长，官方缩放甜蜜点为 800（64..4096）。默认 800。' },
        cut_threshold: { type: 'integer', description: '长边超过此值才切分；800×800 及以下不切（64..8192）。默认 800。' },
        overlap: { type: 'integer', description: '相邻块交叠像素，推荐 64 防跨块切断（0..块边长/2-1）。默认 0。' },
        out_dir: { type: 'string', description: '块输出目录；默认原图同目录下 <原名>_tiles。' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'png 无损保真；jpeg 更省请求体。默认 png。' },
        quality: { type: 'integer', description: 'jpeg 质量（40..100）；仅 jpeg 有效。默认 90。' },
        rotate: { type: 'integer', enum: [0, 90, 180, 270], description: '识别前顺时针旋转角度（0/90/180/270）。图片横倒/倒置导致"误判方向"时使用，默认 0。' }
      },
      required: ['file_path']
    },
    output: {
      // 注意：splits=false 时 t/rows/cols/outDir/engine 均缺失，因此 required 只保留必定存在的字段。
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          splits: { type: 'boolean' },
          reason: { type: 'string' },
          tiles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'integer' },
                row: { type: 'integer' },
                col: { type: 'integer' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                w: { type: 'integer' },
                h: { type: 'integer' },
                file: { type: 'string' },
                bytes: { type: 'integer' }
              },
              required: ['id', 'row', 'col', 'x', 'y', 'w', 'h', 'file', 'bytes']
            }
          },
          rows: { type: 'integer' },
          cols: { type: 'integer' },
          outDir: { type: 'string' },
          engine: { type: 'string' },
          overviewPath: { type: 'string' }
        },
        required: ['path', 'width', 'height', 'splits']
      },
      // 把切分结果渲染成模型可读的文本（坐标清单 + 聚合逻辑）。
      render: (args, value) => {
        if (value.splits === false) {
          return [{ type: 'text', text: `# 无需切分\n${value.reason}\n原图：${value.path}（${value.width}×${value.height}px）` }];
        }
        const text = buildSplitResultText({
          filePath: value.path,
          outDir: value.outDir,
          width: value.width,
          height: value.height,
          tiles: value.tiles,
          grid: { rows: value.rows, cols: value.cols },
          blockSize: args.block_size === undefined ? cfg.blockSize : Number(args.block_size),
          overlap: args.overlap === undefined ? cfg.overlap : Number(args.overlap),
          ...(value.overviewPath !== undefined ? { overviewPath: value.overviewPath } : {})
        });
        return [{ type: 'text', text }];
      }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${String(args.file_path ?? '')}`,
      kind: 'read',
      locations: [{ path: String(args.file_path ?? '') }]
    }),
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error(`${tool}: 已取消`);
      if (cfg.debug) debugLog(ctx, `${tool} 开始切图：block_size=${cfg.blockSize} overlap=${cfg.overlap} cut_threshold=${cfg.cutThreshold}`);
      const img = await loadImageAndSplit(ctx, exec, args, cfg, tool);
      const { r } = img;

      // 无需切分：长边未超过 cutThreshold，原图将原样识别；不写任何文件。
      if (r.splits === false) {
        return {
          splits: false,
          width: img.width,
          height: img.height,
          path: img.target.displayPath,
          reason: '长边不超过阈值，无需切分；原图将原样识别'
        };
      }

      // 计算输出目录并落盘切块 + overview。
      const outDir = resolveOutDir(args.out_dir, img.cwd, img.hostPath, img.base);
      const written = await writeTilesAndOverview(outDir, img.base, img.format, r, cfg.withOverview);
      const result = {
        path: img.target.displayPath,
        width: img.width,
        height: img.height,
        splits: true,
        tiles: written.list,
        rows: written.rows,
        cols: written.cols,
        outDir,
        engine: r.engine,
        ...(written.overviewPath !== undefined ? { overviewPath: written.overviewPath } : {})
      };
      return result;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 工具 2：vision_tile_recognize                                        */
/* ------------------------------------------------------------------ */

/**
 * 构建 vision_tile_recognize 工具：切图后直连 DeepSeek 视觉 API 识别并聚合（不代为统计/不显示 token 与费用，实际计费以 DeepSeek 官方 API 平台账单为准）。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} cfg - 归一化后的配置。
 */
export function createRecognizeTool(ctx, cfg) {
  const tool = 'vision_tile_recognize';
  return {
    name: tool,
    description: [
      '智能识图（deepseek-v4-flash-vision-exp）：先整图预检 → 按需本地 OCR + 重点区域按比例切块识别 → 汇总。',
      '参数：file_path（必填）；strategy（enum[smart/pipeline/full]，默认 smart）：smart=模型编排（预检后由模型决定后续，可先问用户）；pipeline=插件全自动（预检→本地OCR→兴趣点识别→汇总一次完成，无交互）；full=原全图网格切块识别（先 overview 缩略图再切块，用于整页材料逐块转录）。',
      '通用参数：question（string，默认“完整识别大图内容”；可描述重点区域让模型优先）；rotate（0/90/180/270，默认 0，图片横倒/倒置时使用）；max_tokens（默认 8192）；json（仅 full 模式有效）。',
      'pipeline 模式追加：ocr_engine（auto/paddle/rapid/windows，默认 auto=优先 rapid 自动降级）；interest_concurrency（兴趣点 API 并行数 1..4，默认 2）；preprocess（auto/off，默认 auto=深底自动反色/低对比二值化/手写放大）；upgrade（full/low/off，默认 full=低置信或手写或深底失败时自动升级视觉 API 转录）；block_size/cut_threshold/overlap/group_size/format/quality/out_dir/with_overview 仅 full 模式有效。',
      'smart 模式流程（请模型按此执行）：1) 本工具先返回预检结果（有无文字、文字区域、兴趣点区域、整图概要）；2) 若重点内容不明确，先向用户提问；3) 文字区域→vision_region_crop(recognize=true) 视觉直读转录（本插件自带能力，跨环境可用）；4) 兴趣点→vision_region_crop(recognize=true) 逐点识别；5) 汇总成完整答案。',
      '读取 API key：从环境变量（默认 DEEPSEEK_API_KEY）读取；未配置会给出明确提示。',
      '返回：预检清单/整体答案 + 统计（模式、区域数、请求数）。不代为统计/不显示 token 与费用（实际计费以 DeepSeek 官方账单为准）。'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: '待识别图片的路径（由文件系统后端解析）。' },
        strategy: { type: 'string', enum: ['smart', 'pipeline', 'full'], description: 'smart=模型编排（默认）；pipeline=插件全自动；full=原全图网格切块。' },
        question: { type: 'string', description: '描述你想从图中知道的；空=完整识别大图内容。也可指明重点位置（如"左上角表格"）。' },
        rotate: { type: 'integer', enum: [0, 90, 180, 270], description: '识别前顺时针旋转角度（0/90/180/270）。图片横倒/倒置时使用，默认 0。' },
        ocr_engine: { type: 'string', enum: ['auto', 'paddle', 'rapid', 'windows'], description: 'pipeline 模式本地 OCR 引擎；auto=优先 rapid 自动降级。默认 auto。' },
        interest_concurrency: { type: 'integer', description: 'pipeline 模式兴趣点视觉识别并行数（1..4，默认 2；并发可提速但过大易触发 429）。' },
        preprocess: { type: 'string', enum: ['auto', 'off'], description: 'pipeline 模式 OCR 前处理；auto=深底自动反色/低对比二值化/手写放大（默认）；off=关闭。' },
        upgrade: { type: 'string', enum: ['full', 'low', 'off'], description: 'pipeline 模式自动升级：full=低置信或手写或深底失败时自动转视觉 API 转录（默认）；low=仅低置信；off=关闭。' },
        mode: { type: 'string', enum: ['auto', 'single', 'layered'], description: '仅 strategy=full 有效：块数≤60单请求，否则分层聚合。默认 auto。' },
        group_size: { type: 'integer', description: '仅 full：分层聚合每组最多块数（1..240）。默认 40。' },
        json: { type: 'boolean', description: '仅 full：true=输出 JSON 对象（结构化）。默认 false。' },
        max_tokens: { type: 'integer', description: '单次请求输出 token 上限（256..65536）。默认 8192。' },
        block_size: { type: 'integer', description: '仅 full：块边长，官方缩放甜蜜点为 800（64..4096）。默认 800。' },
        cut_threshold: { type: 'integer', description: '仅 full：长边超过此值才切分；800×800 及以下不切（64..8192）。默认 800。' },
        overlap: { type: 'integer', description: '仅 full：相邻块交叠像素，推荐 64（0..块边长/2-1）。默认 0。' },
        out_dir: { type: 'string', description: '仅 full：块输出目录；默认原图同目录 <原名>_tiles。' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '仅 full：png 无损保真；jpeg 更省请求体。默认 png。' },
        quality: { type: 'integer', description: 'jpeg 质量（40..100）；仅 jpeg 有效。默认 90。' },
        with_overview: { type: 'boolean', description: '仅 full：是否同时生成 overview 缩略图。默认 true。' }
      },
      required: ['file_path']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          answer: { type: 'string' },
          mode: { type: 'string' },
          imageCount: { type: 'integer' },
          stages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          tiles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'integer' },
                row: { type: 'integer' },
                col: { type: 'integer' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                w: { type: 'integer' },
                h: { type: 'integer' },
                file: { type: 'string' }
              }
            }
          },
          outDir: { type: 'string' }
        },
        required: ['answer', 'mode', 'imageCount', 'stages', 'tiles']
      },
      // 识别结果渲染成中文文本：答案 + 分隔线 + 统计（不代为统计 token/费用）。
      // smart 模式额外输出"区域清单 + 下一步指引"（供模型继续编排）。
      render: (_args, value) => {
        const lines = [];
        if (value.mode === 'smart') {
          lines.push('# 整图预检结果');
          lines.push('');
          lines.push(value.answer || '（模型未给出概要）');
          lines.push('');
          lines.push(`有无文字：${value.hasText ? '是' : '否'}`);
          const tr = value.textRegions ?? [];
          const ir = value.interestRegions ?? [];
          if (tr.length > 0) {
            lines.push('', '文字区域（0..1 相对坐标）：');
            tr.forEach((r, i) => lines.push(`  #${i} [${r.relative.x0},${r.relative.y0},${r.relative.x1},${r.relative.y1}]（像素 (${r.pixel.x0},${r.pixel.y0})~(${r.pixel.x1},${r.pixel.y1})）`));
          }
          if (ir.length > 0) {
            lines.push('', '兴趣点区域（0..1 相对坐标）：');
            ir.forEach((r, i) => lines.push(`  #${i} ${r.label} [${r.relative.x0},${r.relative.y0},${r.relative.x1},${r.relative.y1}]（像素 (${r.pixel.x0},${r.pixel.y0})~(${r.pixel.x1},${r.pixel.y1})）`));
          }
          lines.push('', '下一步（请按 smart 流程继续）：');
          lines.push('  1) 重点内容不明确 → 先向用户提问；');
          lines.push(`  2) 文字区域${tr.length > 0 ? '（vision_region_crop recognize=true 视觉直读转录）' : '（无）'}；`);
          lines.push(`  3) 兴趣点${ir.length > 0 ? '（vision_region_crop recognize=true 逐点识别）' : '（无，可请用户指定坐标）'}；`);
          lines.push('  4) 汇总为完整答案。');
        } else {
          lines.push(value.answer);
          lines.push('', '──────── 识别统计 ────────');
          lines.push(`模式：${value.mode === 'pipeline' ? '插件全自动(pipeline)' : value.mode}`);
          lines.push(`块数：${value.imageCount}`);
          lines.push(`请求数：${value.stages.length}`);
          if (value.outDir) lines.push(`块文件目录：${value.outDir}`);
          if (value.outputDir) lines.push(`明细目录：${value.outputDir}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${String(args.file_path ?? '')}`,
      kind: 'read',
      locations: [{ path: String(args.file_path ?? '') }]
    }),
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error(`${tool}: 已取消`);
      if (cfg.debug) debugLog(ctx, `${tool} 开始识别：model=${cfg.model} mode=${cfg.mode} max_tokens=${cfg.maxTokens} ocr_engine=${cfg.ocr_engine}`);

      // 1. 解析 API key（环境变量优先，本机凭据文件兜底；均无则给出明确错误）。
      const apiKey = await resolveApiKey(cfg);
      if (!apiKey) {
        throw new Error(`${tool}: 未找到 API key（环境变量 ${cfg.apiKeyEnv}）——请在环境变量中配置并重启 DSH`);
      }

      // 2. 读取 + 切图。
      const img = await loadImageAndSplit(ctx, exec, args, cfg, tool);
      const { r } = img;

      // 3. 识别相关参数。
      const question = String(args.question ?? '').trim();
      const strategyRaw = args.strategy === undefined ? 'smart' : String(args.strategy);
      if (!['smart', 'pipeline', 'full'].includes(strategyRaw)) {
        throw new Error(`${tool}: strategy 仅支持 smart/pipeline/full`);
      }
      const modeRaw = args.mode === undefined ? cfg.mode : String(args.mode);
      if (!['auto', 'single', 'layered'].includes(modeRaw)) {
        throw new Error(`${tool}: mode 仅支持 auto/single/layered`);
      }
      const groupSize = readInt(args.group_size, cfg.groupSize, 1, 240, 'group_size', tool);
      const maxTokens = readInt(args.max_tokens, cfg.maxTokens, 256, 65536, 'max_tokens', tool);
      const json = readBool(args.json, cfg.json, 'json', tool);
      const withOverview = readBool(args.with_overview, cfg.withOverview, 'with_overview', tool);
      const ocrEngineRaw = args.ocr_engine === undefined ? 'auto' : String(args.ocr_engine);
      if (!['auto', 'paddle', 'rapid', 'windows'].includes(ocrEngineRaw)) {
        throw new Error(`${tool}: ocr_engine 仅支持 auto/paddle/rapid/windows`);
      }

      /* ── 4. 策略分支：smart（模型编排-预检）/ pipeline（插件全自动）/ full（原全网格） ── */

      // 4a. smart：整图预检（detail:'low' 缩略）→ 返回 有无文字/文字区域/兴趣点/概要，
      //     由会话模型继续调度（vision_region_crop 逐区域识别，并可先问用户）。
      if (strategyRaw === 'smart') {
        const mediaType = mediaTypeForExt(img.ext);
        if (mediaType === null) {
          throw new Error(`${tool}: 该图片格式无法直接整图预检，请转换格式为 PNG/JPEG/WebP/GIF`);
        }
        const preview = await previewImage({
          apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
          buffer: Buffer.from(img.bytes),
          mediaType,
          question,
          maxTokens,
          signal: exec.signal,
          timeoutMs: cfg.timeoutMs
        });
        return {
          mode: 'smart',
          answer: preview.summary ?? '',
          summary: preview.summary ?? '',
          hasText: Boolean(preview.hasText),
          textRegions: (preview.textRegions ?? []).map((r) => ({ relative: r, pixel: (pixelRect(r, img.width, img.height)) })),
          interestRegions: (preview.interestRegions ?? []).map((r) => ({ relative: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, label: r.label ?? '', pixel: pixelRect(r, img.width, img.height) })),
          stages: [{ kind: 'precheck' }],
          imageCount: (preview.textRegions?.length ?? 0) + (preview.interestRegions?.length ?? 0),
          tiles: [],
          raw: preview.raw ?? ''
        };
      }

      // 4b. pipeline：插件全自动（预检 → 本地 OCR + 像素网格 → 兴趣点区域识别 → 本地模板汇总）。
      if (strategyRaw === 'pipeline') {
        try { await cleanupOldTempArtifacts(); } catch { /* 清理失败静默 */ }
        const interestConcurrency = args.interest_concurrency === undefined
          ? undefined
          : readInt(args.interest_concurrency, 2, 1, 4, 'interest_concurrency', tool);
        // 前处理优先级：显式参数(工具调用) > 设置页(cfg.preprocess) > 默认 auto。
        const preprocessMode = args.preprocess !== undefined
          ? (args.preprocess === 'off' ? 'off' : 'auto')
          : (String(cfg.preprocess ?? 'auto') === 'off' ? 'off' : 'auto');
        const upgradeMode = ['full', 'low', 'off'].includes(String(args.upgrade ?? ''))
          ? String(args.upgrade)
          : 'default';
        const p = await runPipeline({
          apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
          buf: Buffer.from(img.bytes),
          ext: img.ext,
          width: img.width,
          height: img.height,
          question,
          rotate: img.rotate ?? 0,
          ocrEngine: ocrEngineRaw,
          interestConcurrency,
          preprocess: preprocessMode,
          upgrade: upgradeMode,
          maxTokens,
          signal: exec.signal,
          timeoutMs: cfg.timeoutMs
        });
        return {
          mode: 'pipeline',
          answer: p.answer,
          stages: p.stages,
          hasText: p.hasText,
          textRegions: p.textRegions,
          interestRegions: p.interestRegions,
          outputDir: p.outputDir,
          imageCount: p.stages.length,
          tiles: []
        };
      }

      // 4c. full：原全网格切块识别（先 overview 缩略图后切块，由 writeTilesAndOverview 落盘）。

      // 5. 构造交给识别引擎的 tiles（需带 buffer + mediaType）与网格。
      let tilesForRecognize;
      let grid;
      if (r.splits === false) {
        // 无需切分：等价于“单块原样”识别。仅当格式为 PNG/JPEG 才能按原字节直接上传。
        const mediaType = mediaTypeForExt(img.ext);
        if (mediaType === null) {
          throw new Error(`${tool}: 本图无需切分且格式非 PNG/JPEG，无法直接识别——请先用 vision_tile_split 切分后再识别`);
        }
        tilesForRecognize = [{
          row: 0, col: 0, x: 0, y: 0, w: img.width, h: img.height,
          buffer: Buffer.from(img.bytes),
          mediaType
        }];
        grid = { rows: 1, cols: 1 };
      } else {
        // 切分成功：直接用切出来的块（tile-engine 已带 buffer + mediaType）。
        tilesForRecognize = r.tiles;
        grid = calcRowsCols(r.tiles);
      }

      // 5. 调用识别引擎（内部按块数选择单请求/分层聚合；不代为统计 token/费用）。
      const result = await recognize({
        apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        width: img.width,
        height: img.height,
        tiles: tilesForRecognize,
        grid,
        question,
        mode: modeRaw,
        groupSize,
        maxTokens,
        json,
        signal: exec.signal,
        timeoutMs: cfg.timeoutMs,
        blockSize: img.blockSize,
        overlap: img.overlap
      });

      // 6. 组装输出块清单（不带 buffer）：splits=false 为单块；否则按切块顺序。
      let outputTiles;
      if (r.splits === false) {
        outputTiles = [{ id: 0, row: 0, col: 0, x: 0, y: 0, w: img.width, h: img.height }];
      } else {
        outputTiles = r.tiles.map((t) => ({
          id: t.row * grid.cols + t.col,
          row: t.row,
          col: t.col,
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h
        }));
      }

      // 7. 若用户传入 out_dir，则把切块落盘（便于复查），并给清单补上文件路径。
      let outDir;
      let overviewPath;
      if (r.splits === true) {
        const rawOutDir = String(args.out_dir ?? '').trim();
        if (rawOutDir.length > 0) {
          outDir = pathResolve(img.cwd ?? process.cwd(), rawOutDir);
          const written = await writeTilesAndOverview(outDir, img.base, img.format, r, withOverview);
          // 切块顺序与 outputTiles 一致，可按下标补 file 路径。
          for (let i = 0; i < outputTiles.length; i += 1) {
            outputTiles[i] = { ...outputTiles[i], file: written.list[i].file };
          }
          if (written.overviewPath !== undefined) overviewPath = written.overviewPath;
        }
      }

      // 8. 汇总返回（不代为统计 token/费用字段）。
      return {
        answer: result.answer,
        mode: result.mode,
        imageCount: result.imageCount,
        stages: result.stages,
        tiles: outputTiles,
        ...(outDir !== undefined ? { outDir } : {}),
        ...(overviewPath !== undefined ? { overviewPath } : {})
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/* 工具 3：vision_region_crop（兴趣点区域裁剪识别）                       */
/* ------------------------------------------------------------------ */

/**
 * 轻量读图（仅 resolve/stat/readBytes，不做网格切分——用于区域裁剪等按需场景）。
 * @returns {Promise<{bytes:Buffer, ext:string, cwd:string|undefined, displayPath:string, hostPath:string}>}
 */
async function loadImageBytes(ctx, exec, args, tool) {
  const filePath = String(args.file_path ?? '').trim();
  if (filePath.length === 0) throw new Error(`${tool}: file_path 必须是非空字符串`);
  const ext = extname(filePath).toLowerCase();
  const cwd = exec.agent?.session?.header?.cwd;
  const target = await ctx.fs.resolve(filePath, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
  const info = await ctx.fs.stat(target, exec.signal);
  if (!info) throw new Error(`${tool}: 无法读取"${target.displayPath}"：文件不存在`);
  if (info.type !== 'file') throw new Error(`${tool}: 无法读取"${target.displayPath}"：不是普通文件`);
  const bytes = await ctx.fs.readBytes(target, exec.signal, IMAGE_BYTE_CAP);
  try { ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec); } catch {}
  return { bytes: Buffer.from(bytes), ext, cwd, displayPath: target.displayPath, hostPath: ctx.fs.processPath(target) };
}

/**
 * 构建 vision_region_crop 工具：按矩形（相对 0..1 或像素坐标）裁剪兴趣点区域，
 * 等比缩放至最长边（默认 800，保比例；0=不缩放），落盘 PNG 供本地 OCR/网格使用，
 * 可选直接调用 DeepSeek 视觉 API 识别该区域。
 */
export function createRegionCropTool(ctx, cfg) {
  const tool = 'vision_region_crop';
  return {
    name: tool,
    description: [
      '按矩形裁剪图片的"兴趣点/文字区域"，等比缩放至最长边 800（保比例，如 4:3 → 800×600；max_edge=0 则不缩放 1:1），落盘 PNG；可选择直接调用视觉 API 识别该区域。',
      '参数：file_path（必填）；rect（必填，[x0,y0,x1,y1]，支持 0..1 相对坐标或原图像素坐标，自动识别）；rotate（0/90/180/270 默认 0）；max_edge（默认 800；0=不缩放）；recognize（默认 true=调用视觉 API 返回区域描述；false=仅落盘 PNG 供本地 OCR 工具处理）；question（可选，识别该区域时的问题）；max_tokens（可选，单次识别输出 token 上限 256..65536，默认取配置 maxTokens）；out_dir（可选，默认系统临时目录）。',
      '返回：区域图路径、输出尺寸、原图裁剪矩形（像素）、（recognize=true 时）区域描述。'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: true,
      properties: {
        file_path: { type: 'string', description: '源图片的路径（由文件系统后端解析）。' },
        rect: { type: 'array', description: '必填 [x0,y0,x1,y1]：0..1 相对坐标或原图像素坐标。', items: { type: 'number' } },
        rotate: { type: 'integer', enum: [0, 90, 180, 270], description: '裁剪前顺时针旋转角度。默认 0。' },
        max_edge: { type: 'integer', description: '输出最长边（默认 800，保比例；0=不缩放 1:1 供 OCR）。' },
        max_tokens: { type: 'integer', description: '单次请求输出 token 上限（256..65536）。默认见 config.maxTokens。' },
        recognize: { type: 'boolean', description: 'true=调用视觉 API 返回区域描述（默认）；false=仅落盘供本地 OCR/网格。' },
        question: { type: 'string', description: '识别该区域时的问题（可选）。' },
        out_dir: { type: 'string', description: '区域图输出目录（默认系统临时目录）。' }
      },
      required: ['file_path', 'rect']
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          src: { type: 'object', additionalProperties: true },
          mediaType: { type: 'string' },
          description: { type: 'string' },
          recognized: { type: 'boolean' }
        },
        required: ['path', 'width', 'height', 'src', 'recognized']
      },
      render: (_args, value) => {
        const lines = [
          `region: ${value.path}（输出 ${value.width}×${value.height}，原图矩形 (${value.src.x0},${value.src.y0})~(${value.src.x1},${value.src.y1})）`
        ];
        if (value.recognized) {
          lines.push('', value.description ?? '');
        } else {
          lines.push('（已落盘 PNG，可交给本地 OCR 工具处理）');
        }
        return [{ type: 'text', text: lines.join('\n') }];
      }
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: `${tool}：${String(args.file_path ?? '')} rect=${JSON.stringify(args.rect ?? [])}`,
      kind: 'read',
      locations: [{ path: String(args.file_path ?? '') }]
    }),
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error(`${tool}: 已取消`);
      if (cfg.debug) debugLog(ctx, `${tool} 区域裁剪：rect=${JSON.stringify(args.rect ?? [])} max_edge=${args.max_edge ?? 800} recognize=${args.recognize ?? true}`);
      const img = await loadImageBytes(ctx, exec, args, tool);
      const rect = args.rect;
      if (!Array.isArray(rect) || rect.length !== 4) {
        throw new Error(`${tool}: rect 必须是 [x0,y0,x1,y1] 四元数组`);
      }
      const maxEdge = readInt(args.max_edge, 800, 0, 8192, 'max_edge', tool);
      const recognizeFlag = readBool(args.recognize, true, 'recognize', tool);
      const rotate = readInt(args.rotate, cfg.rotate ?? 0, 0, 270, 'rotate', tool);
      if (![0, 90, 180, 270].includes(rotate)) throw new Error(`${tool}: rotate 仅支持 0/90/180/270`);
      // 单次请求输出 token 上限（默认 cfg.maxTokens；可经 args.max_tokens 覆盖）
      const maxTokens = readInt(args.max_tokens, cfg.maxTokens, 256, 65536, 'max_tokens', tool);

      const cropped = await cropRegion(img.bytes, img.ext, {
        rect,
        maxEdge,
        format: 'png',
        rotate
      });

      // 落盘：显式 out_dir 或系统临时目录
      const outDirRaw = String(args.out_dir ?? '').trim();
      const outDir = outDirRaw.length > 0
        ? pathResolve(img.cwd ?? process.cwd(), outDirRaw)
        : tmpdir();
        // 过期临时文件清理（仅插件前缀；不触碰用户指定 out_dir）
        try {
          await cleanupOldTempArtifacts({ excludePaths: outDirRaw.length > 0 ? [outDir] : [] });
        } catch { /* 清理失败静默 */ }
      await mkdir(outDir, { recursive: true });
      const outPath = join(outDir, `region-${Date.now()}-${randomBytes(3).toString('hex')}.png`);
      await writeFile(outPath, cropped.buffer);

      let description;
      if (recognizeFlag) {
        const apiKey = await resolveApiKey(cfg);
        if (!apiKey) {
          throw new Error(`${tool}: 识别需要 API key（环境变量 ${cfg.apiKeyEnv}）——请配置后重试，或设 recognize=false 仅落盘`);
        }
        const res = await recognizeRegion({
          apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
          buffer: cropped.buffer,
          mediaType: cropped.mediaType,
          label: String(args.question ?? '').slice(0, 60),
          question: String(args.question ?? ''),
          maxTokens,
          signal: exec.signal,
          timeoutMs: cfg.timeoutMs
        });
        description = res.description;
      }
      return {
        path: outPath,
        width: cropped.width,
        height: cropped.height,
        src: cropped.src,
        mediaType: cropped.mediaType,
        recognized: recognizeFlag,
        ...(description !== undefined ? { description } : {})
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 注册本插件三个工具的工具集（v0.4.2）。
 * 每个工具注册前用 withCollabIfPresent 按当前探测结果（picturereader 是否在场）追加分工引导段；
 * 不在场则 description 与基线逐字节一致（回归红线）。
 * @param {object} ctx - Cordis 上下文（提供 ctx.tools.register）。
 * @param {object} liveCfg - 实时配置 Proxy。
 * @param {boolean} present - picturereader 是否在场。
 * @returns {Array<() => void>} 各工具注册返回的 disposer。
 */
function registerToolset(ctx, liveCfg, present) {
  return [
    ctx.tools.register(withCollabIfPresent(createSplitTool(ctx, liveCfg), present)),
    ctx.tools.register(withCollabIfPresent(createRecognizeTool(ctx, liveCfg), present)),
    ctx.tools.register(withCollabIfPresent(createRegionCropTool(ctx, liveCfg), present))
  ];
}

/**
 * DSH 插件入口：注册 vision_tile_split / vision_tile_recognize / vision_region_crop 三个工具。
 *
 * v0.3.0 设置说明：
 *  - 新增「图像识别」设置命名空间（NS='vision-exp-tile'），在 DSH Web 设置页
 *    注册分区，配置以 dsh settings.yaml 持久化、运行时热生效。
 *  - 可见性由 dsh 的 settings.describe() 自动枚举（rc.7+ 无白名单），无需额外暴露。
 *  - 工具执行时经 getRuntimeConfig() 惰性读取最新设置，优先级：
 *    工具参数(显式) > 设置页 > 默认值；env 映射（OCR 引擎/池等）在下次工具调用生效。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [configRaw] - 用户配置（可 undefined，此时走 DEFAULT_CONFIG）。
 */
export function apply(ctx, configRaw) {
  // configRaw 可为 undefined，normalizeConfig 负责合并默认并校验。
  const cfg = normalizeConfig(configRaw);
  // B. peer 配置复用（v0.4.2）：picturereader 已配视觉端点/模型则免重复配置——
  //    applyPeerDefaults 仅在 baseURL/model 等于默认（未显式）时以 peer 值覆盖；用户显式 > peer > 默认。
  const peer = readPeerSettings();
  applyPeerDefaults(cfg, peer);

  // ── 运行时快照：工具执行时惰性读最新设置；
  //    sourceGetter 为 null（无 settings 服务或尚未注册）时回退到初始 cfg。──
  let sourceGetter = null;
  const getConfig = () => (sourceGetter ? sourceGetter() : cfg);
  setRuntimeSource(getConfig);

  // 让工具读取「实时」配置：用 Proxy 把 cfg.xxx 转到 getRuntimeConfig()。
  // 这样「工具参数(显式) > 设置页 > 默认值」的优先级天然成立——参数在工具内部
  // 覆盖 cfg，而 cfg 每次读取都拿到最新设置快照，改设置即热生效。
  const liveCfg = new Proxy({}, {
    get(_t, prop) {
      const live = getRuntimeConfig();
      return live ? live[prop] : undefined;
    }
  });

  // ── v0.4.2：picturereader 共存分工引导 ──
  // 注册时按当前探测结果拼装分工段；延迟 500/1500ms 复查（防插件注册顺序竞态），
  // 若结果变化且尚无二次注册 → 解除后再 register 一次（仅前 2s 内"裸重注册"，不干扰正常使用）。
  ctx.effect(() => {
    let present = isPicturereaderPresent({ toolsApi: ctx.tools });
    let registered = registerToolset(ctx, liveCfg, present);
    let rechecked = false;
    const recheck = () => {
      if (rechecked) return;
      rechecked = true;
      const p2 = isPicturereaderPresent({ toolsApi: ctx.tools });
      if (p2 !== present) {
        present = p2;
        for (const d of registered) { try { d(); } catch { /* 忽略 */ } }
        registered = registerToolset(ctx, liveCfg, present);
      }
    };
    const t1 = setTimeout(recheck, 500);
    const t2 = setTimeout(recheck, 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      for (const d of registered) { try { d(); } catch { /* 忽略 */ } }
    };
  });

  // ── v0.3.0：注册「图像识别」设置命名空间 + 订阅热更 ──
  try {
    ctx.inject(['settings'], (sctx) => {
      // base 用 toSettingsBase(configRaw)：把 configRaw 的 camelCase 键转成
      // snake_case，作为第 2 层（低于用户设置页、高于 schema 默认）参与解析，
      // 避免 schema 默认值遮蔽 configRaw 里用户显式写的 baseURL 等。
      const scope = sctx.settings.register(
        settingsNamespace(NS),
        SettingsSchema,
        { base: toSettingsBase(configRaw) }
      );
      // 读取时实时归一化（scope.get() 已含 schema默认 + configRaw base + 用户设置）。
      sourceGetter = () => applyPeerDefaults(normalizeFromSettings(scope.get()), peer);
      // 首次应用一次设置页的环境变量映射（OCR 引擎/池等）。
      applySettingsEnv(scope.get());
      // v0.4.1 扩展：异步设备探测完成后，按 auto 档位重新应用 env（slow/省电/平台降级/
      //   慢网等推荐统一合并后落地），并回写只读设备画像（device_profile）。
      //   探测含 GPU spawn/电源/微基准（≤1.5s，并行），故 fire-and-forget，不阻塞插件启动；
      //   device_benchmark / device_power_probe 设置开关控制是否跑对应探测。
      const probeOpts = {
        runBenchmark: scope.get().device_benchmark !== false,
        runPowerProbe: scope.get().device_power_probe !== false
      };
      probeDevice(null, probeOpts).then((probe) => {
        try {
          applySettingsEnv(scope.get());
          const text = deviceProfileText(probe);
          // 仅在差异时回写，避免每次启动都覆盖 settings.yaml（幂等）。
          if (typeof scope.set === 'function' && String(scope.get().device_profile ?? '') !== text) {
            scope.set('device_profile', text);
          }
        } catch (error) {
          ctx.logger?.warn?.(`[vision-exp-tile] 应用设备档位 env 失败：${String(error)}`);
        }
      });
      // 订阅变化：设置更新时重新应用 env（进程池参数在下次工具调用生效）。
      scope.watch(() => {
        try {
          applySettingsEnv(scope.get());
        } catch (error) {
          ctx.logger?.warn?.(`[vision-exp-tile] 应用设置 env 失败：${String(error)}`);
        }
      });
    });
  } catch (error) {
    ctx.logger?.warn?.(`[vision-exp-tile] settings 注册失败：${String(error)}`);
  }
}
