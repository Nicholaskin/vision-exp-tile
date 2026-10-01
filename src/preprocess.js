/**
 * preprocess.js — OCR 图像前处理管线（v0.2.0 核心新增）
 *
 * 目标：解决两大已知短板——
 *   ① 深底白字/低对比图（如宣传图、课件深色底）本地 OCR 检出失败（实测 rapid 0 行）；
 *   ② 手写/复杂图识别不佳（反色、二值化、对比度增强、放大后识别率提升）。
 *
 * 设计原则：
 *   - 纯 **pngjs** 像素操作（零新依赖，无 sharp 双实例风险）；
 *   - 「高对比印刷体」自动跳过（applied=[]，绝无副作用）；
 *   - 任何异常返回原图（不抛错、不降级失败）；
 *   - 全程确定性（无随机），便于回归基准。
 *
 * 管线（按需应用，输出 PNG 字节）：
 *   灰度化 → 深底检测（平均亮度/前景占比）→ 自动反色 → Otsu 自适应二值化
 *   → 百分位对比度拉伸（P1/P99）→ ≤2× 最近邻放大（长边 ≤1200 时）
 *
 * @module preprocess
 */

import { PNG } from 'pngjs';

/** 深底判定阈值：平均灰度低于该值判定为"深底/黑底"（白字场景） */
const DARK_AVG_LUMINANCE = 110;
/** 深底时允许的亮像素占比下限（低于此占比说明是纯黑图/夜景，不做反色） */
const DARK_STAGE_SHARE = 0.005;
/** 放大的长边阈值：超过该值不放大（避免破坏大图与耗时） */
const ENLARGE_MAX_EDGE = 1200;
/** 放大倍率（2×） */
const ENLARGE_FACTOR = 2;

/* ------------------------------------------------------------------ */
/* 基础算子                                                             */
/* ------------------------------------------------------------------ */

/** 灰度化：把 {data,width,height} RGBA 转 Float32 灰度数组（0..255） */
export function toGray(png) {
  const { width, height, data } = png;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

/** 统计：均值/标准差/亮像素占比（gray 0..255） */
export function statsOf(gray) {
  const n = gray.length;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += gray[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i += 1) sq += (gray[i] - mean) ** 2;
  const std = Math.sqrt(sq / n);
  let bright = 0;
  for (let i = 0; i < n; i += 1) if (gray[i] > 200) bright += 1;
  return { mean, std, brightShare: bright / n };
}

/** Otsu 自适应阈值：返回 0..255 阈值。
 *  健壮性：① 直方图非零桶过少（两极分布/近单色）→ 回退 127；
 *          ② 结果 clamp 到 [20,235]，避免极端 0/255 把整图涂同色。 */
export function otsuThreshold(gray, bins = 256) {
  const hist = new Float64Array(bins);
  for (let i = 0; i < gray.length; i += 1) {
    const b = Math.max(0, Math.min(bins - 1, Math.round((gray[i] / 255) * (bins - 1))));
    hist[b] += 1;
  }
  const nonzero = hist.filter((h) => h > 0).length;
  if (nonzero < 3) return 127; // 两极/单色退化回退
  const total = gray.length;
  let sumAll = 0;
  for (let b = 0; b < bins; b += 1) sumAll += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = 127;
  let bestVar = -1;
  for (let b = 0; b < bins; b += 1) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = Math.round((b / (bins - 1)) * 255);
    }
  }
  return Math.max(20, Math.min(235, best));
}

/** 百分位值（0..1 分位） */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx];
}

/**
 * 核心前处理。
 * @param {Buffer} pngBuffer - PNG 字节（文字区裁剪输出即 PNG）
 * @param {object} [opts] - { force:'auto'|'dark'|'none', enlarge:'auto'|'off' }
 *   force=auto 自动检测；dark=强制深底处理；none=跳过。
 *   enlarge=off 时只做反色/二值化/对比度拉伸、不做 ≤2× 放大（v0.2.0 分流：非手写区省时）。
 * @returns {Promise<{buffer:Buffer, applied:string[], isDark:boolean, enhanced:boolean,
 *                    width:number, height:number, reason:string}>}
 */
