/**
 * runtime.js — vision-exp-tile 运行时配置快照（设置合并 + env 映射）
 *
 * 宿主用 setRuntimeSource() 注入 getter，各工具 execute 时读 getRuntimeConfig() 得到「当前有效」
 * 的归一化配置，因此改设置可热生效；优先级：工具参数(显式) > 设置页 > 默认值。
 * applySettingsEnv 把设置映射写入 process.env，但绝不覆盖用户显式设置的 DSH_* 环境变量，并清理
 * 「上次由我们写入、本次已取消」的键，避免改回 auto/默认后残留旧值；normalizeFromSettings 把设置
 * 快照（snake_case）映射为 camelCase 后交 config.js 的 normalizeConfig 统一校验（保持其纯函数），
 * 再透传纯设置项供工具读取。
 * @module vision-exp-tile/runtime
 */

import { normalizeConfig, DEFAULT_CONFIG } from './config.js';
import { SETTINGS_FIELDS } from './settings-fields.js';
import { getCachedProbe, classifyTier, computeRecommendations, DEFAULT_RECOMMENDATIONS } from './device.js';

/* ------------------------------- 内部状态 ------------------------------- */

/** 当前有效配置对象（normalizeConfig 输出 + 纯设置项透传）。 */
let current = {};
/** source getter；注册后 getRuntimeConfig() 惰性重读它。 */
let sourceFn = null;

/** 受管的环境变量（只允许这些键被设置）。 */
const SETTINGS_ENV_KEYS = [
  'DSH_OCR_ENGINE',
  'DSH_OCR_HANDWRITE',
  'DSH_OCR_UPGRADE',
  'DSH_INTEREST_CONCURRENCY',
  'DSH_OCR_POOL',
  'DSH_OCR_CACHE',
  'DSH_OCR_PREPROC',
  // v0.4.0：GPU 加速相关；v0.4.1：慢机测试自适应相关
  'DSH_OCR_GPU_PROVIDER',
  'DSH_OCR_GPU_PYTHON',
  'DSH_OCR_GPU_DEVICE',
  'DSH_OCR_GPU_FALLBACK',
  'DSH_OCR_POOL_TIMEOUT',
  'DSH_OCR_PERF_TIER',
  'VISION_TEST_TIMEOUT_FACTOR',
  'VISION_TEST_SKIP_TIMING',
  // v1.0.0 ③：多模态端点泛化；④：性能与结果缓存
  'DSH_API_PROVIDER',
  'DSH_API_PATH',
  'DSH_API_KEY',
  'DSH_API_EXTRA_HEADERS',
  'DSH_API_EXTRA_BODY',
  'DSH_IMAGE_DETAIL',
  'DSH_THINKING_MODE',
  'DSH_MAX_TOKENS_FIELD',
  'DSH_API_CONCURRENCY',
  'DSH_RESULT_CACHE',
  'DSH_RESULT_CACHE_TTL_HOURS',
  'DSH_RESULT_CACHE_MAX_MB'
];

/** 模块加载时已存在的 DSH_* 值视为「用户显式设置」的基线——设置页永远不能覆盖它们（用户显式 env 优先）。 */
const userEnvBaseline = {};
for (const k of SETTINGS_ENV_KEYS) {
  if (process.env[k] !== undefined) userEnvBaseline[k] = process.env[k];
}

/** 上一次由我们写入（并因此受管理）的 env 键；用于设置回退时清理残留。 */
const appliedByUs = new Set();

/* ------------------------------ 快照读写 ------------------------------ */

/** 直接替换运行时快照（测试 / 手动；不设 source 时不会被覆盖）。
 * @param {object} [cfg] 归一化后的配置对象 */
export function setRuntimeConfig(cfg = {}) {
  current = cfg && typeof cfg === 'object' ? cfg : {};
}

/** 注册一个返回「当前设置解析后的配置对象」的 getter（宿主：() => normalizeFromSettings(scope.get())）；
 * 读取时惰性重读，保证热生效。 @param {() => object|null} fn */
export function setRuntimeSource(fn) {
  sourceFn = typeof fn === 'function' ? fn : null;
  refresh();
}

