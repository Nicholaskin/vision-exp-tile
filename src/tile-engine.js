/**
 * tile-engine.js — 切图引擎（纯逻辑，不依赖 DSH 服务，便于单元测试）
 *
 * 设计依据（deepseek-v4-flash-vision-exp 官方 API 文档）：
 *  - 每张图进模型前会被自动缩放：总像素 < ~384×384 放大；更大的图保持长宽比缩小到
 *    ≈800×800 总像素；每张图 token 封顶 384。
 *  - 因此「块边长 = 800」是官方缩放规则的甜蜜点：800×800 的块在边界上，不会被降采样，
 *    细节零损失，且每块恰好 ≤384 token。
 *  - 本模块只负责几何与像素：计算网格、读取/解码、提取块、生成块图与 overview 缩略图。
 */

import { createRequire } from 'node:module';

/* ------------------------------------------------------------------ */
/* 几何计算：将尺寸为 width×height 的图切成 blockSize 的网格            */
/* ------------------------------------------------------------------ */

/** 最小块边长（防止误配置导致几百上千个碎片块） */
export const MIN_BLOCK_SIZE = 64;
/** 最大 overlap 比例（交叠不能超过块的一半，否则块数爆炸） */
export const MAX_OVERLAP_RATIO = 0.5;

/**
 * 判断是否需要切分：长边 > threshold 才切；等于或小于不切。
 * @param {number} width  - 原图宽（像素）
 * @param {number} height - 原图高（像素）
 * @param {number} threshold - 切分阈值（默认 800，即 800×800 及以下不切）
 * @returns {boolean} 是否需要切分
 */
export function shouldSplit(width, height, threshold = 800) {
  return Math.max(width, height) > threshold;
}

/**
 * 计算网格：按行优先（row 0 从左到右，再 row 1…）生成每个块的几何信息。
 * 边缘块取实际剩余尺寸（不补白、不放大，保证像素 1:1 无损）。
 * 支持 overlap：相邻块交叠 overlap 像素，避免横跨块边界的文字/图形被切断。
 *
 * 举例：4000×3000、块 800、overlap 0 → 每行 5 块（800×800 ×4 + 800×800），
 *       共 5×4 = 20 块。第 0 块 [0,0]-[800,800]，第 1 块 [800,0]-[1600,800]…
 *
 * @param {number} width  - 原图宽
 * @param {number} height - 原图高
 * @param {number} blockSize - 块边长（默认 800）
 * @param {number} overlap - 交叠像素（默认 0；推荐 64）
 * @returns {{tiles: Array<{row:number,col:number,x:number,y:number,w:number,h:number}>,
 *            rows:number, cols:number}} 网格结果
 */
