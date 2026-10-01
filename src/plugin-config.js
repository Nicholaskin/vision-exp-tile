/**
 * plugin-config.js — 宿主设置页可编辑的插件配置 schema（DSH 0.2.0 设置机制）
 *
 * 背景（v0.5.0-rc.4）：
 *   DSH 0.2.0 把设置机制整体换代为「插件 Config 的 volatile 字段投影」——
 *   `@deepseek-ai/dsh-settings` 只展示「活动且可唯一定位的 profile 条目中的
 *   volatile 字段」，客户端用 `ctx.configForms.get(<profile 条目 id>)` 读写。
 *   旧版（v0.4.x）用的 `settingsScope` 客户端 API 在 0.2.0 已被移除，
 *   因此设置页必须按新机制重写（见根目录 client.js）。
 *
 * 本模块职责：
 *   1. 声明本插件的 Config（Cordis 配置 schema）：**每个字段标 `.volatile()`**
 *      表示可在 Web 端热改并持久化到 profile 的 Cordis patch；
 *   2. **不设默认值**（这点很关键）：字段未在设置页填写时解析为 `undefined`，
 *      运行时可据此区分「用户显式设置」与「未设置」，从而正确回落到
 *      配置文件 ~/.dsh/vision-exp-tile.json、环境变量与内置默认值——
 *      即设置页是「覆盖层」，不是唯一真源。
 *
 * 字段命名：一律 snake_case，与 SETTINGS_FIELDS（src/settings-fields.js）以及
 * 配置文件键名保持一致——这样设置页写入的值可以直接并入同一套归一化流程。
 *
 * ⚠ 依赖说明：`@deepseek-ai/schemastery` 由宿主提供（宿主内自带该包）。
 *   第三方插件 import 宿主包在本 DSH 上是被支持的（同类活跃插件
 *   dsh-session-dispatch 即 import @deepseek-ai/cordis / dsh-scope / dsh-llm）。
 */
import z from '@deepseek-ai/schemastery';

/**
 * 可在设置页编辑的字段（MVP 覆盖最常用项；其余字段仍可通过配置文件与
 * 环境变量设置，后续版本按需扩充到本 schema 即可自动出现在设置页）。
 *
 * 所有字段 `.volatile()` 且**不带 default**，语义为：
 *   未填写（undefined）= 沿用配置文件/环境变量/内置默认。
 */