export async function autoPreprocess(pngBuffer, { force = 'auto', enlarge = 'auto' } = {}) {
  const passthrough = (reason) => ({
    buffer: pngBuffer, applied: [], isDark: false, enhanced: false,
    width: 0, height: 0, reason
  });
  let png;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch (e) {
    return passthrough(`非 PNG 或解码失败：${String(e?.message ?? e).slice(0, 80)}`);
  }
  if (force === 'none') return passthrough('force=none 跳过前处理');
  const { width, height } = png;
  if (width < 40 || height < 40) return passthrough(`图过小(${width}x${height})跳过前处理`);

  const gray = toGray(png);
  const st = statsOf(gray);
  const applied = [];
  let work = gray;

  // 1) 深底检测与自动反色
  let isDark = false;
  const darkByForce = force === 'dark' && st.mean < 200;
  if ((st.mean < DARK_AVG_LUMINANCE && st.brightShare > DARK_STAGE_SHARE) || darkByForce) {
    isDark = true;
    work = new Float32Array(work.length);
    for (let i = 0; i < gray.length; i += 1) work[i] = 255 - gray[i];
    applied.push('invert');
  }

  // 2) Otsu 自适应二值化（深底/低对比场景；高对比印刷体跳过）
  const rawStd = st.std;
  // 纯色/近纯色（无文本信号，如空白页/照片纯背景）→ 整个跳过前处理
  if (rawStd < 12) {
    return passthrough(`近似纯色图(std=${rawStd.toFixed(0)})跳过前处理`);
  }
  const lowContrast = rawStd < 45 || isDark || (rawStd < 90 && st.mean < 175);
  // —— 放大候选信号（v0.2.0）：中等对比文本页（手写/小字/印刷体都受益，
  //    放大对正确性无损，仅少量耗时；纯色/极高对比已排除）——
  const darkShare = 1 - st.brightShare;
  const enlargeCandidate = st.mean > 165 && rawStd >= 30 && rawStd <= 135 && darkShare >= 0.03 && darkShare <= 0.6;
  if (lowContrast) {
    const t = otsuThreshold(work);
    const bin = new Uint8Array(work.length);
    for (let i = 0; i < work.length; i += 1) bin[i] = work[i] >= t ? 255 : 0;
    applied.push('otsu');
    // 3) 百分位对比度拉伸（二值化后为 0/255 已极值化；此处对未二值化时的灰度做增强——
    //    本管线二值化先行，拉伸仅当未触发二值化时应用）
    work = new Float32Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) work[i] = bin[i];
  } else {
    // 高对比印刷体：仅做轻微的百分位拉伸（P1/P99 clamp），几乎无观感变化
    const sorted = Array.from(work).sort((a, b) => a - b);
    const lo = percentile(sorted, 0.01);
    const hi = percentile(sorted, 0.99);
    if (hi - lo > 20 && hi - lo < 220) {
      for (let i = 0; i < work.length; i += 1) {
        work[i] = Math.max(0, Math.min(255, ((work[i] - lo) / (hi - lo)) * 255));
      }
      applied.push('contrast');
    }
  }

  // 4) ≤2× 放大：深底/低对比/放大候选 → 放大概率；长边 >1200 不放大（控制耗时）
  //    enlarge='off'（分流：非手写区省时）→ 跳过放大
  let outW = width;
  let outH = height;
  let pixels = work;
  const shouldEnlarge = enlarge !== 'off' && (isDark || lowContrast || enlargeCandidate) && Math.max(width, height) <= ENLARGE_MAX_EDGE;
  if (shouldEnlarge) {
    outW = width * ENLARGE_FACTOR;
    outH = height * ENLARGE_FACTOR;
    const dst = new Uint8Array(outW * outH);
    for (let y = 0; y < outH; y += 1) {
      const sy = Math.min(height - 1, y >> 1);
      for (let x = 0; x < outW; x += 1) {
        dst[y * outW + x] = pixels[sy * width + (x >> 1)];
      }
    }
    pixels = dst;
    applied.push('enlarge');
  }

  // 5) 输出 PNG（白底黑字二值/增强灰度）
  const out = new PNG({ width: outW, height: outH });
  for (let i = 0; i < outW * outH; i += 1) {
    const v = pixels[i];
    out.data[i * 4] = v;
    out.data[i * 4 + 1] = v;
    out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  const buffer = PNG.sync.write(out);
  const enhanced = applied.length > 0;
  return {
    buffer,
    applied,
    isDark,
    enhanced,
    width: outW,
    height: outH,
    reason: `stats(mean=${st.mean.toFixed(0)},std=${rawStd.toFixed(0)}) apply=[${applied.join(',')}]`
  };
}
