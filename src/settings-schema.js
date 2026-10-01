/**
 * settings-schema.js — vision-exp-tile「图像识别」设置命名空间的 schemastery 定义
 *
 * v0.3.0：在 DSH Web 设置页新增「图像识别」分区，可编辑插件全部配置并以 DSH
 * settings.yaml 持久化、运行时生效。本模块用 @deepseek-ai/schemastery 描述该
 * 命名空间的扁平字段（snake_case key），供宿主机 ctx.settings.register() 解析、
 * DSH 配置界面渲染，并给浏览器半侧 client.js 复用于字段渲染。
 *
 * 设计要点：
 *  - 字段一律用扁平 key（与 picturereader 一致），YAML 无嵌套歧义。
 *  - 枚举用 z.string().default(...)（+ description 中文，字段值域在 UI 以
 *    select 约束，真正的合法化在 config.js 的 normalizeConfig）；数值用
 *    z.number().min().max().default(...)；布尔用 z.boolean().default(...)。
 *  - 数值范围与 src/config.js 的 normalizeConfig 校验范围保持一致；但跨字段
 *    约束（如 overlap 上限依赖 block_size）仍由 normalizeConfig 统一判定。
 *  - SETTINGS_FIELDS 是 client.js 与测试共用的「扁平字段清单」，每个字段带
 *    key / type / labelKey / advanced / options / configKey / envKey 元信息：
 *      * type      — enum / number / boolean / text，决定 UI 控件类型。
 *      * advanced  — true 时折叠进「高级设置」details。
 *      * options   — enum 的可选值（供 select 渲染）。
 *      * configKey — snake_case → 配置对象（camelCase，normalizeConfig 输出）键。
 *      * envKey    — 该字段映射的环境变量（供 runtime.envFromSettings 使用）。
 *
 * @module vision-exp-tile/settings-schema
 */

import z from '@deepseek-ai/schemastery';

/** 本插件拥有的设置命名空间名（与 config.js 的 NS 保持一致）。 */
export const SETTINGS_NS = 'vision-exp-tile';

/**
 * 设置命名空间的 schemastery schema。
 *
 * resolve 顺序（dsh-settings）：schema 默认值 < composition base < 用户文档分节。
 * base 由 index.js 传入（configRaw 转 snake_case 后的对象），因此：
 * 用户设置页 > configRaw（settings.yaml）> schema 默认值。
 */