export const Config = z.object({
  // ── 一、识别与接口 ───────────────────────────────────────────────
  /** 视觉 API 基地址（留空 = 用内置默认 https://api.deepseek.com）。 */
  base_url: z.string().volatile(),
  /** 读取 API key 的环境变量名（默认 DEEPSEEK_API_KEY）。 */
  api_key_env: z.string().volatile(),
  /** 视觉模型名（留空 = 用内置默认）。 */
  model: z.string().volatile(),
  /** 单次视觉识别输出 token 上限。 */
  max_tokens: z.number().volatile(),
  /** 请求超时（毫秒）。 */
  timeout_ms: z.number().volatile(),
  /** pipeline 本地 OCR 引擎：auto / windows / paddle / rapid / gpu。 */
  ocr_engine: z.string().volatile(),
  /** 图片预处理：auto / off / auto-enlarge-off。 */
  preprocess: z.string().volatile(),
  /** 手写路由：smart / visual / local / off。 */
  handwrite_route: z.string().volatile(),
  /** 低置信度升级策略：full / low / off。 */
  upgrade: z.string().volatile(),

  // ── 二、切块与输出 ───────────────────────────────────────────────
  /** 切块边长（像素，官方缩放甜蜜点 800）。 */
  block_size: z.number().volatile(),
  /** 长边超过此值才切块。 */
  cut_threshold: z.number().volatile(),
  /** 相邻块交叠像素（推荐 64，防跨块切断）。 */
  overlap: z.number().volatile(),
  /** 分层聚合分组大小。 */
  group_size: z.number().volatile(),
  /** 块格式：png（无损）/ jpeg（省体积）。 */
  format: z.string().volatile(),
  /** jpeg 质量（40..100，仅 format=jpeg 有效）。 */
  quality: z.number().volatile(),
  /** 是否输出网格布局参考图（overview）。 */
  with_overview: z.boolean().volatile(),
  /** 输出目录（绝对路径，或相对源图目录的相对路径）。 */
  out_dir: z.string().volatile(),
  /** 旋转角度：0 / 90 / 180 / 270。 */
  rotate: z.number().volatile(),
  /** 请求编排模式：auto / single / layered。 */
  mode: z.string().volatile(),
  /** 是否以 JSON 结构化返回（仅 full 模式有效）。 */
  json: z.boolean().volatile(),

  // ── 三、性能与 OCR 池 ────────────────────────────────────────────
  /** 兴趣点识别 API 并行数（1..4）。 */
  interest_concurrency: z.number().volatile(),
  /** 本地 OCR 进程池大小。 */
  ocr_pool: z.number().volatile(),
  /** 是否启用 OCR 结果缓存。 */
  ocr_cache: z.boolean().volatile(),
  /** 是否启用 OCR 前预处理。 */
  ocr_preproc: z.boolean().volatile(),
  /** OCR 池单请求超时（毫秒）。 */
  ocr_pool_timeout_ms: z.number().volatile(),
  /** 性能档位：auto / fast / normal / slow。 */
  performance_tier: z.string().volatile(),

  // ── 四、GPU 加速（按需开启，默认自动回退）────────────────────────
  /** GPU 提供者：auto / cuda / dml / openvino / off。 */
  gpu_provider: z.string().volatile(),
  /** GPU 版 venv 的 python 路径（留空 = 内置约定）。 */
  gpu_python: z.string().volatile(),
  /** GPU 设备选择（留空 = 自动）。 */
  gpu_device: z.string().volatile(),
  /** GPU 失败时回退 CPU。 */
  gpu_fallback: z.boolean().volatile(),

  // ── 五、设备适配 ─────────────────────────────────────────────────
  /** 启动时跑设备基准测试（影响档位推荐）。 */
  device_benchmark: z.boolean().volatile(),
  /** 启动时探测电源（电池/交流，影响档位推荐）。 */
  device_power_probe: z.boolean().volatile(),
  /** 平台降级策略：auto / on / off。 */
  platform_fallback: z.string().volatile(),
  /** 慢网自适应。 */
  slow_net_adapt: z.boolean().volatile(),

  // ── 六、调试与测试 ───────────────────────────────────────────────
  /** 调试日志。 */
  debug: z.boolean().volatile(),
  /** 测试超时倍率（自检脚本用）。 */
  test_timeout_factor: z.number().volatile(),
  /** 测试跳过时序敏感断言。 */
  test_skip_timing: z.boolean().volatile()
});

/**
 * 从宿主传入的插件配置中提取「用户显式设置过」的字段，作为运行时配置的覆盖层。
 *
 * ⚠ volatile 语义（宿主实测）：标了 `.volatile()` 的字段，Cordis 传给 `apply` 的**不是
 * 裸值**，而是一个**可热更新的包装对象**（取当前值要调 `.get()`，宿主写入新值后就地更新）。
 * 早期版本直接把包装对象并入配置链，导致下游校验报
 * `overlap 必须是 0~399 的整数（实际: [object Object]）`——本函数因此做两件事：
 *   ① 解包：带 `.get()` 的对象先取当前值（从而拿到「设置页最新保存的值」）；
 *   ② 只收标量：字符串/数字/布尔之外的任何东西一律跳过，避免对象继续污染配置链。
 * 调用方在**每次读取配置时**都会调用本函数，因此设置页保存后无需重启即可热生效。
 *
 * @param {object|undefined} configRaw - Cordis 传入的插件配置（Config 解析结果）。
 * @returns {object} 仅含已显式设置字段的 snake_case 快照（可直接并入 settings 快照）。
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
    // ② 只接受标量；undefined / null / 空串视为「未设置」，让下层回落
    const kind = typeof value;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') continue;
    if (kind === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}