/** 若注册了 source getter，则先同步一次最新值。 */
function refresh() {
  if (sourceFn) {
    try {
      const raw = sourceFn();
      if (raw && typeof raw === 'object') current = raw;
    } catch {
      // 读取失败则沿用上次快照。
    }
  }
}

/** 读取运行时快照（返回内部引用；调用方不应修改）。
 * @returns {object} 归一化后的配置对象 */
export function getRuntimeConfig() {
  refresh();
  return current;
}

/** 测试专用：重置运行时内部状态（基线 / 已写入记录 / source / 快照）。
 * env 参数用于模拟「用户显式设置的环境变量基线」，便于确定性测试。
 * @param {object} [env] 作为用户基线的环境变量视图（缺省用 process.env） */
export function _resetRuntimeForTest(env = process.env) {
  for (const k of Object.keys(userEnvBaseline)) delete userEnvBaseline[k];
  for (const k of appliedByUs) appliedByUs.delete(k);
  for (const k of SETTINGS_ENV_KEYS) {
    if (env[k] !== undefined) userEnvBaseline[k] = env[k];
  }
  sourceFn = null;
  current = {};
}

/* --------------------------- 设置 → env 映射 --------------------------- */

/** 解析「当前生效的性能档位」（同步、无副作用）。
 * 用户显式设了 performance_tier（fast/normal/slow）→ 直接用该档位（强制档位不应用自动推荐）；
 * performance_tier 为 auto（默认/未设置）→ 用 device.js 的进程级缓存探测结果判定；尚无缓存
 * （探测尚未运行/失败）时保守返回 'normal'，避免把设备误判为 slow 而错误放宽超时。
 * @param {object} [raw] 设置快照（snake_case） @returns {'fast'|'normal'|'slow'} 生效档位 */
function effectiveTier(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const perf = String(v.performance_tier ?? 'auto').trim().toLowerCase();
  if (perf !== 'auto' && ['fast', 'normal', 'slow'].includes(perf)) return perf;
  const probe = getCachedProbe();
  return probe ? classifyTier(probe) : 'normal';
}

/** 计算「单一生效推荐」：档位推荐 + 平台降级(C) + 省电(B) + 慢网(D) 依序合并。
 * 依据设备缓存探测结果（benchScore / onBattery / platformInfo）与设置快照里的开关
 * （device_benchmark 只影响探测本身，故此处用 device_power_probe / platform_fallback / slow_net_adapt）；
 * 开关为 false 时不应用对应推荐，用户显式值仍由调用方以「显式 > 推荐 > 默认」落地。
 * @param {object} [raw] 设置快照（snake_case）
 * @returns {object} 合并后的推荐对象（含 ocrPoolTimeoutMs/ocrPool/gpuProvider/testTimeoutFactor/format/interestConcurrency/timeoutMs） */
function computeRecFor(v) {
  const tier = effectiveTier(v);
  const probe = getCachedProbe();
  return computeRecommendations({
    tier,
    onBattery: probe ? (probe.onBattery === true) : false,
    platformInfo: probe ? (probe.platformInfo ?? null) : null,
    opts: {
      usePower: v.device_power_probe !== false,
      pfMode: String(v.platform_fallback ?? 'auto'),
      useNet: v.slow_net_adapt !== false
    }
  });
}

/**
 * 把设置快照映射成「应写入 process.env 的 DSH_* 键值对」（纯计算，不写 process.env）。
 * 映射纪律：枚举 auto/默认值不生成键（交模块自动降级/默认）；数值越界/非整数则忽略（模块自行回退）；
 * 布尔 true=不设置（模块默认开）、false=显式 "0"；空串不写 env（未设置 ≠ 覆盖已有环境变量）。
 * performance_tier=auto 时按设备档位对「未显式设置」的字段应用推荐；用户显式值 > 推荐 > 默认。
 * @param {object} [raw] 设置快照（snake_case，scope.get() 的解析值）
 * @returns {Record<string,string>} env 键值对
 */
