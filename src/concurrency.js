/**
 * concurrency.js — 并发调度与算力预算（零依赖；纯函数 + 轻量调度器）
 *
 * 供三处复用：pipeline（文字区/兴趣点）、vision-client（layered 组间并发）、batch（多图并发）。
 *
 * 设计要点：
 *  - `mapLimit`：滑动窗口调度，完成一个立即补位；**保序返回**（下游按组序拼接依赖下标一致）；
 *  - `onError`：默认 throw；'collect' 时把错误放进结果数组（批量：单图失败不中断整批）；
 *  - 全局 API 闸门：额度跨调用共享，防「批量图级 × 图内」并发叠乘打爆端点；
 *  - `resolveBudget`：把「性能档位 + 逻辑核数 + 显式值」折算成并发参数（CPU 路径按核数设计）。
 *
 * 只 import `node:os`，不依赖任何宿主包。
 *
 * @module vision-exp-tile/concurrency
 */

import { cpus } from 'node:os';

/**
 * 读取本机逻辑核数（失败时保守返回 4）。
 * @returns {number} 逻辑核数（≥1）
 */
export function cpuCount() {
  try {
    const n = cpus()?.length ?? 0;
    return Number.isFinite(n) && n > 0 ? n : 4;
  } catch {
    return 4; // 极端环境（受限沙箱）取保守值
  }
}

/**
 * 滑动窗口并发映射：最多 limit 个任务同时在跑，任一完成立即补位。
 *
 * @template T, R
 * @param {Array<T>} items - 待处理项（可为空数组）
 * @param {number} limit - 并发上限（≤0 或非有限值时按 1 处理；上限不超过 items.length）
 * @param {(item: T, index: number) => Promise<R>} fn - 处理函数
 * @param {object} [opts] - 选项
 * @param {'throw'|'collect'} [opts.onError='throw'] - 错误策略：
 *        'throw'   = 第一个错误立即向上抛（旧行为，工具类调用用）
 *        'collect' = 错误对象放进结果数组（批量用，单点失败不影响整批）
 * @returns {Promise<Array<R|Error>>} 结果数组（下标与输入一致；collect 模式下失败项为 Error 实例）
 */
export async function mapLimit(items, limit, fn, opts = {}) {
  const { onError = 'throw' } = opts;
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  // 归一化并发数：非有限/≤0 → 1；不超过任务数
  const raw = Number(limit);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  const workers = Math.min(Math.max(1, n), list.length);

  const results = new Array(list.length);
  let cursor = 0; // 共享游标：JS 单线程，读取+自增之间无 await，天然安全

  const runWorker = async () => {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = await fn(list[idx], idx);
      } catch (error) {
        if (onError === 'collect') {
          results[idx] = error instanceof Error ? error : new Error(String(error));
        } else {
          throw error; // Promise.all 会把该错误冒泡给调用方
        }
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, runWorker));
  return results;
}

/**
 * 兼容旧导出：pipeline.js 历史方法名（串行循环改并发时引入，测试与既有调用方沿用）。
 * 语义等价于 `mapLimit(items, limit, fn)`（错误向上抛）。
 *
 * @template T, R
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<R>>}
 */
export async function runConcurrent(items, limit, fn) {
  return mapLimit(items, limit, fn);
}

/* ------------------------------------------------------------------ */
/* 全局 API 闸门                                                        */
/* ------------------------------------------------------------------ */

/**
 * 跨调用共享的 API 并发额度（v1.0.0）。
 *
 * 为什么需要：并发是**会叠乘**的——批量工具开 2 路图级并发，每张图内部 pipeline
 * 又开 3~6 路 OCR/兴趣点并发，再叠上分层聚合的组间并发，瞬时请求数可达十几路，
 * 直接把端点打成 429（然后退避重试，越重试越慢）。
 * 闸门把「所有对端点的请求」收敛到一个全局额度内，各层只负责自己的局部并发。
 *
 * 语义：
 *  - limit = 0 → 不限制（等价旧行为，供测试/特殊场景）；
 *  - 默认 6：单图调用（最多 1~4 路）几乎不受影响，批量叠乘时被有效收敛；
 *  - FIFO 等待队列，保证先到先服务，不产生饥饿。
 */
const gate = {
  limit: Number.isFinite(Number(process.env.DSH_API_GATE)) && Number(process.env.DSH_API_GATE) >= 0
    ? Math.floor(Number(process.env.DSH_API_GATE))
    : 6,
  active: 0,
  queue: []
};

/** 唤醒等待者：按 FIFO 补位到额度上限 */
function drainGate() {
  while (gate.limit > 0 && gate.queue.length > 0 && gate.active < gate.limit) {
    gate.active += 1;
    const next = gate.queue.shift();
    next();
  }
}

/**
 * 设置全局闸门额度（0 = 不限制）。配置变化时调用即可。
 * @param {number} limit - 并发额度
 */