export function computeGrid(width, height, blockSize = 800, overlap = 0) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`grid: invalid image size ${width}x${height}`);
  }
  if (!Number.isInteger(blockSize) || blockSize < MIN_BLOCK_SIZE) {
    throw new Error(`grid: blockSize must be an integer >= ${MIN_BLOCK_SIZE}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error('grid: overlap must be a non-negative integer');
  }
  if (overlap >= blockSize * MAX_OVERLAP_RATIO) {
    throw new Error(`grid: overlap must be < ${Math.floor(blockSize * MAX_OVERLAP_RATIO)} (50% of blockSize)`);
  }
  // 步长 = 块边长 - 交叠；相邻块起点相距 step 像素
  const step = blockSize - overlap;
  const tiles = [];
  let rows = 0;
  let cols = 0;
  for (let y = 0, row = 0; y < height; y += step, row += 1) {
    const h = Math.min(blockSize, height - y); // 边缘块实际高度
    let rowCols = 0;
    for (let x = 0, col = 0; x < width; x += step, col += 1) {
      const w = Math.min(blockSize, width - x); // 边缘块实际宽度
      tiles.push({ row, col, x, y, w, h });
      rowCols = col + 1;
      if (w < blockSize) break; // 到边缘，该行结束
    }
    cols = Math.max(cols, rowCols);
    rows = row + 1;
    if (h < blockSize) break; // 到边缘，网格结束
  }
  return { tiles, rows, cols };
}

/**
 * 生成块文件名：自含坐标，任何调用方（包括未来的脚本）都可直接解析。
 * 例：photo_r0_c1_x800_y0_800x800.png（行 0 列 1，原图坐标 x=800,y=0，宽 800 高 800）
 * @param {string} base - 原图文件名（不含扩展名）
 * @param {object} tile - {row,col,x,y,w,h}
 * @param {string} ext - 输出扩展名（png/jpg）
 * @returns {string} 块文件名
 */
export function tileFileName(base, tile, ext = 'png') {
  return `${base}_r${tile.row}_c${tile.col}_x${tile.x}_y${tile.y}_${tile.w}x${tile.h}.${ext}`;
}

/* ------------------------------------------------------------------ */
/* 解码与切块                                                           */
/* ------------------------------------------------------------------ */

/**
 * 读取工具缓存的 sharp 实例（若插件目录安装了 sharp 则可用；否则回退 pngjs/jpeg-js）。
 * createRequire 保证在 ESM 环境仍能 require CJS 的 sharp。
 */
function loadSharp() {
  try {
    const require = createRequire(import.meta.url);
    return require('sharp');
  } catch {
    return null; // sharp 不可用 → 走 PNG/JPEG 纯 JS 回退
  }
}

/** 允许的旋转角度（顺时针），用于识别前把"歪图"转正 */
export const ROTATE_ANGLES = [0, 90, 180, 270];

/**
 * 基于 sharp 的高性能切分：任意格式解码（PNG/JPEG/GIF/WebP/BMP…），提取块并编码。
 * 块编码格式由 format 决定：png 无损（默认，保真优先）或 jpeg（质量 quality，默认 90）。
 * rotate：识别前先顺时针旋转 0/90/180/270 度（默认 0）——用于模型"误判方向"场景：
 * 若用户知道图片横倒/倒置，可在调用时指定，切图、坐标与 overview 均基于旋转后的图像。
 * @param {Buffer} buf - 原图字节
 * @param {object} opts - {blockSize, overlap, threshold, format, quality, rotate}
 * @returns {Promise<{splits:boolean,width:number,height:number,
 *          tiles:Array<{row,col,x,y,w,h,buffer:Buffer,mediaType:string}>, overview:Buffer|null}>}
 */
export async function splitWithSharp(buf, { blockSize = 800, overlap = 0, threshold = 800, format = 'png', quality = 90, rotate = 0 }) {
  const sharp = loadSharp();
  if (!sharp) throw new Error('sharp is not available');
  // 显式旋转：先转正为 PNG 基准图（消除 EXIF 干扰，后续一切基于旋转后的像素）
  const rot = ROTATE_ANGLES.includes(rotate) ? rotate : 0;
  const base = rot !== 0 ? await sharp(buf, { failOn: 'none' }).rotate(rot).png().toBuffer() : buf;
  const img = sharp(base, { failOn: 'none' });
  const meta = await img.metadata();
  const width = meta.width;
  const height = meta.height;
  if (width === undefined || height === undefined) {
    throw new Error(`tile: cannot read image dimensions from this file (meta=${JSON.stringify(meta)})`);
  }
  const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (!shouldSplit(width, height, threshold)) {
    return { splits: false, width, height, tiles: [], overview: null };
  }
  const grid = computeGrid(width, height, blockSize, overlap);
  const tiles = [];
  for (const t of grid.tiles) {
    // extract 从原图 1:1 提取（不缩放），保持像素无损
    const buffer = await sharp(base, { failOn: 'none' })
      .extract({ left: t.x, top: t.y, width: t.w, height: t.h })
      .toFormat(format === 'jpeg' ? 'jpeg' : 'png', { quality })
      .toBuffer();
    tiles.push({ ...t, buffer, mediaType });
  }
  // overview：原图缩略（最长边 800）+ 网格线 + 块号，供模型先建立全局布局
  const overview = await buildOverview(sharp, base, width, height, grid, format);
  return { splits: true, width, height, tiles, overview, rotated: rot };
}

/**
 * 生成带网格与块号的 overview 缩略图：SVG 叠加到缩放后的原图上。
 * 块号写在每个块左上角，与坐标清单的编号一一对应（行优先）。
 * @param {object} sharp - sharp 构造函数
 * @param {Buffer} buf - 原图字节
 * @param {number} width - 原图宽
 * @param {number} height - 原图高
 * @param {object} grid - computeGrid 结果
 * @returns {Promise<Buffer|null>} overview PNG 字节（失败返回 null，不阻塞主流程）
 */
async function buildOverview(sharp, buf, width, height, grid, format) {
  try {
    const targetEdge = 800; // 缩略图最长边
    // 保持长宽比的缩放目标尺寸（先求 scale 再计算实际像素）
    const scale = Math.min(1, targetEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    // 生成网格线 + 块号的 SVG（坐标按 scale 放大回缩略图坐标系）
    const lines = [];
    for (const t of grid.tiles) {
      const x = Math.round(t.x * scale);
      const y = Math.round(t.y * scale);
      const tw = Math.max(2, Math.round(t.w * scale));
      const th = Math.max(2, Math.round(t.h * scale));
      const num = t.row * grid.cols + t.col; // 行优先编号（从 0 开始）
      const fs = Math.max(10, Math.round(14 * scale * 2));
      lines.push(
        `<rect x="${x}" y="${y}" width="${tw}" height="${th}" fill="none" stroke="#ff3b30" stroke-width="${Math.max(1, Math.round(2 * scale * 2))}" stroke-opacity="0.9"/>`,
        `<text x="${x + Math.max(2, Math.round(4 * scale))}" y="${y + fs}" font-size="${fs}" fill="#ff3b30" stroke="#ffffff" stroke-width="${Math.max(1, Math.round(fs / 8))}" paint-order="stroke">${num}</text>`
      );
    }
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${lines.join('')}</svg>`
    );
    return await sharp(buf, { failOn: 'none' })
      .resize(w, h, { fit: 'contain' })
      .composite([{ input: svg, top: 0, left: 0 }])
      .png()
      .toBuffer();
  } catch {
    return null; // overview 只是辅助，失败不中断切块流程
  }
}

