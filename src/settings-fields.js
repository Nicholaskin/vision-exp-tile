/**
 * settings-fields.js — 设置扁平字段清单（纯数据，零依赖）
 *
 * v0.5.0 生态化改造：把 SETTINGS_FIELDS 从 settings-schema.js 拆出，
 * 使运行时链路（runtime.js → settings-fields.js）不再连带加载
 * @deepseek-ai/schemastery（标准插件禁止 import 宿主包）。
 *
 * 每个字段 {key, type, labelKey, advanced, ...}；type 决定 client.js 的渲染控件。
 * 顺序即配置界面展示顺序：基础在前，高级在后（折叠）。
 * configKey / envKey 供 runtime.js 做 snake_case→camelCase 映射与 env 写入。
 *
 * 本模块只含数据，不 import 任何包。
 *
 * @module vision-exp-tile/settings-fields
 */

export const SETTINGS_FIELDS = [
  // 基础
  { key: 'ocr_engine', type: 'enum', labelKey: 'ocrEngine', advanced: false, options: ['auto', 'windows', 'paddle', 'rapid', 'gpu'], envKey: 'DSH_OCR_ENGINE' },
  { key: 'preprocess', type: 'enum', labelKey: 'preprocess', advanced: false, options: ['auto', 'off', 'auto-enlarge-off'] },
  { key: 'handwrite_route', type: 'enum', labelKey: 'handwriteRoute', advanced: false, options: ['smart', 'visual', 'local', 'off'], envKey: 'DSH_OCR_HANDWRITE' },
  { key: 'upgrade', type: 'enum', labelKey: 'upgrade', advanced: false, options: ['full', 'low', 'off'], envKey: 'DSH_OCR_UPGRADE' },
  { key: 'base_url', type: 'text', labelKey: 'baseUrl', advanced: false, configKey: 'baseURL' },
  { key: 'model', type: 'text', labelKey: 'model', advanced: false, configKey: 'model' },
  { key: 'api_key_env', type: 'text', labelKey: 'apiKeyEnv', advanced: false, configKey: 'apiKeyEnv' },
  // v1.0.0 大更新③：多模态端点泛化（分组「识别与接口」；契约《v1.0.0-配置项契约.md》）
  { key: 'provider', type: 'enum', labelKey: 'provider', advanced: false, options: ['auto', 'deepseek', 'openai', 'minimal'], configKey: 'provider', envKey: 'DSH_API_PROVIDER' },
  { key: 'api_path', type: 'text', labelKey: 'apiPath', advanced: false, configKey: 'apiPath', envKey: 'DSH_API_PATH' },
  // secret:true —— 敏感项（设置页密码控件，日志打码），非通用元信息，仅供 UI 参考
  { key: 'api_key', type: 'text', labelKey: 'apiKey', advanced: false, configKey: 'apiKey', envKey: 'DSH_API_KEY', secret: true },
  // 高级
  // v1.0.0 大更新③：端点泛化的高级逃生口（JSON 文本 / 厂商专有字段下发策略）
  { key: 'extra_headers', type: 'text', labelKey: 'extraHeaders', advanced: true, configKey: 'extraHeaders', envKey: 'DSH_API_EXTRA_HEADERS', secret: true },
  { key: 'extra_body', type: 'text', labelKey: 'extraBody', advanced: true, configKey: 'extraBody', envKey: 'DSH_API_EXTRA_BODY' },
  { key: 'image_detail', type: 'enum', labelKey: 'imageDetail', advanced: true, options: ['auto', 'off', 'low', 'high', 'original'], configKey: 'imageDetail', envKey: 'DSH_IMAGE_DETAIL' },
  { key: 'thinking_mode', type: 'enum', labelKey: 'thinkingMode', advanced: true, options: ['auto', 'on', 'off'], configKey: 'thinkingMode', envKey: 'DSH_THINKING_MODE' },
  { key: 'max_tokens_field', type: 'enum', labelKey: 'maxTokensField', advanced: true, options: ['auto', 'max_tokens', 'max_completion_tokens'], configKey: 'maxTokensField', envKey: 'DSH_MAX_TOKENS_FIELD' },
  { key: 'block_size', type: 'number', labelKey: 'blockSize', advanced: true, configKey: 'blockSize' },
  { key: 'cut_threshold', type: 'number', labelKey: 'cutThreshold', advanced: true, configKey: 'cutThreshold' },
  { key: 'overlap', type: 'number', labelKey: 'overlap', advanced: true, configKey: 'overlap' },
  { key: 'group_size', type: 'number', labelKey: 'groupSize', advanced: true, configKey: 'groupSize' },
  { key: 'max_tokens', type: 'number', labelKey: 'maxTokens', advanced: true, configKey: 'maxTokens' },
  { key: 'timeout_ms', type: 'number', labelKey: 'timeoutMs', advanced: true, configKey: 'timeoutMs' },
  { key: 'format', type: 'enum', labelKey: 'format', advanced: true, options: ['png', 'jpeg'], configKey: 'format' },
  { key: 'quality', type: 'number', labelKey: 'quality', advanced: true, configKey: 'quality' },
  { key: 'mode', type: 'enum', labelKey: 'mode', advanced: true, options: ['auto', 'single', 'layered'], configKey: 'mode' },
  { key: 'json', type: 'boolean', labelKey: 'json', advanced: true, configKey: 'json' },
  { key: 'with_overview', type: 'boolean', labelKey: 'withOverview', advanced: true, configKey: 'withOverview' },
  { key: 'out_dir', type: 'text', labelKey: 'outDir', advanced: true, configKey: 'outDir' },
  { key: 'rotate', type: 'enum', labelKey: 'rotate', advanced: true, options: ['0', '90', '180', '270'], configKey: 'rotate' },
  { key: 'interest_concurrency', type: 'number', labelKey: 'interestConcurrency', advanced: true, configKey: 'interestConcurrency', envKey: 'DSH_INTEREST_CONCURRENCY' },
  { key: 'ocr_pool', type: 'number', labelKey: 'ocrPool', advanced: true, configKey: 'ocrPool', envKey: 'DSH_OCR_POOL' },
  { key: 'ocr_cache', type: 'boolean', labelKey: 'ocrCache', advanced: true, configKey: 'ocrCache', envKey: 'DSH_OCR_CACHE' },
  { key: 'ocr_preproc', type: 'boolean', labelKey: 'ocrPreproc', advanced: true, configKey: 'ocrPreproc', envKey: 'DSH_OCR_PREPROC' },
  // v1.0.0 大更新④：性能与结果缓存（分组「性能与 OCR 池」）
  { key: 'api_concurrency', type: 'number', labelKey: 'apiConcurrency', advanced: true, configKey: 'apiConcurrency', envKey: 'DSH_API_CONCURRENCY' },
  { key: 'result_cache', type: 'boolean', labelKey: 'resultCache', advanced: true, configKey: 'resultCache', envKey: 'DSH_RESULT_CACHE' },
  { key: 'result_cache_ttl_hours', type: 'number', labelKey: 'resultCacheTtlHours', advanced: true, configKey: 'resultCacheTtlHours', envKey: 'DSH_RESULT_CACHE_TTL_HOURS' },
  { key: 'result_cache_max_mb', type: 'number', labelKey: 'resultCacheMaxMb', advanced: true, configKey: 'resultCacheMaxMb', envKey: 'DSH_RESULT_CACHE_MAX_MB' },
  // v0.4.0：GPU 多设备加速
  { key: 'gpu_provider', type: 'enum', labelKey: 'gpuProvider', advanced: true, options: ['auto', 'cuda', 'dml', 'openvino', 'off'], envKey: 'DSH_OCR_GPU_PROVIDER', configKey: 'gpuProvider' },
  { key: 'gpu_python', type: 'text', labelKey: 'gpuPython', advanced: true, envKey: 'DSH_OCR_GPU_PYTHON', configKey: 'gpuPython' },
  { key: 'gpu_device', type: 'text', labelKey: 'gpuDevice', advanced: true, envKey: 'DSH_OCR_GPU_DEVICE', configKey: 'gpuDevice' },
  { key: 'gpu_fallback', type: 'boolean', labelKey: 'gpuFallback', advanced: true, envKey: 'DSH_OCR_GPU_FALLBACK', configKey: 'gpuFallback' },
  // v0.4.1：慢机测试自适应（device_profile 是只读展示字段：无 configKey/envKey）
  { key: 'ocr_pool_timeout_ms', type: 'number', labelKey: 'ocrPoolTimeoutMs', advanced: true, configKey: 'ocrPoolTimeoutMs', envKey: 'DSH_OCR_POOL_TIMEOUT' },
  { key: 'performance_tier', type: 'enum', labelKey: 'performanceTier', advanced: true, options: ['auto', 'fast', 'normal', 'slow'], envKey: 'DSH_OCR_PERF_TIER', configKey: 'performanceTier' },
  { key: 'test_timeout_factor', type: 'number', labelKey: 'testTimeoutFactor', advanced: true, configKey: 'testTimeoutFactor', envKey: 'VISION_TEST_TIMEOUT_FACTOR' },
  { key: 'test_skip_timing', type: 'boolean', labelKey: 'testSkipTiming', advanced: true, configKey: 'testSkipTiming', envKey: 'VISION_TEST_SKIP_TIMING' },
  // v0.4.1 扩展：低性能设备适配增强（每项都有设置开关）
  { key: 'device_benchmark', type: 'boolean', labelKey: 'deviceBenchmark', advanced: true, configKey: 'deviceBenchmark' },
  { key: 'device_power_probe', type: 'boolean', labelKey: 'devicePowerProbe', advanced: true, configKey: 'devicePowerProbe' },
  { key: 'platform_fallback', type: 'enum', labelKey: 'platformFallback', advanced: true, options: ['auto', 'on', 'off'], configKey: 'platformFallback' },
  { key: 'slow_net_adapt', type: 'boolean', labelKey: 'slowNetAdapt', advanced: true, configKey: 'slowNetAdapt' },
  { key: 'device_profile', type: 'text', labelKey: 'deviceProfile', advanced: true, readonly: true },
  { key: 'debug', type: 'boolean', labelKey: 'debug', advanced: true },
];