export function envFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  // 单一生效推荐：档位推荐 + 平台降级(C) + 省电(B) + 慢网(D)；各字段据此按「显式 > 推荐 > 默认」落地。
  const rec = computeRecFor(v);

  // DSH_OCR_ENGINE：auto/空=不设置（模块自动降级）。
  const engine = String(v.ocr_engine ?? 'auto').trim();
  if (engine !== '' && engine !== 'auto') out.DSH_OCR_ENGINE = engine;

  // DSH_OCR_HANDWRITE：smart=默认（也显式写入，安全）；DSH_OCR_UPGRADE：full=默认。
  const hw = String(v.handwrite_route ?? 'smart').trim();
  if (hw !== '') out.DSH_OCR_HANDWRITE = hw;
  const up = String(v.upgrade ?? 'full').trim();
  if (up !== '') out.DSH_OCR_UPGRADE = up;

  // DSH_INTEREST_CONCURRENCY（1..4）：显式值 > slow 档慢网推荐（降为 1，更稳省并发）> 不设置（默认 2）。
  const ic = Number(v.interest_concurrency);
  if (Number.isInteger(ic) && ic >= 1 && ic <= 4) {
    out.DSH_INTEREST_CONCURRENCY = String(ic);
  } else if (rec.interestConcurrency !== undefined && rec.interestConcurrency !== DEFAULT_RECOMMENDATIONS.interestConcurrency) {
    out.DSH_INTEREST_CONCURRENCY = String(rec.interestConcurrency);
  }

  // DSH_OCR_POOL（0..8）：显式值 > slow 档推荐（降为 2，更省资源防盗崩）> 不设置（默认 4）。
  const pool = Number(v.ocr_pool);
  if (Number.isInteger(pool) && pool >= 0 && pool <= 8) {
    out.DSH_OCR_POOL = String(pool);
  } else if (rec.ocrPool !== undefined && rec.ocrPool !== DEFAULT_RECOMMENDATIONS.ocrPool) {
    out.DSH_OCR_POOL = String(rec.ocrPool);
  }

  // DSH_OCR_CACHE / DSH_OCR_PREPROC：true=不设置（默认开）；false="0"。
  if (v.ocr_cache === false) out.DSH_OCR_CACHE = '0';
  if (v.ocr_preproc === false) out.DSH_OCR_PREPROC = '0';

  // v0.4.0 GPU 加速：auto/空/true 默认不设置（交模块自动探测/默认），非默认才显式写。
  // provider auto=不设置，cuda/dml/openvino/off 显式写；slow 档未显式设置时推荐 off（慢机关 GPU，
  // 避免拖慢/不稳定）；python 路径非空即写；device auto/空=不设置；fallback true=不设置（默认开）、
  // false="0"。
  const gp = String(v.gpu_provider ?? 'auto').trim();
  if (gp !== '' && gp !== 'auto') {
    out.DSH_OCR_GPU_PROVIDER = gp;
  } else if (rec.gpuProvider !== undefined && rec.gpuProvider !== DEFAULT_RECOMMENDATIONS.gpuProvider) {
    out.DSH_OCR_GPU_PROVIDER = String(rec.gpuProvider);
  }
  const gpy = String(v.gpu_python ?? '').trim();
  if (gpy !== '') out.DSH_OCR_GPU_PYTHON = gpy;
  const gdev = String(v.gpu_device ?? 'auto').trim();
  if (gdev !== '' && gdev !== 'auto') out.DSH_OCR_GPU_DEVICE = gdev;
  if (v.gpu_fallback === false) out.DSH_OCR_GPU_FALLBACK = '0';

  // ── v0.4.1 慢机测试自适应字段的 env 映射 ────────────────────────────────
  // DSH_OCR_POOL_TIMEOUT：显式值 > slow 档推荐（240000）> 不设置（模块默认 120s）。
  const timeoutRaw = Number(v.ocr_pool_timeout_ms);
  if (Number.isInteger(timeoutRaw) && timeoutRaw >= 20000 && timeoutRaw <= 1200000) {
    out.DSH_OCR_POOL_TIMEOUT = String(timeoutRaw);
  } else if (rec.ocrPoolTimeoutMs !== undefined && rec.ocrPoolTimeoutMs !== DEFAULT_RECOMMENDATIONS.ocrPoolTimeoutMs) {
    out.DSH_OCR_POOL_TIMEOUT = String(rec.ocrPoolTimeoutMs);
  }

  // DSH_OCR_PERF_TIER：性能档位（auto/空=不设置，交给模块自动探测）。
  const perf = String(v.performance_tier ?? 'auto').trim();
  if (perf !== '' && perf !== 'auto') out.DSH_OCR_PERF_TIER = perf;

  // VISION_TEST_TIMEOUT_FACTOR：显式值 > slow 档推荐（4）> 不设置（测试默认 1）。
  const ttf = Number(v.test_timeout_factor);
  if (Number.isInteger(ttf) && ttf >= 1 && ttf <= 8) {
    out.VISION_TEST_TIMEOUT_FACTOR = String(ttf);
  } else if (rec.testTimeoutFactor !== undefined && rec.testTimeoutFactor !== DEFAULT_RECOMMENDATIONS.testTimeoutFactor) {
    out.VISION_TEST_TIMEOUT_FACTOR = String(rec.testTimeoutFactor);
  }

  // VISION_TEST_SKIP_TIMING：true 写入 "1"（跳过时序敏感断言）；false 不设置。
  if (v.test_skip_timing === true) out.VISION_TEST_SKIP_TIMING = '1';

  // ── v1.0.0 ③ 端点泛化（8 项）：枚举 auto（默认）=不设置，交消费侧按画像/内置默认判定 ──
  const provider = String(v.provider ?? 'auto').trim();
  if (provider !== '' && provider !== 'auto') out.DSH_API_PROVIDER = provider;

  // 文本项：非空即写；**空串不写 env**（未设置 = 不覆盖已有环境变量，契约 §二.7）。
  const apiPath = String(v.api_path ?? '').trim();
  if (apiPath !== '') out.DSH_API_PATH = apiPath;

  /* api_key 故意不注入环境变量（v1.0.0 裁决）：① 消费侧（index.js 的 resolveApiKey）直接从
   * cfg.apiKey 读，注入 env 无人消费；② 明文写进 process.env 会扩大泄露面——宿主/子进程/异常
   * 转储都可能把它带出去；③ 需要给子进程传 key 的场景（Python OCR worker 等）本就不需要视觉端点
   * key。故 api_key 仅存在于配置对象与请求头里，用完即随作用域回收（settings-fields 的 envKey 仅作文档标注）。 */

  // JSON 文本：非空即写（合法化/容错由 config.js 的 normalizeConfig 负责）。
  const extraHeaders = String(v.extra_headers ?? '').trim();
  if (extraHeaders !== '') out.DSH_API_EXTRA_HEADERS = extraHeaders;
  const extraBody = String(v.extra_body ?? '').trim();
  if (extraBody !== '') out.DSH_API_EXTRA_BODY = extraBody;

  // 枚举：auto（=按画像）=不设置。
  const imageDetail = String(v.image_detail ?? 'auto').trim();
  if (imageDetail !== '' && imageDetail !== 'auto') out.DSH_IMAGE_DETAIL = imageDetail;
  const thinkingMode = String(v.thinking_mode ?? 'auto').trim();
  if (thinkingMode !== '' && thinkingMode !== 'auto') out.DSH_THINKING_MODE = thinkingMode;
  const maxTokensField = String(v.max_tokens_field ?? 'auto').trim();
  if (maxTokensField !== '' && maxTokensField !== 'auto') out.DSH_MAX_TOKENS_FIELD = maxTokensField;

  // ── v1.0.0 ④ 性能与结果缓存（4 项）env 映射 ────────────────────────────
  // DSH_API_CONCURRENCY：数字十进制；0 是合法值（=自动），照写以显式表达「自动」。
  const apiConc = Number(v.api_concurrency);
  if (Number.isInteger(apiConc) && apiConc >= 0 && apiConc <= 4) out.DSH_API_CONCURRENCY = String(apiConc);

  // DSH_RESULT_CACHE：布尔写 '0'/'1'；未设置（undefined）=不写 env（回落模块默认「开」）。
  if (v.result_cache === true) out.DSH_RESULT_CACHE = '1';
  else if (v.result_cache === false) out.DSH_RESULT_CACHE = '0';

  // DSH_RESULT_CACHE_TTL_HOURS（1..8760）：非法/0 不写（回落模块默认 168h）。
  const ttl = Number(v.result_cache_ttl_hours);
  if (Number.isInteger(ttl) && ttl >= 1 && ttl <= 8760) out.DSH_RESULT_CACHE_TTL_HOURS = String(ttl);

  // DSH_RESULT_CACHE_MAX_MB（16..10240）：非法/0 不写（回落模块默认 512MB）。
  const maxMb = Number(v.result_cache_max_mb);
  if (Number.isInteger(maxMb) && maxMb >= 16 && maxMb <= 10240) out.DSH_RESULT_CACHE_MAX_MB = String(maxMb);

  return out;
}

