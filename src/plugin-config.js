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
  /** 视觉 API 基地址（留空 = 用内置默认 https://api.deepseek.com）。 */
  base_url: z.string().volatile(),
  /** 读取 API key 的环境变量名（默认 DEEPSEEK_API_KEY）。 */
  api_key_env: z.string().volatile(),
  /** 视觉模型名（留空 = 用内置默认）。 */
  model: z.string().volatile(),
  /** 单次视觉识别输出 token 上限。 */
  max_tokens: z.number().volatile(),
  /** 切块边长（像素，官方缩放甜蜜点 800）。 */
  block_size: z.number().volatile(),
  /** 长边超过此值才切块。 */
  cut_threshold: z.number().volatile(),
  /** 相邻块交叠像素（推荐 64，防跨块切断）。 */
  overlap: z.number().volatile(),
  /** 块格式：png（无损）/ jpeg（省体积）。 */
  format: z.string().volatile(),
  /** jpeg 质量（40..100，仅 format=jpeg 有效）。 */
  quality: z.number().volatile(),
  /** 是否输出网格布局参考图（overview）。 */
  with_overview: z.boolean().volatile(),
  /** pipeline 模式的本地 OCR 引擎：auto / paddle / rapid / windows。 */
  ocr_engine: z.string().volatile(),
  /** 输出目录（绝对路径，或相对源图目录的相对路径）。 */
  out_dir: z.string().volatile()
});

/**
 * 从宿主传入的插件配置中提取「用户显式设置过」的字段（忽略 undefined）。
 *
 * 用途：设置页写入的值要作为**最高优先级覆盖层**并入运行时配置链
 * （见 src/index.js 的 sourceGetter 组装），因此必须先剔除未填写的键，
 * 否则 schema 上的空值会盖掉配置文件中的有效设置。
 *
 * @param {object|undefined} configRaw - Cordis 传入的插件配置（Config 解析结果）。
 * @returns {object} 仅含已显式设置字段的 snake_case 快照（可直接并入 settings 快照）。
 */
export function pickOverrides(configRaw) {
  if (!configRaw || typeof configRaw !== 'object') return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(configRaw)) {
    // 只收标量/简单值；undefined 视为「未设置」，字符串空值也视为未设置（设置页清空 = 回落）
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}
