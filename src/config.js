/**
 * config.js — vision-exp-tile 的纯 JS 配置定义与归一化校验
 *
 * 不依赖 schemastery（避免运行时 schema 解析风险）：纯 JS 对象 + 手写校验，提供「默认配置 +
 * 用户覆盖 + 合法性修正」的最小配置层；数值限定在官方 API 与切图引擎允许的安全范围内，非法
 * 取值抛 `config:` 前缀中文错误（配置阶段即暴露问题），工具 args 覆盖值也在此二次校验。
 * @module vision-exp-tile/config
 */

/** 本插件拥有的设置命名空间名（DSH Web 设置页「图像识别」分区）。 */
export const NS = 'vision-exp-tile';

/* ------------------------------- 默认配置 ------------------------------- */

/**
 * 插件默认配置。
 *
 * 取值语义：blockSize 800 = 官方缩放甜蜜点（800×800 不降采样、每块 ≤384 token）；cutThreshold
 * 800 及以下不切块；overlap 0=不交叠、推荐 64（防跨块边界文字/图形被切断）；format png=无损
 * （默认）/ jpeg 更省请求体，quality 仅 jpeg 生效（40..100，默认 90）；rotate 顺时针 0/90/180/270；
 * outDir 空串 = 原图同目录 <原名>_tiles；ocrPoolTimeoutMs 20000..1200000（默认 120s）；
 * testTimeoutFactor 1..8（slow 档推荐 4，手动最保守 8）。
 * v1.0.0 新增 12 项（键名/类型/默认值/范围以《v1.0.0-配置项契约.md》为唯一真相）：端点泛化
 * provider/apiPath/apiKey/extraHeaders/extraBody/imageDetail/thinkingMode/maxTokensField +
 * 性能与缓存 apiConcurrency/resultCache/resultCacheTtlHours/resultCacheMaxMb。
 */
export const DEFAULT_CONFIG = Object.freeze({
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  blockSize: 800,
  cutThreshold: 800,
  overlap: 0,
  groupSize: 40,
  maxTokens: 8192,
  timeoutMs: 300000,
  format: 'png',
  quality: 90,
  mode: 'auto',
  json: false,
  withOverview: true,
  outDir: '',
  rotate: 0,
  // v0.4.1：慢机测试自适应 + 低性能设备适配增强（每项可控开关）
  ocrPoolTimeoutMs: 120000,
  performanceTier: 'auto',
  testTimeoutFactor: 1,
  testSkipTiming: false,
  deviceBenchmark: true,
  devicePowerProbe: true,
  platformFallback: 'auto',
  slowNetAdapt: true,
  // ── v1.0.0 ③ 多模态端点泛化（分组「识别与接口」）──────────────────────
  // provider auto=按 base_url 判定（含 deepseek → deepseek，其余 → openai）；apiPath 空=画像
  // 默认 /chat/completions、可含 query（如 Azure 的 ?api-version=）；apiKey 空=未设置（敏感）、
  // 优先级高于 apiKeyEnv；extraHeaders/extraBody 为 JSON 对象字符串，空/非法=忽略该项，
  // extraBody 不允许覆盖 messages；imageDetail auto=按画像、off=不发、original 在非 DeepSeek
  // 画像下降级 high；thinkingMode auto=仅 DeepSeek 画像下发；maxTokensField auto=按画像+400 回退。
  provider: 'auto',
  apiPath: '',
  apiKey: '',
  extraHeaders: '',
  extraBody: '',
  imageDetail: 'auto',
  thinkingMode: 'auto',
  maxTokensField: 'auto',
  // ── v1.0.0 ④ 性能与结果缓存：apiConcurrency 0=自动（合法）；resultCacheTtlHours /
  //    resultCacheMaxMb 的 0 与越界均视为非法 → 回落默认（见 readIntSoft）。──────────
  apiConcurrency: 0,
  resultCache: true,
  resultCacheTtlHours: 168,
  resultCacheMaxMb: 512
});

/* --------------------------- 取值/校验辅助函数 --------------------------- */

/** 校验并读取 [min,max] 整数（含端点）；非整数/越界抛 `config:` 前缀中文错误。
 * @param {unknown} raw 原始值（undefined/null → fallback） @param {number} fallback 默认值
 * @param {number} min 最小（含） @param {number} max 最大（含） @param {string} key 报错键名 @returns {number} 通过校验的整数 */