export const SettingsSchema = z.object({
  // ── 基础（advanced=false）─────────────────────────────────────────────
  ocr_engine: z
    .string()
    .default('auto')
    .description('本地 OCR 引擎：auto=优先 rapid 自动降级（默认）/ windows / paddle / rapid。映射环境变量 DSH_OCR_ENGINE，auto=不设置=自动降级'),
  preprocess: z
    .string()
    .default('auto')
    .description('OCR 前处理：auto=深底自动反色/低对比二值化/手写放大（默认）；off=关闭；auto-enlarge-off=自动+禁用手写放大'),
  handwrite_route: z
    .string()
    .default('smart')
    .description('手写路由：smart=自动判定（默认）/ visual=转视觉 API / local=本地 / off=关闭。映射环境变量 DSH_OCR_HANDWRITE'),
  upgrade: z
    .string()
    .default('full')
    .description('自动升级：full=低置信或手写或深底失败时转视觉 API 转录（默认）；low=仅低置信；off=关闭。映射环境变量 DSH_OCR_UPGRADE'),
  base_url: z
    .string()
    .default('https://api.deepseek.com')
    .description('DeepSeek 视觉 API Base URL（OpenAI 兼容 chat/completions）'),
  model: z.string().default('deepseek-v4-flash-vision-exp').description('视觉模型名'),
  api_key_env: z.string().default('DEEPSEEK_API_KEY').description('读取 DeepSeek API key 的环境变量名'),
  // ── v1.0.0 大更新③：多模态端点泛化（分组「识别与接口」）───────────────
  provider: z
    .string()
    .default('auto')
    .description('端点画像：auto=按 base_url 特征自动判定（默认）/ deepseek / openai / minimal（极简兼容）。映射环境变量 DSH_API_PROVIDER'),
  api_path: z
    .string()
    .default('')
    .description('路径覆盖（拼在 base_url 之后）；空=用画像默认 /chat/completions，可含 query（如 Azure 的 ?api-version=）。映射环境变量 DSH_API_PATH'),
  api_key: z
    .string()
    .default('')
    .description('直接填写的 API key（敏感，设置页按密码型控件渲染）；优先级高于 api_key_env，本地端点可留空。映射环境变量 DSH_API_KEY'),

  // ── 高级（advanced=true）──────────────────────────────────────────────
  extra_headers: z
    .string()
    .default('')
    .description('高级：附加/覆盖请求头（JSON 对象字符串，如 {"api-key":"..."}）；解析失败则忽略该项。映射环境变量 DSH_API_EXTRA_HEADERS'),
  extra_body: z
    .string()
    .default('')
    .description('高级：附加请求体字段（JSON 对象字符串，如 {"temperature":0.2}）；不允许覆盖 messages，解析失败则忽略该项。映射环境变量 DSH_API_EXTRA_BODY'),
  image_detail: z
    .string()
    .default('auto')
    .description('高级：图片 detail 下发策略 auto=按画像（默认）/ off=不发 / low / high / original（非 DeepSeek 画像下降级 high）。映射环境变量 DSH_IMAGE_DETAIL'),
  thinking_mode: z
    .string()
    .default('auto')
    .description('高级：thinking 下发策略 auto=仅 DeepSeek 画像下发（默认）/ on=总是下发 / off=总是不发。映射环境变量 DSH_THINKING_MODE'),
  max_tokens_field: z
    .string()
    .default('auto')
    .description('高级：token 上限字段名 auto=按画像且 400 时自动回退（默认）/ max_tokens / max_completion_tokens。映射环境变量 DSH_MAX_TOKENS_FIELD'),
  block_size: z
    .number()
    .min(64)
    .max(4096)
    .default(800)
    .description('高级：块边长（px）；800 是官方缩放甜蜜点（800×800 块不降采样、每块 ≤384 token）'),
  cut_threshold: z
    .number()
    .min(64)
    .max(8192)
    .default(800)
    .description('高级：长边超过此值才切分；800×800 及以下不切（单图可直接识别）'),
  overlap: z
    .number()
    .min(0)
    .max(2047)
    .default(0)
    .description('高级：相邻块交叠像素（0..块边长/2-1），推荐 64 防跨块切断。上限随 block_size 变，见 normalizeConfig'),
  group_size: z.number().min(1).max(240).default(40).description('高级：分层聚合模式每组最多块数'),
  max_tokens: z.number().min(256).max(65536).default(8192).description('高级：单次请求输出 token 上限'),
  timeout_ms: z.number().min(1000).max(3600000).default(300000).description('高级：单次请求超时（毫秒）'),
  format: z.string().default('png').description('高级：块格式 png=无损（默认）/ jpeg=更省请求体'),
  quality: z.number().min(40).max(100).default(90).description('高级：jpeg 质量（40..100），仅 jpeg 有效'),
  mode: z.string().default('auto').description('高级：识别模式 auto=自动 / single=单请求 / layered=分层聚合'),
  json: z.boolean().default(false).description('高级：true=要求模型输出 JSON 对象（结构化结果）'),
  with_overview: z.boolean().default(true).description('高级：是否同时生成 overview 缩略图（网格+块号，辅助全局布局）'),
  out_dir: z.string().default('').description('高级：块输出目录；空=默认原图同目录 <原名>_tiles 子目录'),
  rotate: z
    .number()
    .min(0)
    .max(270)
    .default(0)
    .description('高级：识别前顺时针旋转角度 0/90/180/270（用于"误判方向"场景）'),
  interest_concurrency: z
    .number()
    .min(1)
    .max(4)
    .default(2)
    .description('高级：兴趣点视觉识别并行数（1..4，并发大易触发 429）。映射环境变量 DSH_INTEREST_CONCURRENCY'),
  ocr_pool: z
    .number()
    .min(0)
    .max(8)
    .default(4)
    .description('高级：本地 OCR 池大小 0..8（0=禁用回退旧逻辑）。映射环境变量 DSH_OCR_POOL'),
  ocr_cache: z
    .boolean()
    .default(true)
    .description('高级：本地 OCR 结果缓存。true=启用（默认，不设环境变量）；false=设 DSH_OCR_CACHE=0 禁用'),
  ocr_preproc: z
    .boolean()
    .default(true)
    .description('高级：OCR 前处理开关。true=启用（默认，不设环境变量）；false=设 DSH_OCR_PREPROC=0 禁用'),
  // ── v1.0.0 大更新④：性能与结果缓存（分组「性能与 OCR 池」）────────────
  api_concurrency: z
    .number()
    .min(0)
    .max(4)
    .default(0)
    .description('高级：分层聚合的组间并发上限 0..4；0=自动（按算力预算，默认）。映射环境变量 DSH_API_CONCURRENCY'),
  result_cache: z
    .boolean()
    .default(true)
    .description('高级：视觉结果缓存开关（预检/区域识别）。true=启用（默认）；false=设 DSH_RESULT_CACHE=0 禁用'),
  result_cache_ttl_hours: z
    .number()
    .min(1)
    .max(8760)
    .default(168)
    .description('高级：结果缓存 TTL（小时，1..8760，默认 168=7 天）；0 视为非法 → 回落默认。映射环境变量 DSH_RESULT_CACHE_TTL_HOURS'),
  result_cache_max_mb: z
    .number()
    .min(16)
    .max(10240)
    .default(512)
    .description('高级：结果缓存体积上限（MB，16..10240，默认 512；超限按写入时间从旧到新清理）；0 视为非法 → 回落默认。映射环境变量 DSH_RESULT_CACHE_MAX_MB'),
  // ── v0.4.0：GPU 多设备加速 ────────────────────────────────────────────
  gpu_provider: z
    .string()
    .default('auto')
    .description('高级：GPU 推理 provider：auto=按设备探测（优先 cuda→dml→openvino→cpu，默认）/ cuda / dml / openvino / off（强制 CPU）。映射环境变量 DSH_OCR_GPU_PROVIDER'),
  gpu_python: z
    .string()
    .default('')
    .description('高级：GPU venv 解释器路径；空=用 ~/rapid_gpu_venv/Scripts/python.exe。映射环境变量 DSH_OCR_GPU_PYTHON'),
  gpu_device: z
    .string()
    .default('auto')
    .description('高级：GPU 设备索引（dml=D3D12 适配器索引 / cuda=GPU 索引）；auto=默认适配器（不硬选 NVIDIA）。映射环境变量 DSH_OCR_GPU_DEVICE'),
  gpu_fallback: z
    .boolean()
    .default(true)
    .description('高级：GPU 初始化/推理失败时是否回退 CPU。true=回退（默认）；false=直接报错（调试用）。映射环境变量 DSH_OCR_GPU_FALLBACK'),
  // ── v0.4.1：慢机测试自适应（可配置超时/设备档位/测试倍率/跳过声明）──────
  ocr_pool_timeout_ms: z
    .number()
    .min(20000)
    .max(1200000)
    .default(120000)
    .description('高级：OCR 池单请求超时（毫秒，20000..1200000）。较差机型可调高避免超时。映射环境变量 DSH_OCR_POOL_TIMEOUT'),
  performance_tier: z
    .string()
    .default('auto')
    .description('高级：性能档位 auto=自动探测（默认）/ fast / normal / slow（非 auto=用户强制，不应用自动推荐）。映射环境变量 DSH_OCR_PERF_TIER'),
  test_timeout_factor: z
    .number()
    .min(1)
    .max(8)
    .default(1)
    .description('高级：测试超时判定倍率（1..8；推荐 4=slow 档位默认，手动可最保守到 8）。慢机可调大，降低时序抖动导致的偶发失败。映射环境变量 VISION_TEST_TIMEOUT_FACTOR'),
  test_skip_timing: z
    .boolean()
    .default(false)
    .description('高级：跳过时序敏感断言（用户声明跳过测试）。true=跳过；false=正常执行。映射环境变量 VISION_TEST_SKIP_TIMING'),
  // ── v0.4.1 扩展：低性能设备适配增强（每项都有设置开关）────────────────
  device_benchmark: z
    .boolean()
    .default(true)
    .description('高级：设备微基准算力评级开关。true=自动跑轻量基准（约 0.4s）修正档位（默认）；false=跳过基准，档位只按 CPU/内存/GPU'),
  device_power_probe: z
    .boolean()
    .default(true)
    .description('高级：电池/低功耗探测开关。true=探测是否电池放电（默认，放电中自动应用省电推荐）；false=不探测'),
  platform_fallback: z
    .string()
    .default('auto')
    .description('高级：ARM/WSL/容器平台降级：auto=按环境自动降级（默认）/ on=强制降级 / off=关闭'),
  slow_net_adapt: z
    .boolean()
    .default(true)
    .description('高级：慢网适配开关。true=slow 档自动降低兴趣点并发并把视觉 API 超时放大到 600s（默认）；false=不应用慢网推荐'),
  device_profile: z
    .string()
    .default('')
    .description('只读：运行时设备画像摘要（自动填充，如 "CPU 4核 / 内存 8.0GB / GPU 无 → slow"，不可编辑）'),
  debug: z.boolean().default(false).description('高级：调试日志（写日志，不映射环境变量）'),
});

/**
 * 设置字段的扁平清单。
 *
/**
 * 每个字段 {key, type, labelKey, advanced, ...}；type 决定 client.js 的渲染控件。
 * 顺序即配置界面展示顺序：基础在前，高级在后（折叠）。
 * configKey / envKey 供 runtime.js 做 snake_case→camelCase 映射与 env 写入。
 *
 * v0.5.0：SETTINGS_FIELDS 已迁至 settings-fields.js（纯数据、零依赖），
 * 此处 re-export 保持 client.js / 测试的既有引用不变；本文件仍被
 * client.js 与设置页需要 schemastery 的场景依赖（标准运行时链路不加载本文件）。
 */
export { SETTINGS_FIELDS } from './settings-fields.js';