export function setApiGate(limit) {
  const n = Number(limit);
  gate.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  drainGate();
}

/** 当前闸门状态（诊断用：报告里可解释"为什么被排队"） */
export function apiGateStats() {
  return { limit: gate.limit, active: gate.active, waiting: gate.queue.length };
}

/**
 * 申请一个 API 名额（额度用满时挂起等待）。
 * @returns {Promise<void>}
 */
export function acquireApiSlot() {
  if (gate.limit === 0) return Promise.resolve();
  if (gate.active < gate.limit) {
    gate.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { gate.queue.push(resolve); });
}

/** 归还一个 API 名额（必须在 finally 里调用，否则额度泄漏会让后续请求永久排队） */
export function releaseApiSlot() {
  if (gate.limit === 0) return;
  gate.active = Math.max(0, gate.active - 1);
  drainGate();
}

/* ------------------------------------------------------------------ */
/* 算力预算表                                                           */
/* ------------------------------------------------------------------ */

/**
 * 性能档位 → 并发参数基线。
 *
 * 依据（本机实测与项目踩坑）：
 *  - 视觉 API 并发：DeepSeek 无硬性并发上限，但过高会触发 429 抖动 → 基线保守取 2~3；
 *  - 本地 OCR 池：单进程池占用可观内存（PaddleOCR 模型 ~800MB 级），核多也不宜开太猛；
 *  - 图级并发：每张图内部已有 OCR 并发，图级再乘会叠乘 → 基线 1~2。
 *
 * @type {Record<'fast'|'normal'|'slow', {api:number, image:number, ocr:number}>}
 */
const TIER_BASELINE = {
  fast: { api: 3, image: 2, ocr: 4 },
  normal: { api: 2, image: 1, ocr: 2 },
  slow: { api: 1, image: 1, ocr: 1 }
};

/**
 * 按逻辑核数推断性能档位。
 *  - ≥12 逻辑核 → fast
 *  - ≥4  逻辑核 → normal
 *  - 其余        → slow
 * @param {number} [cores] - 逻辑核数（默认自动探测）
 * @returns {'fast'|'normal'|'slow'}
 */
export function tierOf(cores = cpuCount()) {
  const n = Number.isFinite(cores) && cores > 0 ? cores : 4;
  if (n >= 12) return 'fast';
  if (n >= 4) return 'normal';
  return 'slow';
}

/**
 * 解析并发预算：显式配置 > 性能档位基线。
 *
 * @param {object} [opts]
 * @param {string} [opts.performanceTier='auto'] - 'auto'|'fast'|'normal'|'slow'
 * @param {number} [opts.cores] - 逻辑核数（默认自动探测，测试可注入）
 * @param {number} [opts.apiConcurrency] - 显式 API 并发（vision_tile_recognize 组间并发）
 * @param {number} [opts.imageConcurrency] - 显式图级并发（批量工具）
 * @param {number} [opts.ocrPool] - 显式 OCR 池大小
 * @param {number} [opts.maxApi=4] 上限保护：API 并发永远不超过该值
 * @param {number} [opts.maxImage=4] 上限保护：图级并发永远不超过该值
 * @param {number} [opts.maxOcr=8] 上限保护：OCR 池永远不超过该值
 * @returns {{tier:string, cores:number, api:number, image:number, ocr:number, source:string}}
 *          source 标明来源（explicit / tier），便于报告里解释"为什么是这个并发"
 */
export function resolveBudget(opts = {}) {
  const cores = Number.isFinite(opts.cores) && opts.cores > 0 ? opts.cores : cpuCount();
  const tierRaw = String(opts.performanceTier ?? 'auto');
  const tier = ['fast', 'normal', 'slow'].includes(tierRaw) ? tierRaw : tierOf(cores);
  const base = TIER_BASELINE[tier] ?? TIER_BASELINE.normal;

  const maxApi = Number(opts.maxApi ?? 4);
  const maxImage = Number(opts.maxImage ?? 4);
  const maxOcr = Number(opts.maxOcr ?? 8);

  // 显式值优先；未给（undefined/NaN/≤0）→ 用档位基线
  const pick = (explicit, fallback, cap) => {
    const v = Number(explicit);
    const use = Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
    return { value: Math.min(use, cap), explicit: Number.isFinite(v) && v > 0 };
  };
  const api = pick(opts.apiConcurrency, base.api, maxApi);
  const image = pick(opts.imageConcurrency, base.image, maxImage);
  const ocr = pick(opts.ocrPool, base.ocr, maxOcr);

  const explicitCount = [api.explicit, image.explicit, ocr.explicit].filter(Boolean).length;
  const source = explicitCount === 0 ? 'tier' : explicitCount === 3 ? 'explicit' : 'mixed';

  return { tier, cores, api: api.value, image: image.value, ocr: ocr.value, source };
}