function readInt(raw, fallback, min, max, key) {
  const v = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new Error(`config: ${key} 必须是 ${min}~${max} 的整数（实际：${raw === undefined ? `默认 ${fallback}` : String(raw)}）`);
  }
  return v;
}

/** 校验并读取枚举字符串（必须属于 allowed）。
 * @param {unknown} raw 原始值 @param {string} fallback 默认值 @param {string[]} allowed 允许取值
 * @param {string} key 报错键名 @returns {string} 通过校验的枚举值 */
function readEnum(raw, fallback, allowed, key) {
  const v = raw === undefined || raw === null ? fallback : String(raw);
  if (!allowed.includes(v)) {
    throw new Error(`config: ${key} 必须是 ${allowed.join('/')}（实际：${v}）`);
  }
  return v;
}

/** 校验并读取非空字符串（用于 apiKeyEnv / baseURL / model）。
 * @param {unknown} raw 原始值 @param {string} fallback 默认值 @param {string} key 报错键名
 * @returns {string} 去除首尾空白后的非空字符串 */
function readNonEmptyString(raw, fallback, key) {
  const v = String(raw === undefined || raw === null ? fallback : raw).trim();
  if (v.length === 0) {
    throw new Error(`config: ${key} 必须是非空字符串（实际为空）`);
  }
  return v;
}

/** 校验并读取「可为空」字符串（v1.0.0：apiPath / apiKey / extraHeaders / extraBody）。
 * 与 readNonEmptyString 的差别：**空串合法** =「未设置」（回落画像默认或「不发该字段」，契约 §二.3）；
 * 非字符串标量统一 String() 化后再 trim，与其它读取器同一套归一化规则。
 * @param {unknown} raw 原始值 @param {string} fallback 默认值（通常是 ''） @returns {string} 去首尾空白后的字符串（可为空串） */
function readStringAllowEmpty(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string') return raw.trim();
  // 数字/布尔等标量：与设置页（文本控件）行为一致，按字符串处理。
  const kind = typeof raw;
  if (kind === 'number' || kind === 'boolean') return String(raw);
  return fallback;
}

/** 校验整数，**非法值不抛错而是回落默认**（v1.0.0 三项数值字段用）。
 * 为什么不与 readInt 同：这三项是「配置错误不该让插件起不来」的运行期参数——apiConcurrency
 * （0..4）里 0 合法（=自动）、越界回落默认；resultCacheTtlHours（1..8760）/ resultCacheMaxMb
 * （16..10240）的 **0 视为非法** → 回落默认（契约 §二.5）。
 * @param {unknown} raw 原始值（undefined/null/'' → fallback） @param {number} fallback 默认值
 * @param {number} min 最小（含） @param {number} max 最大（含） @param {string} key debug 提示键名
 * @returns {number} 合法整数或默认值 */
function readIntSoft(raw, fallback, min, max, key) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    debugNotice(`${key} 取值非法（应为 ${min}~${max} 的整数），已回落默认 ${fallback}`);
    return fallback;
  }
  return v;
}

/** 校验「JSON 对象字符串」配置项（extraHeaders / extraBody）。容错约定（契约 §二.4）：解析失败
 * **不抛错**，按「忽略该项 + 记一条 debug 提示」处理——配置错误不该让插件起不来；返回空串即
 * 「未设置」。⚠ 提示文案**不含原始值**：这两个字段可能承载密钥（如 Azure 的 {"api-key":"..."}）。
 * @param {unknown} raw 原始值（JSON 文本） @param {string} fallback 默认值（通常是 ''）
 * @param {string} key 配置键名（debug 提示用） @returns {string} 合法的 JSON 对象字符串；非法 → '' */
function readJsonObjectString(raw, fallback, key) {
  const v = readStringAllowEmpty(raw, fallback);
  if (v === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(v);
  } catch {
    debugNotice(`${key} 不是合法 JSON，已忽略该项`);
    return '';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    debugNotice(`${key} 必须是 JSON 对象（{...}），已忽略该项`);
    return '';
  }
  return v;
}

/** 记一条配置层 debug 提示（不影响执行流）：仅 `DSH_DEBUG=1|true` 时输出，避免默认日志被配置噪声
 * 污染；与插件的 debug 设置项无关（本模块是纯函数模块，不读取运行时快照）。
 * @param {string} message 提示文案（**不得包含密钥原文**） */
