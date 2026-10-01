/**
 * settings-file.js — vision-exp-tile 设置持久化（文件化，脱离宿主 settings 服务）
 *
 * 背景（v0.5.0 生态化改造）：
 *   v0.4.x 的设置经宿主 dsh-settings 的 settingsNamespace 持久化在宿主 settings.yaml，
 *   由 index.js 里 ctx.inject(['settings']) 注册并订阅热更。改造后标准插件不再持有
 *   宿主 settings 服务，设置改由本模块持久化到独立 JSON 文件：
 *
 *     <DSH_HOME 或 ~/.dsh>/vision-exp-tile.json
 *
 *   键与旧设置分区一致（snake_case，如 base_url / model / ocr_engine），因此
 *   runtime.js 的 normalizeFromSettings() / envFromSettings() 完全复用，行为不变：
 *
 *   - 热生效：runtime.js 每次 getRuntimeConfig() 惰性重读 sourceFn()；本模块在
 *     readSnapshot() 里做 mtime 缓存，文件变化时顺带同步一次进程 env（幂等），
 *     与旧「设置页改动 → scope.watch → applySettingsEnv」效果等价（下次工具调用前生效）。
 *   - 迁移：首次初始化（配置文件尚不存在）时，尝试从宿主 settings.yaml 的既有
 *     vision-exp-tile 分区一次性迁移旧设置，保住用户现有 baseURL/model 等配置。
 *   - 写回：device.js 的设备画像等写回走 setSetting()，临时文件 + rename 原子落盘。
 *
 * 本模块只 import node: 内置模块与相对模块，不依赖任何宿主包。
 *
 * @module vision-exp-tile/settings-file
 */

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { applySettingsEnv, normalizeFromSettings } from './runtime.js';

/** 目标配置键名（取自分区的 snake_case 设置键，旧设置分区可迁移的键全集）。 */
const TARGET_KEYS = [
  'base_url', 'api_key_env', 'model', 'timeout_ms', 'block_size', 'overlap',
  'cut_threshold', 'format', 'quality', 'rotate', 'with_overview',
  'preprocess', 'ocr_engine', 'handwrite_route', 'upgrade',
  'interest_concurrency', 'ocr_pool', 'ocr_cache', 'ocr_preproc',
  'gpu_provider', 'gpu_python', 'gpu_device', 'gpu_fallback',
  'device_benchmark', 'device_power_probe', 'platform_fallback', 'slow_net_adapt',
  'performance_tier', 'ocr_pool_timeout_ms', 'test_timeout_factor',
  'test_skip_timing', 'device_profile', 'debug',
  // v1.0.0 大更新③④：端点泛化 + 性能与结果缓存（新增 12 项，旧 settings.yaml 分区亦可迁移）
  'provider', 'api_path', 'api_key', 'extra_headers', 'extra_body',
  'image_detail', 'thinking_mode', 'max_tokens_field',
  'api_concurrency', 'result_cache', 'result_cache_ttl_hours', 'result_cache_max_mb'
];

/**
 * 宿主 settings.yaml 的候选位置（迁移用）。
 * ⚠ 必须每次求值（函数而非常量）：process.env.DSH_HOME 可在进程生命周期内变化
 * （测试隔离 / 宿主多 profile），模块顶层常量会在 import 时固化错误路径。
 * @returns {string[]} 候选 settings.yaml 绝对路径列表。
 */
function legacySettingsCandidates() {
  return [
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml'),
    join(homedir(), '.dsh', 'settings.yaml')
  ];
}

/* ------------------------------------------------------------------ */
/* 路径与状态                                                           */
/* ------------------------------------------------------------------ */

/** 当前配置文件绝对路径（测试可覆盖）。 */
let configPathOverride = null;
/** 最近一次读取的文件 mtime（用于检测外部改动）。 */
let lastMtime = 0;

/**
 * 取得配置文件路径。
 * @returns {string} <DSH_HOME 或 ~/.dsh>/vision-exp-tile.json
 */
export function getConfigPath() {
  if (configPathOverride) return configPathOverride;
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'vision-exp-tile.json');
}

/** 测试专用：覆盖配置路径 / 重置 mtime 缓存。 */
export function _overrideConfigPathForTest(path, reset = true) {
  configPathOverride = path;
  if (reset) lastMtime = 0;
}

/* ------------------------------------------------------------------ */
/* 读写                                                               */
/* ------------------------------------------------------------------ */

/**
 * 读取配置快照（总是重新解析文件，保证写后立即读为最新）。
 *
 * mtime 缓存仅用于判定「是否属于外部改动」：检测到 mtime 变化时，
 * 同步一次进程 env（applySettingsEnv 幂等、且绝不覆盖用户显式设置的环境变量），
 * 得到与旧「设置页热更 → env 立即生效」一致的效果。
 *
 * ⚠ 不可用 mtime 决定是否跳过解析：setSetting 写完也会把 lastMtime 对齐到新值，
 *   若据此跳过会读到旧缓存（写后立即读失效）。
 *
 * @returns {object} snake_case 设置键值对；文件不存在/损坏 → {}（上层并入默认值）。
 */
export function readSnapshot() {
  const path = getConfigPath();
  let snapshot = {};
  let isExternalChange = false;
  try {
    if (existsSync(path)) {
      const stat = statSync(path);
      isExternalChange = stat.mtimeMs !== lastMtime;
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        snapshot = parsed;
      } else {
        // 内容不是对象 → 视为损坏：不缓存 mtime，下次仍会重试。
        snapshot = {};
        isExternalChange = false;
      }
      if (isExternalChange) {
        lastMtime = stat.mtimeMs;
        // 外部改动（或本进程写回）→ 同步一次 env（幂等；用户显式 env 优先）。
        try { applySettingsEnv(snapshot); } catch { /* env 同步失败不影响设置读取 */ }
      }
    }
  } catch {
    // 文件不存在 / 解析失败：返回空对象（上层并入默认值），不抛错。
    snapshot = {};
  }
  return snapshot;
}