/* ------------------------------------------------------------------ */
/* 纯 JS 回退引擎（无 sharp 时）：PNG 用 pngjs、JPEG 用 jpeg-js；        */
/* GIF/BMP/WebP 无法回退时给出明确报错。                                */
/* ------------------------------------------------------------------ */

/** 回退解码：返回 {data:Uint8Array(RGBA), width, height} */
export function decodeFallback(buf, ext) {
  let png;
  let jpeg;
  try {
    const require = createRequire(import.meta.url);
    png = require('pngjs').PNG;
    jpeg = require('jpeg-js');
  } catch {
    throw new Error('tile: neither sharp nor pngjs/jpeg-js is available; run `npm install` in the plugin directory');
  }
  const extL = String(ext).toLowerCase();
  if (extL === '.png') {
    const img = png.sync.read(buf);
    return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  }
  if (extL === '.jpg' || extL === '.jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 120 });
    return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  }
  throw new Error(`tile: fallback engine supports PNG/JPEG only; got "${extL}" — install sharp for full format support`);
}

/**
 * 轻量探测图片尺寸（v1.0.0 新增）。
 *
 * 用途：调用方（批量流水线等）有时拿不到尺寸，而下游的「相对坐标 → 像素坐标」换算
 * 必须知道原图宽高；传 0 会把矩形钳成 0（静默错数据，比报错更危险）——
 * 所以这里提供一条「不知道就问图片本身」的通道。
 *
 * 实现：sharp 可用时走 metadata()（不解码像素，快）；否则回退整图解码（pngjs/jpeg-js）。
 * @param {Buffer} buf - 原图字节
 * @param {string} ext - 扩展名（.png/.jpg/.jpeg/…）
 * @returns {Promise<{width:number, height:number}>}
 * @throws {Error} 两种引擎都不可用或格式不被回退引擎支持时抛出（调用方需自行决定是否兜底）
 */
export async function probeImageSize(buf, ext) {
  const sharp = loadSharp();
  if (sharp) {
    try {
      const meta = await sharp(buf, { failOn: 'none' }).metadata();
      if (Number(meta?.width) > 0 && Number(meta?.height) > 0) {
        return { width: Number(meta.width), height: Number(meta.height) };
      }
    } catch {
      /* metadata 失败 → 落到回退解码 */
    }
  }
  const img = decodeFallback(buf, ext);
  return { width: img.width, height: img.height };
}