function debugNotice(message) {
  const flag = String(process.env.DSH_DEBUG ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true') console.debug(`[vision-exp-tile] ${message}`);
}

/* -------------------- normalizeConfig：合并默认 + 校验/修正 -------------------- */

/**
 * 归一化配置：把用户原始配置与 {@link DEFAULT_CONFIG} 合并，并逐字段做合法性校验（非法取值
 * 抛出带 `config:` 前缀的中文错误）。
 * 边界一览：blockSize 64..4096；overlap 0..floor(blockSize/2)-1（须严格小于块边长的一半，否则
 * 块数爆炸）；cutThreshold 64..8192；groupSize 1..240；maxTokens 256..65536；timeoutMs
 * 1000..3600000；quality 40..100；format 仅 png/jpeg；mode 仅 auto/single/layered；apiKeyEnv 非空。
 * v1.0.0 新增项：provider 仅 auto/deepseek/openai/minimal、imageDetail 仅 auto/off/low/high/original、
 * thinkingMode 仅 auto/on/off、maxTokensField 仅 auto/max_tokens/max_completion_tokens（以上越界抛错）；
 * apiPath/apiKey/extraHeaders/extraBody 允许空串（JSON 非法 → 忽略该项，不抛错）；apiConcurrency
 * 0..4（0=自动，越界回落默认）；resultCache 布尔；resultCacheTtlHours 1..8760、resultCacheMaxMb
 * 16..10240（0/越界回落默认）。
 * @param {object} [raw] 用户提供的部分配置；可为 undefined / null（此时几乎全用默认值）
 * @returns {object} 校验并修正后的完整配置
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};

  // 先确定 blockSize，因为 overlap 上限依赖它。
  const blockSize = readInt(src.blockSize, DEFAULT_CONFIG.blockSize, 64, 4096, 'blockSize');
  const overlapMax = Math.floor(blockSize / 2) - 1; // 交叠必须严格小于块边长的一半
  const overlap = readInt(src.overlap, DEFAULT_CONFIG.overlap, 0, overlapMax, 'overlap');

  const cutThreshold = readInt(src.cutThreshold, DEFAULT_CONFIG.cutThreshold, 64, 8192, 'cutThreshold');
  const groupSize = readInt(src.groupSize, DEFAULT_CONFIG.groupSize, 1, 240, 'groupSize');
  const maxTokens = readInt(src.maxTokens, DEFAULT_CONFIG.maxTokens, 256, 65536, 'maxTokens');
  const timeoutMs = readInt(src.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000, 3600000, 'timeoutMs');
  const quality = readInt(src.quality, DEFAULT_CONFIG.quality, 40, 100, 'quality');

  const format = readEnum(src.format, DEFAULT_CONFIG.format, ['png', 'jpeg'], 'format');
  const mode = readEnum(src.mode, DEFAULT_CONFIG.mode, ['auto', 'single', 'layered'], 'mode');

  // baseURL / model 也做非空校验，但允许用户覆盖。
  const apiKeyEnv = readNonEmptyString(src.apiKeyEnv, DEFAULT_CONFIG.apiKeyEnv, 'apiKeyEnv');
  const baseURL = readNonEmptyString(src.baseURL, DEFAULT_CONFIG.baseURL, 'baseURL');
  const model = readNonEmptyString(src.model, DEFAULT_CONFIG.model, 'model');

  // 布尔字段允许布尔值或字符串 "true"/"false"。
  const boolVal = (v, fallback) => {
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'false') return v === 'true';
    throw new Error(`config: 布尔字段（如 json / withOverview）仅接受 true/false（实际：${String(v)}）`);
  };
  const json = boolVal(src.json, DEFAULT_CONFIG.json);
  const withOverview = boolVal(src.withOverview, DEFAULT_CONFIG.withOverview);

  // outDir 仅接受字符串；空字符串=默认「原图同目录 _tiles」。
  const outDir = typeof src.outDir === 'string' ? src.outDir : DEFAULT_CONFIG.outDir;

  // rotate 仅允许 0/90/180/270（顺时针），用于把"歪图"转正后再识别。
  const rotateRaw = src.rotate === undefined || src.rotate === null ? DEFAULT_CONFIG.rotate : Number(src.rotate);
  if (![0, 90, 180, 270].includes(rotateRaw)) {
    throw new Error(`config: rotate 必须是 0/90/180/270（实际：${String(src.rotate ?? DEFAULT_CONFIG.rotate)}）`);
  }
  const rotate = rotateRaw;

  // v0.4.1：慢机测试自适应字段。
  const ocrPoolTimeoutMs = readInt(src.ocrPoolTimeoutMs, DEFAULT_CONFIG.ocrPoolTimeoutMs, 20000, 1200000, 'ocrPoolTimeoutMs');
  const performanceTier = readEnum(src.performanceTier, DEFAULT_CONFIG.performanceTier, ['auto', 'fast', 'normal', 'slow'], 'performanceTier');
  const testTimeoutFactor = readInt(src.testTimeoutFactor, DEFAULT_CONFIG.testTimeoutFactor, 1, 8, 'testTimeoutFactor');
  const testSkipTiming = boolVal(src.testSkipTiming, DEFAULT_CONFIG.testSkipTiming);

  const deviceBenchmark = boolVal(src.deviceBenchmark, DEFAULT_CONFIG.deviceBenchmark);
  const devicePowerProbe = boolVal(src.devicePowerProbe, DEFAULT_CONFIG.devicePowerProbe);
  const platformFallback = readEnum(src.platformFallback, DEFAULT_CONFIG.platformFallback, ['auto', 'on', 'off'], 'platformFallback');
  const slowNetAdapt = boolVal(src.slowNetAdapt, DEFAULT_CONFIG.slowNetAdapt);

  // v1.0.0 ③：端点泛化——枚举越界抛错（与既有枚举一致），文本项允许空串（=未设置）。
  const provider = readEnum(src.provider, DEFAULT_CONFIG.provider, ['auto', 'deepseek', 'openai', 'minimal'], 'provider');
  const apiPath = readStringAllowEmpty(src.apiPath, DEFAULT_CONFIG.apiPath);
  const apiKey = readStringAllowEmpty(src.apiKey, DEFAULT_CONFIG.apiKey);
  const extraHeaders = readJsonObjectString(src.extraHeaders, DEFAULT_CONFIG.extraHeaders, 'extraHeaders');
  const extraBody = readJsonObjectString(src.extraBody, DEFAULT_CONFIG.extraBody, 'extraBody');
  const imageDetail = readEnum(src.imageDetail, DEFAULT_CONFIG.imageDetail, ['auto', 'off', 'low', 'high', 'original'], 'imageDetail');
  const thinkingMode = readEnum(src.thinkingMode, DEFAULT_CONFIG.thinkingMode, ['auto', 'on', 'off'], 'thinkingMode');
  const maxTokensField = readEnum(
    src.maxTokensField,
    DEFAULT_CONFIG.maxTokensField,
    ['auto', 'max_tokens', 'max_completion_tokens'],
    'maxTokensField'
  );

  // v1.0.0 ④：性能与结果缓存（0/越界的回落语义见 readIntSoft）。
  const apiConcurrency = readIntSoft(src.apiConcurrency, DEFAULT_CONFIG.apiConcurrency, 0, 4, 'apiConcurrency');
  const resultCache = boolVal(src.resultCache, DEFAULT_CONFIG.resultCache);
  const resultCacheTtlHours = readIntSoft(src.resultCacheTtlHours, DEFAULT_CONFIG.resultCacheTtlHours, 1, 8760, 'resultCacheTtlHours');
  const resultCacheMaxMb = readIntSoft(src.resultCacheMaxMb, DEFAULT_CONFIG.resultCacheMaxMb, 16, 10240, 'resultCacheMaxMb');

  return {
    apiKeyEnv,
    baseURL,
    model,
    blockSize,
    cutThreshold,
    overlap,
    groupSize,
    maxTokens,
    timeoutMs,
    format,
    quality,
    mode,
    json,
    withOverview,
    outDir,
    rotate,
    ocrPoolTimeoutMs,
    performanceTier,
    testTimeoutFactor,
    testSkipTiming,
    deviceBenchmark,
    devicePowerProbe,
    platformFallback,
    slowNetAdapt,
    provider,
    apiPath,
    apiKey,
    extraHeaders,
    extraBody,
    imageDetail,
    thinkingMode,
    maxTokensField,
    apiConcurrency,
    resultCache,
    resultCacheTtlHours,
    resultCacheMaxMb
  };
}
