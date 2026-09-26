/**
 * runtime.js — vision-exp-tile 运行时配置快照（设置合并 + env 映射）
 *
 * v0.3.0：宿主侧把「图像识别」设置命名空间的最新解析值通过 setRuntimeSource()
 * 注入本模块。各工具在 execute 时读 getRuntimeConfig() 得到「当前有效」的归一化
 * 配置（camelCase，兼容 normalizeConfig 输出 + 纯设置项透传），从而做到改设置
 * 热生效，且保持优先级：工具参数(显式) > 设置页 > 默认值。
 *
 * 两种注入方式：
 *  - setRuntimeConfig(cfg)：直接替换快照（测试 / 手动）。
 *  - setRuntimeSource(fn)：注册一个返回「设置解析后配置对象的 getter」；读取时
 *    惰性重读 getter 并覆盖快照，保证设置热更立即生效。
 *
 * envFromSettings(raw)：把设置快照映射成「应写入 process.env 的 DSH_* 键值对」。
 *  applySettingsEnv(raw)：把上述键值对写入 process.env，幂等——但绝不覆盖用户
 *    显式设置的环境变量（用户在插件加载前就设的 DSH_* 值优先于设置页）；对「我们
 *    上一次写入、本次设置已取消该映射」的键会清理回读默认，避免设置改回 auto/默认
 *    后残留旧值。
 *
 * normalizeFromSettings(raw)：设置快照 → snake_case 键映射为 camelCase 配置键
 * （base_url→baseURL 等，见 settings-schema.js 的 SETTINGS_FIELDS.configKey），
 * 再交给 normalizeConfig 统一校验归一化；config.js 保持纯函数不被修改。
 *
 * v0.4.1：新增慢机测试自适应字段（ocr_pool_timeout_ms / performance_tier /
 * test_timeout_factor / test_skip_timing / device_profile）。envFromSettings 在
 * performance_tier=auto 时按设备档位（device.js 的缓存探测）对「未显式设置」的
 * OCR 池超时/池大小/GPU 关停应用推荐值；用户显式值 > tier 推荐 > 默认。
 *
 * v0.4.1 扩展：低性能设备适配增强（A 微基准 / B 电池 / C 平台降级 / D 慢网）。
 * computeRecFor(v) 汇总「单一生效推荐」——档位推荐 + 平台降级(C) + 省电(B) + 慢网(D)
 * 依序合并；envFromSettings 消费其 env 相关字段（ocrPool/ocrPoolTimeoutMs/gpuProvider/
 * testTimeoutFactor/interestConcurrency），normalizeFromSettings 消费其配置级字段
 * （format / timeoutMs）。开关（device_benchmark/device_power_probe/platform_fallback/
 * slow_net_adapt）均来自设置快照。
 *
 * @module vision-exp-tile/runtime
 */

import { normalizeConfig, DEFAULT_CONFIG } from './config.js';
import { SETTINGS_FIELDS } from './settings-fields.js';
import { getCachedProbe, classifyTier, computeRecommendations, DEFAULT_RECOMMENDATIONS } from './device.js';

/* ------------------------------------------------------------------ */
/* 内部状态                                                             */
/* ------------------------------------------------------------------ */

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
  // v0.4.0：GPU 加速相关
  'DSH_OCR_GPU_PROVIDER',
  'DSH_OCR_GPU_PYTHON',
  'DSH_OCR_GPU_DEVICE',
  'DSH_OCR_GPU_FALLBACK',
  // v0.4.1：慢机测试自适应相关
  'DSH_OCR_POOL_TIMEOUT',
  'DSH_OCR_PERF_TIER',
  'VISION_TEST_TIMEOUT_FACTOR',
  'VISION_TEST_SKIP_TIMING'
];

/**
 * 模块加载时已存在的 DSH_* 值视为「用户显式设置」的基线——设置页永远不能覆盖
 * 它们（用户显式 env 优先）。后续每次 applySettingsEnv 都会据此判断是否写入。
 */
const userEnvBaseline = {};
for (const k of SETTINGS_ENV_KEYS) {
  if (process.env[k] !== undefined) userEnvBaseline[k] = process.env[k];
}

/** 上一次由我们写入（并因此受管理）的 env 键；用于设置回退时清理残留。 */
const appliedByUs = new Set();

/* ------------------------------------------------------------------ */
/* 快照读写                                                             */
/* ------------------------------------------------------------------ */