/**
 * 原子写回单个设置键（tmp + rename）。
 * @param {string} key - snake_case 设置键。
 * @param {unknown} value - 要写入的值；undefined 表示删除该键。
 */
export function setSetting(key, value) {
  const path = getConfigPath();
  const next = { ...readSnapshot() };
  if (value === undefined) delete next[key];
  else next[key] = value;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  // 写回后立刻刷新 mtime 缓存（对齐），避免内部写回被误判为「外部改动」反复同步 env。
  try { lastMtime = statSync(path).mtimeMs; } catch { /* 忽略 */ }
  // 本进程写回 → 主动同步一次 env（与旧「设置页 watch → applySettingsEnv」语义一致）。
  try { applySettingsEnv(next); } catch { /* env 同步失败不影响配置写回 */ }
}

/* ------------------------------------------------------------------ */
/* 迁移：宿主 settings.yaml → 独立 JSON 文件                            */
/* ------------------------------------------------------------------ */

/**
 * 兼容旧宿主 settings.yaml 分区的行级 YAML 解析（不引入 YAML 依赖）。
 * 定位顶层分区行（如 `vision-exp-tile:`），收集其下缩进更深的 key: value。
 * @param {string} content - settings.yaml 全文。
 * @param {string} section - 顶层分区名。
 * @returns {object} 该分区的键值对（值已清洗：去行内注释 / 引号 / 首尾空白）。
 */
export function parseYamlSection(content, section) {
  const lines = String(content ?? '').split(/\r?\n/);
  let secIdx = -1;
  let secIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*${section}:\\s*$`).test(lines[i])) {
      secIdx = i;
      secIndent = (/^\s*/.exec(lines[i]) || [''])[0].length;
      break;
    }
  }
  if (secIdx < 0) return {};
  const out = {};
  for (let i = secIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    const indent = (/^\s*/.exec(line) || [''])[0].length;
    if (indent <= secIndent) break;
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!TARGET_KEYS.includes(m[1])) continue;
    const cleaned = cleanYamlValue(m[2]);
    if (cleaned !== undefined) out[m[1]] = cleaned;
  }
  return out;
}

/**
 * 清洗 settings.yaml 值：去行内注释（' #'）、去成对引号、去首尾空白。
 * @param {string} raw - 原始值串。
 * @returns {string|undefined} 清洗后的值；空 → undefined。
 */
function cleanYamlValue(raw) {
  let v = String(raw ?? '');
  if (v === '') return undefined;
  const hash = v.indexOf(' #');
  if (hash >= 0) v = v.slice(0, hash);
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v.length > 0 ? v : undefined;
}

/**
 * 尝试从候选 settings.yaml 迁移旧 vision-exp-tile 分区到独立 JSON 文件。
 * 仅在配置文件尚不存在时执行一次；迁移失败静默（用默认配置继续，零配置降级）。
 */
function migrateLegacySettings() {
  if (existsSync(getConfigPath())) return;
  for (const candidate of legacySettingsCandidates()) {
    let content;
    try {
      if (!existsSync(candidate)) continue;
      content = readFileSync(candidate, 'utf8');
    } catch { continue; }
    const section = parseYamlSection(content, 'vision-exp-tile');
    if (Object.keys(section).length === 0) continue;
    try {
      // 一次性原子落盘迁移结果。
      mkdirSync(dirname(getConfigPath()), { recursive: true });
      const tmp = `${getConfigPath()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(section, null, 2)}\n`, 'utf8');
      renameSync(tmp, getConfigPath());
      try { lastMtime = statSync(getConfigPath()).mtimeMs; } catch { /* 忽略 */ }
      return; // 迁移成功，不再尝试其他候选。
    } catch { continue; }
  }
}

/* ------------------------------------------------------------------ */
/* 初始化                                                             */
/* ------------------------------------------------------------------ */

/**
 * 初始化文件化设置（替代旧 ctx.inject(['settings']) 注册段）。
 *
 * @param {object} [options]
 * @param {Function} [options.onReady] - 可选：probeDevice 异步探测完成后的回调（原逻辑在
 *   scope.watch 内做 env 重应用，本模块改为由调用方在探测完成后调 syncSettingEnv()）。
 * @returns {() => object} sourceGetter —— 返回「最新归一化配置快照」的 getter。
 */
export function initFileSettings({ onReady } = {}) {
  void onReady; // 保留参数位（调用方当前在探测完成后直接调 syncSettingEnv）
  // 1. 首次迁移旧设置（幂等：配置文件已存在则跳过）。
  migrateLegacySettings();

  // 2. 立即同步一次 env（初始设置 → 进程 env），行为与旧 applySettingsEnv(scope.get()) 一致。
  try { applySettingsEnv(readSnapshot()); } catch { /* 忽略 */ }

  // 3. sourceGetter：惰性读取最新文件快照 → 归一化。
  //    runtime.js 的 getRuntimeConfig() 每次读取都会调用本 getter，实现文件热生效。
  return () => normalizeFromSettings(readSnapshot());
}

/**
 * 立即重读文件快照并同步一次进程 env（供设备探测等异步完成后调用）。
 * @returns {object} 本次生效的 env 键值对（debug/测试用）。
 */
export function syncSettingEnv() {
  // 强制刷新 mtime 缓存（置 0 强制重读）。
  lastMtime = 0;
  try { return applySettingsEnv(readSnapshot()); } catch { return {}; }
}