/**
 * 把设置快照转换出的 env 键值对写入 process.env（幂等）。
 * 用户显式设置（模块加载前已存在的 DSH_*）永远是最高优先级，绝不覆盖；其余按本次设置写入。
 * 若本次设置不再需要该键（如引擎改回 auto），清理掉我们上次写入的残留，避免旧值影响下次工具调用。
 * @param {object} [raw] 设置快照
 * @returns {Record<string,string>} 本次实际写入的 env 键值对（供日志/测试）
 */
export function applySettingsEnv(raw) {
  const pairs = envFromSettings(raw);
  const written = {};
  for (const k of SETTINGS_ENV_KEYS) {
    // 用户显式设置的 env 永远是最高优先级：设置页不覆盖。
    if (userEnvBaseline[k] !== undefined) continue;

    if (pairs[k] !== undefined) {
      process.env[k] = pairs[k];
      appliedByUs.add(k);
      written[k] = pairs[k];
    } else if (appliedByUs.has(k)) {
      // 设置已取消该映射（改回 auto/默认）→ 清理我们之前写入的残留。
      delete process.env[k];
      appliedByUs.delete(k);
    }
  }
  return written;
}

/* ------------------------ 设置 → 归一化配置 ------------------------ */

/**
 * 把设置快照转换为归一化配置对象。
 * 先按 SETTINGS_FIELDS.configKey 把 snake_case 设置键映射成 camelCase 配置键，交 normalizeConfig
 * 统一校验归一化（config.js 纯函数，不做任何修改）；随后透传纯设置项（preprocess / ocr_engine /
 * handwrite_route / upgrade / debug 等，不属于 config.js 的字段）供工具读取。
 * @param {object} [raw] 设置快照（scope.get() 的解析值）
 * @returns {object} 归一化后的配置对象（含纯设置项透传）
 */