/**
 * 直接替换运行时快照（测试 / 手动；不设 source 时不会被覆盖）。
 * @param {object} [cfg] - 归一化后的配置对象。
 */
export function setRuntimeConfig(cfg = {}) {
  current = cfg && typeof cfg === 'object' ? cfg : {};
}

/**
 * 注册一个返回「当前设置解析后的配置对象」的 getter（宿主：() => normalizeFromSettings(scope.get())）。
 * 读取时惰性重读，保证热生效。
 * @param {() => object|null} fn
 */
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

/**
 * 读取运行时快照（返回内部引用；调用方不应修改）。
 * @returns {object} 归一化后的配置对象。
 */
export function getRuntimeConfig() {
  refresh();
  return current;
}

/**
 * 测试专用：重置运行时内部状态（基线 / 已写入记录 / source / 快照）。
 * 通过 env 参数模拟「用户显式设置的环境变量基线」，便于确定性测试。
 * @param {object} [env] - 作为用户基线的环境变量视图（缺省用 process.env）。
 */
export function _resetRuntimeForTest(env = process.env) {
  for (const k of Object.keys(userEnvBaseline)) delete userEnvBaseline[k];
  for (const k of appliedByUs) appliedByUs.delete(k);
  for (const k of SETTINGS_ENV_KEYS) {
    if (env[k] !== undefined) userEnvBaseline[k] = env[k];
  }
  sourceFn = null;
  current = {};
}

/* ------------------------------------------------------------------ */
/* 设置 → env 映射                                                      */
/* ------------------------------------------------------------------ */

/**
 * 解析「当前生效的性能档位」（同步、无副作用）。
 *
 * 规则：
 *  - 用户显式设了 performance_tier（fast/normal/slow）→ 直接用该档位（强制档位不应用自动推荐）；
 *  - performance_tier 为 auto（默认/未设置）→ 用 device.js 的进程级缓存探测结果判定；
 *    尚无缓存（探测尚未运行/失败）时保守返回 'normal'，避免把设备误判为 slow 而错误放宽超时。
 *
 * @param {object} [raw] - 设置快照（snake_case）。
 * @returns {'fast'|'normal'|'slow'} 生效档位。
 */
function effectiveTier(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const perf = String(v.performance_tier ?? 'auto').trim().toLowerCase();
  if (perf !== 'auto' && ['fast', 'normal', 'slow'].includes(perf)) return perf;
  const probe = getCachedProbe();
  return probe ? classifyTier(probe) : 'normal';
}

/**
 * 计算「单一生效推荐」：档位推荐 + 平台降级(C) + 省电(B) + 慢网(D) 依序合并。
 *
 * 依据设备缓存探测结果（benchScore / onBattery / platformInfo）与设置快照里的
 * 开关（device_benchmark 仅影响探测，故此处用 device_power_probe / platform_fallback /
 * slow_net_adapt），返回合并后的推荐对象（详见 device.js computeRecommendations）。
 * 各开关为 false 时不应用对应推荐；用户显式值仍由调用方以「显式 > 推荐 > 默认」落地。
 *
 * @param {object} [raw] - 设置快照（snake_case）。
 * @returns {object} 合并后的推荐对象（含 ocrPoolTimeoutMs/ocrPool/gpuProvider/
 *   testTimeoutFactor/format/interestConcurrency/timeoutMs）。
 */
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
 * 把设置快照映射成「应写入 process.env 的 DSH_* 键值对」。
 *
 * 仅映射那些在设置页中有明确含义、且能直接落 env 的键：
 *  - 枚举：auto/默认值（=不设置，交给模块自动降级/默认）不生成键。
 *  - 数值：交叠出界/非整数则忽略（模块自行回退）。
 *  - 布尔：true=不设置（模块默认开）；false=显式 "0" 关闭。
 *
 * v0.4.1 扩展：performance_tier=auto 时按设备档位对「未显式设置」的 OCR 池超时/池大小/
 * GPU 关停/测试倍率/兴趣点并发应用推荐（用户显式值 > tier 推荐 > 默认）；新增
 * 平台降级(C)/省电(B)/慢网(D) 推荐也在此统一合并后按 env 字段落地。
 *
 * @param {object} [raw] - 设置快照（snake_case，scope.get() 的解析值）。
 * @returns {Record<string,string>} env 键值对（不写入 process.env，纯计算）。
 */
