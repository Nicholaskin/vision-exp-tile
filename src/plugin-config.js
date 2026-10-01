/**
 * plugin-config.js — 宿主设置页可编辑的插件配置 schema（DSH 0.2.0 设置机制）
 * DSH 0.2.0 起设置页展示「profile 条目中 volatile 字段」的投影，客户端用 ctx.configForms.get(<包名>) 读写（旧
 * settingsScope API 已移除）；本模块据此声明插件 Config，**每个字段标 `.volatile()`**（可在 Web 端热改）。
 * **不设默认值**（关键）：未填写时解析为 undefined，运行时可区分「用户显式设置」与「未设置」，从而正确回落到
 * 配置文件/环境变量/内置默认——设置页是「覆盖层」，不是唯一真源；字段命名一律 snake_case（与 SETTINGS_FIELDS 及配置文件键名一致，可并入同一套归一化流程），schemastery 由宿主提供。
 * @module vision-exp-tile/plugin-config
 */
import z from '@deepseek-ai/schemastery';

/** 可在设置页编辑的字段（MVP 覆盖最常用项，其余仍可经配置文件/环境变量设置；后续扩充本 schema 即自动出现在设置页）。所有字段 `.volatile()` 且**不带 default**：未填写（undefined）= 沿用配置文件/环境变量/内置默认。 */
export const Config = z.object({
  // ── 一、识别与接口｜base_url 留空=内置默认 https://api.deepseek.com；api_key_env 默认 DEEPSEEK_API_KEY；model 留空=内置默认；max_tokens / timeout_ms 单位 token / 毫秒；
  //    image_detail auto/off/low/high/original｜thinking_mode auto/on/off（auto=仅 DeepSeek 画像下发）｜max_tokens_field auto/max_tokens/max_completion_tokens；
  //    api_path 留空=画像默认 /chat/completions（可含 query）；api_key 敏感（设置页按密码型控件渲染），留空=回落环境变量/凭据文件；
  //    extra_headers / extra_body 为 JSON 对象字符串（非法 JSON 被忽略，extra_body 不允许覆盖 messages）；枚举：provider auto/deepseek/openai/minimal｜
  //    ocr_engine auto/windows/paddle/rapid/gpu｜preprocess auto/off/auto-enlarge-off｜handwrite_route smart/visual/local/off｜upgrade full/low/off
  base_url: z.string().volatile(),
  api_key_env: z.string().volatile(),
  model: z.string().volatile(),
  max_tokens: z.number().volatile(),
  timeout_ms: z.number().volatile(),
  ocr_engine: z.string().volatile(),
  preprocess: z.string().volatile(),
  handwrite_route: z.string().volatile(),
  upgrade: z.string().volatile(),
  provider: z.string().volatile(),
  api_path: z.string().volatile(),
  api_key: z.string().volatile(),
  extra_headers: z.string().volatile(),
  extra_body: z.string().volatile(),
  image_detail: z.string().volatile(),
  thinking_mode: z.string().volatile(),
  max_tokens_field: z.string().volatile(),

  // ── 二、切块与输出｜block_size 官方缩放甜蜜点 800；cut_threshold 长边超此值才切块；overlap 推荐 64（防跨块切断）；group_size 分层聚合分组大小；format png 无损 / jpeg 省体积（quality 40..100 仅 jpeg 有效）；
  //    rotate 0/90/180/270；with_overview 输出网格布局参考图；out_dir 绝对路径或相对源图目录的相对路径；mode auto/single/layered；json 仅 full 模式有效
  block_size: z.number().volatile(),
  cut_threshold: z.number().volatile(),
  overlap: z.number().volatile(),
  group_size: z.number().volatile(),
  format: z.string().volatile(),
  quality: z.number().volatile(),
  with_overview: z.boolean().volatile(),
  out_dir: z.string().volatile(),
  rotate: z.number().volatile(),
  mode: z.string().volatile(),
  json: z.boolean().volatile(),

  // ── 三、性能与 OCR 池｜interest_concurrency 1..4（兴趣点识别 API 并行数）；ocr_pool 本地 OCR 进程池大小；performance_tier auto/fast/normal/slow；ocr_pool_timeout_ms 毫秒；
  //    api_concurrency 0..4（0=自动按算力预算）；result_cache 预检/区域识别共用；result_cache_ttl_hours 1..8760、result_cache_max_mb 16..10240（两者 0 均视为非法 → 回落默认 168h / 512MB）
  interest_concurrency: z.number().volatile(),
  ocr_pool: z.number().volatile(),
  ocr_cache: z.boolean().volatile(),
  ocr_preproc: z.boolean().volatile(),
  ocr_pool_timeout_ms: z.number().volatile(),
  performance_tier: z.string().volatile(),
  api_concurrency: z.number().volatile(),
  result_cache: z.boolean().volatile(),
  result_cache_ttl_hours: z.number().volatile(),
  result_cache_max_mb: z.number().volatile(),

  // ── 四、GPU 加速（按需开启，默认自动回退 CPU）｜gpu_provider auto/cuda/dml/openvino/off；gpu_python 留空=内置约定；gpu_device 留空=自动；gpu_fallback 失败回退 CPU
  gpu_provider: z.string().volatile(),
  gpu_python: z.string().volatile(),
  gpu_device: z.string().volatile(),
  gpu_fallback: z.boolean().volatile(),

  // ── 五、设备适配｜device_benchmark 启动基准测试、device_power_probe 探测电源（两者影响档位推荐）、platform_fallback auto/on/off、slow_net_adapt 慢网自适应。── 六、调试与测试｜debug 调试日志、test_timeout_factor 测试超时倍率（自检脚本用）、test_skip_timing 跳过时序敏感断言
  device_benchmark: z.boolean().volatile(),
  device_power_probe: z.boolean().volatile(),
  platform_fallback: z.string().volatile(),
  slow_net_adapt: z.boolean().volatile(),
  debug: z.boolean().volatile(),
  test_timeout_factor: z.number().volatile(),
  test_skip_timing: z.boolean().volatile()
});

/**
 * 从宿主传入的插件配置中提取「用户显式设置过」的字段，作为运行时配置的覆盖层。
 * ⚠ volatile 语义（宿主实测坑）：标了 `.volatile()` 的字段，Cordis 传给 `apply` 的**不是裸值**，而是**可热更新的包装
 * 对象**（取当前值要调 `.get()`）；早期版本直接把包装对象并入配置链，导致下游报 `overlap 必须是 0~399 的整数（实际:
 * [object Object]）`——故此处①带 `.get()` 的先解包取当前值（从而拿到设置页最新保存的值）；②只收标量，字符串/数字/布尔
 * 之外一律跳过；undefined / null / 空串视为「未设置」，让下层回落。调用方每次读取配置都调用本函数，故设置页保存后无需重启即热生效。
 * @param {object|undefined} configRaw Cordis 传入的插件配置（Config 解析结果）
 * @returns {object} 仅含已显式设置字段的 snake_case 快照（可直接并入 settings 快照）
 */
export function pickOverrides(configRaw) {
  if (!configRaw || typeof configRaw !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, raw] of Object.entries(configRaw)) {
    // ① 解包 volatile 包装（`.get()` 取当前值）
    let value = raw;
    if (raw && typeof raw === 'object' && typeof raw.get === 'function') {
      try { value = raw.get(); } catch { continue; }
    }
    const kind = typeof value;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') continue;
    if (kind === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}