export function normalizeFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};

  const candidate = {};
  for (const f of SETTINGS_FIELDS) {
    if (!f.configKey) continue;
    if (v[f.key] !== undefined) candidate[f.configKey] = v[f.key];
  }

  const cfg = normalizeConfig(candidate);

  // v0.4.1 扩展：把平台降级(C)/慢网(D) 推荐应用到「配置级」字段（format / timeoutMs）。
  // 仅在用户未显式设置时生效（用户显式 > 推荐 > 默认）；用「值等于默认」近似判定未显式设置
  // （format 默认 png、timeoutMs 默认 300000），避免把用户显式改的值覆盖掉。
  const recCfg = computeRecFor(v);
  if (recCfg.format !== undefined && cfg.format === DEFAULT_CONFIG.format) cfg.format = recCfg.format;
  if (recCfg.timeoutMs !== undefined && cfg.timeoutMs === DEFAULT_CONFIG.timeoutMs) cfg.timeoutMs = recCfg.timeoutMs;

  return {
    ...cfg,
    preprocess: String(v.preprocess ?? 'auto'),
    ocr_engine: String(v.ocr_engine ?? 'auto'),
    handwrite_route: String(v.handwrite_route ?? 'smart'),
    upgrade: String(v.upgrade ?? 'full'),
    interest_concurrency: Number.isFinite(Number(v.interest_concurrency)) ? Number(v.interest_concurrency) : 2,
    ocr_pool: Number.isFinite(Number(v.ocr_pool)) ? Number(v.ocr_pool) : 4,
    ocr_cache: v.ocr_cache === undefined ? true : Boolean(v.ocr_cache),
    ocr_preproc: v.ocr_preproc === undefined ? true : Boolean(v.ocr_preproc),
    debug: v.debug === true,
    // v0.4.0：GPU 参数透传（供工具读取）
    gpu_provider: String(v.gpu_provider ?? 'auto'),
    gpu_python: String(v.gpu_python ?? ''),
    gpu_device: String(v.gpu_device ?? 'auto'),
    gpu_fallback: v.gpu_fallback === undefined ? true : Boolean(v.gpu_fallback)
  };
}