export function envFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  // v0.4.1 + 扩展：计算「单一生效推荐」——档位推荐 + 平台降级(C) + 省电(B) + 慢网(D)。
  //   - 用户显式 performance_tier（fast/normal/slow）→ 直接用该档位；
  //   - auto（默认）→ 用 device.js 的缓存探测结果判定；尚无缓存（探测未跑）时
  //     保守按 normal（不臆测慢机，避免探测失败被误判）。
  // 用户显式值 > 档位推荐 > 默认（见下述各字段的写入顺序）。开关来自设置快照。
  const rec = computeRecFor(v);

  // DSH_OCR_ENGINE：auto/空=不设置（模块自动降级）。
  const engine = String(v.ocr_engine ?? 'auto').trim();
  if (engine !== '' && engine !== 'auto') out.DSH_OCR_ENGINE = engine;

  // DSH_OCR_HANDWRITE：smart=默认（也显式写入，安全）。
  const hw = String(v.handwrite_route ?? 'smart').trim();
  if (hw !== '') out.DSH_OCR_HANDWRITE = hw;

  // DSH_OCR_UPGRADE：full=默认。
  const up = String(v.upgrade ?? 'full').trim();
  if (up !== '') out.DSH_OCR_UPGRADE = up;

  // DSH_INTEREST_CONCURRENCY（1..4）：显式值 > slow 档慢网推荐（降为 1，更稳省并发）> 不设置（默认 2）。
  const ic = Number(v.interest_concurrency);
  if (Number.isInteger(ic) && ic >= 1 && ic <= 4) {
    out.DSH_INTEREST_CONCURRENCY = String(ic);
  } else if (rec.interestConcurrency !== undefined && rec.interestConcurrency !== DEFAULT_RECOMMENDATIONS.interestConcurrency) {
    out.DSH_INTEREST_CONCURRENCY = String(rec.interestConcurrency);
  }

  // DSH_OCR_POOL（0..8）：ocr_pool_pool 显式值 > slow 档推荐（降为 2，更省资源防盗崩）> 不设置（默认 4）。
  const pool = Number(v.ocr_pool);
  if (Number.isInteger(pool) && pool >= 0 && pool <= 8) {
    out.DSH_OCR_POOL = String(pool);
  } else if (rec.ocrPool !== undefined && rec.ocrPool !== DEFAULT_RECOMMENDATIONS.ocrPool) {
    out.DSH_OCR_POOL = String(rec.ocrPool);
  }

  // DSH_OCR_CACHE：true=不设置（默认开）；false="0"。
  if (v.ocr_cache === false) out.DSH_OCR_CACHE = '0';

  // DSH_OCR_PREPROC：true=不设置（默认开）；false="0"。
  if (v.ocr_preproc === false) out.DSH_OCR_PREPROC = '0';

  // v0.4.0：GPU 加速。auto/空/true 默认不设置（交模块自动探测/默认），非默认才显式写。
  // provider：auto=不设置（自动探测）；cuda/dml/openvino/off 显式写。
  // v0.4.1：slow 档未显式设置时推荐 off（慢机关 GPU，避免拖慢/不稳定）。
  const gp = String(v.gpu_provider ?? 'auto').trim();
  if (gp !== '' && gp !== 'auto') {
    out.DSH_OCR_GPU_PROVIDER = gp;
  } else if (rec.gpuProvider !== undefined && rec.gpuProvider !== DEFAULT_RECOMMENDATIONS.gpuProvider) {
    out.DSH_OCR_GPU_PROVIDER = String(rec.gpuProvider);
  }
  // python 路径：非空即写。
  const gpy = String(v.gpu_python ?? '').trim();
  if (gpy !== '') out.DSH_OCR_GPU_PYTHON = gpy;
  // device：auto/空=不设置；其他（含数字）写。
  const gdev = String(v.gpu_device ?? 'auto').trim();
  if (gdev !== '' && gdev !== 'auto') out.DSH_OCR_GPU_DEVICE = gdev;
  // fallback：true=不设置（默认开）；false="0"。
  if (v.gpu_fallback === false) out.DSH_OCR_GPU_FALLBACK = '0';

  // ── v0.4.1：慢机测试自适应字段的 env 映射 ─────────────────────────────
  // DSH_OCR_POOL_TIMEOUT：ocr_pool_timeout_ms 显式值 > slow 档推荐（240000）> 不设置（模块默认 120s）。
  const timeoutRaw = Number(v.ocr_pool_timeout_ms);
  if (Number.isInteger(timeoutRaw) && timeoutRaw >= 20000 && timeoutRaw <= 1200000) {
    out.DSH_OCR_POOL_TIMEOUT = String(timeoutRaw);
  } else if (rec.ocrPoolTimeoutMs !== undefined && rec.ocrPoolTimeoutMs !== DEFAULT_RECOMMENDATIONS.ocrPoolTimeoutMs) {
    out.DSH_OCR_POOL_TIMEOUT = String(rec.ocrPoolTimeoutMs);
  }

  // DSH_OCR_PERF_TIER：性能档位（auto/空=不设置，交给模块自动探测）。
  const perf = String(v.performance_tier ?? 'auto').trim();
  if (perf !== '' && perf !== 'auto') out.DSH_OCR_PERF_TIER = perf;

  // VISION_TEST_TIMEOUT_FACTOR：test_timeout_factor 显式值 > slow 档推荐（4）> 不设置（测试默认 1）。
  const ttf = Number(v.test_timeout_factor);
  if (Number.isInteger(ttf) && ttf >= 1 && ttf <= 8) {
    out.VISION_TEST_TIMEOUT_FACTOR = String(ttf);
  } else if (rec.testTimeoutFactor !== undefined && rec.testTimeoutFactor !== DEFAULT_RECOMMENDATIONS.testTimeoutFactor) {
    out.VISION_TEST_TIMEOUT_FACTOR = String(rec.testTimeoutFactor);
  }

  // VISION_TEST_SKIP_TIMING：true=写入 "1"（跳过时序敏感断言）；false=不设置。
  if (v.test_skip_timing === true) out.VISION_TEST_SKIP_TIMING = '1';

  return out;
}