/** 从 RGBA 像素中提取一个子矩形（1:1 复制，无缩放） */
export function extractRgba(image, t) {
  const out = new Uint8Array(t.w * t.h * 4);
  const src = image.data;
  for (let row = 0; row < t.h; row += 1) {
    const srcStart = ((t.y + row) * image.width + t.x) * 4;
    const dstStart = row * t.w * 4;
    out.set(src.subarray(srcStart, srcStart + t.w * 4), dstStart);
  }
  return out;
}

/**
 * 回退引擎切分：先解码整图，再逐块提取像素并重编码。
 * @param {Buffer} buf - 原图字节
 * @param {string} ext - 原图扩展名（.png/.jpg/.jpeg）
 * @param {object} opts - {blockSize, overlap, threshold, format, quality}
 * @returns {Promise<{splits,width,height,tiles,overview}>}
 */
export async function splitFallback(buf, ext, { blockSize = 800, overlap = 0, threshold = 800, format = 'png', quality = 90 }) {
  const image = decodeFallback(buf, ext);
  if (!shouldSplit(image.width, image.height, threshold)) {
    return { splits: false, width: image.width, height: image.height, tiles: [], overview: null };
  }
  const png = createRequire(import.meta.url)('pngjs').PNG;
  const jpeg = createRequire(import.meta.url)('jpeg-js');
  const grid = computeGrid(image.width, image.height, blockSize, overlap);
  const tiles = [];
  for (const t of grid.tiles) {
    const rgba = extractRgba(image, t);
    const mediaType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    let buffer;
    if (format === 'jpeg') {
      buffer = Buffer.from(jpeg.encode({ data: Buffer.from(rgba), width: t.w, height: t.h }, quality).data);
    } else {
      buffer = Buffer.from(png.sync.write({ data: Buffer.from(rgba), width: t.w, height: t.h }));
    }
    tiles.push({ ...t, buffer, mediaType });
  }
  return { splits: true, width: image.width, height: image.height, tiles, overview: null };
}

/**
 * 统一切分入口：优先 sharp（全格式、高性能、可生成 overview），失败回退纯 JS。
 * @param {Buffer} buf - 原图字节
 * @param {string} ext - 原图扩展名（如 .png/.jpg/.webp）
 * @param {object} opts - 切分参数（含 rotate：0/90/180/270；rotate≠0 需要 sharp）
 * @returns {Promise<{splits,width,height,tiles,overview,engine:string}>}
 */
export async function splitImage(buf, ext, opts = {}) {
  const rot = opts.rotate ?? 0;
  const sharp = loadSharp();
  if (sharp) {
    try {
      const r = await splitWithSharp(buf, opts);
      return { ...r, engine: 'sharp' };
    } catch (error) {
      // sharp 对个别损坏文件可能失败；若扩展名是 PNG/JPEG 且无需旋转则回退，否则抛错
      const extL = String(ext).toLowerCase();
      const canFallback = rot === 0 && (extL === '.png' || extL === '.jpg' || extL === '.jpeg');
      if (!canFallback) throw error;
    }
  } else if (rot !== 0) {
    throw new Error('tile: rotate 需要 sharp 支持（本机未安装 sharp）；请先安装或去掉 rotate 参数');
  }
  const r = await splitFallback(buf, ext, opts);
  return { ...r, engine: 'fallback' };
}

/* ------------------------------------------------------------------ */
/* 兴趣点区域裁剪（vision_region_crop / pipeline 使用）                 */
/* ------------------------------------------------------------------ */

/**
 * 把模型给出的矩形统一为"原图像素坐标"（含边界钳制）。
 * 支持两种输入（同一批数值里混用会按"全部 ≤1 视为相对"规则判定）：
 *  - 相对坐标：所有值 ∈ [0,1]，表示原图比例（如 [0.25, 0.1, 0.75, 0.9]）；
 *  - 像素坐标：任意值 >1，直接使用（如 [800, 1200, 2400, 1800]）。
 * @param {Array<number>} rect - [x0,y0,x1,y1]
 * @param {number} imgWidth - 原图宽
 * @param {number} imgHeight - 原图高
 * @returns {{x0:number,y0:number,x1:number,y1:number,w:number,h:number}} 整数像素矩形
 */