/**
 * 把设置快照转换为的 env 键值对写入 process.env（幂等）。
 *
 * 规则：
 *  - 用户显式设置（模块加载前已存在的 DSH_*）优先：绝不覆盖。
 *  - 其余：本次设置给出的值写入；若本次设置不再需要该键（如引擎改回
 *    auto），则清理掉我们上次写入的残留，避免旧值影响下次工具调用。
 *
 * @param {object} [raw] - 设置快照。
 * @returns {Record<string,string>} 本次实际写入的 env 键值对（供日志/测试）。
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

/* ------------------------------------------------------------------ */
/* 设置 → 归一化配置                                                    */
/* ------------------------------------------------------------------ */

/**
 * 把设置快照转换为归一化配置对象。
 *
 * 先把 snake_case 设置键映射成 camelCase 配置键（见 SETTINGS_FIELDS.configKey），
 * 交给 normalizeConfig 统一校验归一化（config.js 纯函数，不做任何修改）；随后把
 * 纯设置项（preprocess / ocr_engine / handwrite_route / upgrade / debug 等，
 * 不属于 config.js 的字段）透传附加，供工具读取。
 *
 * @param {object} [raw] - 设置快照（scope.get() 的解析值）。
 * @returns {object} 归一化后的配置对象（含纯设置项透传）。
 */
export function normalizeFromSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};

  // 1. snake_case → camelCase 的 config 键候选。
  const candidate = {};
  for (const f of SETTINGS_FIELDS) {
    if (!f.configKey) continue;
    if (v[f.key] !== undefined) candidate[f.configKey] = v[f.key];
  }

  // 2. 交给 normalizeConfig 统一校验归一化（纯函数）。
  const cfg = normalizeConfig(candidate);

  // v0.4.1 扩展：平台降级(C)/慢网(D) 推荐应用到「配置级」字段（format / timeoutMs）。
  // 仅当用户未显式设置时才生效（用户显式 > 推荐 > 默认）；用「值等于默认」近似判定未显式设置
  // （format 默认 png、timeoutMs 默认 300000），避免把用户显式改的值覆盖掉。
  const recCfg = computeRecFor(v);
  if (recCfg.format !== undefined && cfg.format === DEFAULT_CONFIG.format) cfg.format = recCfg.format;
  if (recCfg.timeoutMs !== undefined && cfg.timeoutMs === DEFAULT_CONFIG.timeoutMs) cfg.timeoutMs = recCfg.timeoutMs;

  // 3. 追加纯设置项（不经 normalizeConfig；为工具读取/调试用）。
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