export function normalizeRect(rect, imgWidth, imgHeight) {
  if (!Array.isArray(rect) || rect.length !== 4) {
    throw new Error(`normalizeRect: rect 必须是 [x0,y0,x1,y1] 四元数组（实际：${JSON.stringify(rect)}）`);
  }
  const nums = rect.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) {
    throw new Error(`normalizeRect: rect 元素必须是有限数字（实际：${JSON.stringify(rect)}）`);
  }
  const isRelative = nums.every((v) => v >= 0 && v <= 1);
  let [rx0, ry0, rx1, ry1] = nums;
  if (isRelative) {
    rx0 *= imgWidth; rx1 *= imgWidth;
    ry0 *= imgHeight; ry1 *= imgHeight;
  }
  // 排序保证 x0<=x1、y0<=y1（模型输出可能反过来）
  const x0 = Math.round(Math.min(rx0, rx1));
  const x1 = Math.round(Math.max(rx0, rx1));
  const y0 = Math.round(Math.min(ry0, ry1));
  const y1 = Math.round(Math.max(ry0, ry1));
  // 边界钳制 + 最小尺寸保护
  const cx0 = Math.max(0, Math.min(imgWidth - 1, x0));
  const cy0 = Math.max(0, Math.min(imgHeight - 1, y0));
  const cx1 = Math.max(cx0 + 1, Math.min(imgWidth, x1));
  const cy1 = Math.max(cy0 + 1, Math.min(imgHeight, y1));
  return { x0: cx0, y0: cy0, x1: cx1, y1: cy1, w: cx1 - cx0, h: cy1 - cy0 };
}

/**
 * 兴趣点区域裁剪：从原图提取矩形区域并**缩放到最长边 maxEdge（保持宽高比）**。
 * 例：区域 2000×1500、maxEdge=800 → 输出 800×600（4:3 保持），满足"按比例切，最长边 800"。
 * 裁剪/缩放基于原图 1:1 像素（无 EXIF 干扰；rotate 时先转正再裁）。
 * @param {Buffer} buf - 原图字节
 * @param {string} ext - 原图扩展名
 * @param {object} opts - {rect, maxEdge, format, quality, rotate}
 *   maxEdge：最长边上限（默认 800）；**传 0 表示不缩放**（仅 1:1 裁剪，供本地 OCR 等需要原始像素的场景）。
 * @returns {Promise<{buffer,mediaType,width,height,src:{x0,y0,x1,y1,w,h}}>}
 *   width/height 为输出尺寸（maxEdge=0 时等于 src.w/h）；src 为原图裁剪矩形（供坐标回写）。
 */
export async function cropRegion(buf, ext, { rect, maxEdge = 800, format = 'png', quality = 90, rotate = 0 } = {}) {
  const sharp = loadSharp();
  if (!sharp) throw new Error('cropRegion: 需要 sharp 支持（本机未安装 sharp）');
  const rot = ROTATE_ANGLES.includes(rotate) ? rotate : 0;
  // 先转正（与 splitImage 同一策略）：显式旋转后以 PNG 为基准图
  const base = rot !== 0 ? await sharp(buf, { failOn: 'none' }).rotate(rot).png().toBuffer() : buf;
  const meta = await sharp(base, { failOn: 'none' }).metadata();
  const imgWidth = meta.width;
  const imgHeight = meta.height;
  if (imgWidth === undefined || imgHeight === undefined) {
    throw new Error(`cropRegion: cannot read image dimensions (meta=${JSON.stringify(meta)})`);
  }
  const src = normalizeRect(rect, imgWidth, imgHeight);
  // 提取原区域（1:1）；maxEdge>0 且长边超限时等比缩放（fit: inside，不放大）
  const extracted = sharp(base, { failOn: 'none' }).extract({ left: src.x0, top: src.y0, width: src.w, height: src.h });
  let out = extracted;
  if (maxEdge > 0 && Math.max(src.w, src.h) > maxEdge) {
    if (src.w >= src.h) out = out.resize({ width: maxEdge, height: null, fit: 'inside', withoutEnlargement: true });
    else out = out.resize({ width: null, height: maxEdge, fit: 'inside', withoutEnlargement: true });
  }
  const buffer = await out.toFormat(format === 'jpeg' ? 'jpeg' : 'png', { quality }).toBuffer();
  // 输出尺寸（sharp 若没缩放则与原区域一致）
  const outMeta = await sharp(buffer, { failOn: 'none' }).metadata();
  return {
    buffer,
    mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width: outMeta.width,
    height: outMeta.height,
    src
  };
}
