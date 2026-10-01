/**
 * api-profile.js — 端点画像（多模态端点泛化核心；纯函数 / 零依赖 / 可单测）
 *
 * 把「一家厂商一套写死参数」变成「配置驱动的请求画像」，使同一套识别代码可跑在
 * DeepSeek / OpenAI / 本地 vLLM·Ollama·LM Studio / 国内各厂商的 OpenAI 兼容端点上。
 *
 * 三条实测硬结论（来源与逐家矩阵见《v1.0.0-设计与验证.md》，此处不展开）：
 *   1. 通用集只有 `model` + `messages` + `image_url` + `max_tokens`；`thinking` / `reasoning_effort` /
 *      `detail` / `stream_options` 都是厂商专有（已确证多处「发了就 400」）⇒ **默认不发**，按画像开启。
 *   2. 路径不能统一补 `/v1` ⇒ 只拼画像路径，并留「用户给完整 URL / api_path」逃生口。
 *   3. `detail` 共同安全子集只有 `low`/`high` ⇒ 非 DeepSeek 画像把 `original` 降级为 `high`。
 *
 * 回归红线：DeepSeek 画像的请求体必须与 v0.5.0 **逐字段一致**。
 * 本模块只做「描述」不发请求——请求由 vision-client.js 按描述组装。
 *
 * @module vision-exp-tile/api-profile
 */

/* ------------------------------------------------------------------ */
/* 画像定义                                                             */
/* ------------------------------------------------------------------ */

/**
 * 内置画像表。字段含义：`path` 路径（可被 api_path 覆盖）｜`auth` 认证方式｜
 * `requiresKey` 是否强制要 key（本地端点 false）｜`supports` 专有字段开关（关=不发）｜
 * `detailMap` 语义→端点取值（undefined=不发）｜`maxTokensField` token 上限字段名。
 */
export const PROFILES = Object.freeze({
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    path: '/chat/completions',
    auth: 'bearer',
    requiresKey: true,
    supports: { detail: true, thinking: true, reasoningEffort: false, responseFormat: true, streamOptions: false },
    // DeepSeek 是唯一认 original/auto 的画像 → 原样透传（保持 v0.5.0 行为逐字段一致）
    detailMap: { low: 'low', high: 'high', original: 'original', auto: 'auto' },
    maxTokensField: 'max_tokens'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容',
    path: '/chat/completions',
    auth: 'bearer',
    requiresKey: false, // 本地端点（vLLM/Ollama/LM Studio）常常不需要 key
    supports: { detail: true, thinking: false, reasoningEffort: false, responseFormat: false, streamOptions: false },
    // 只发共同安全子集；original 不是通用枚举 → 降级为 high
    detailMap: { low: 'low', high: 'high', original: 'high', auto: undefined },
    maxTokensField: 'max_tokens'
  },
  /** 极简画像：只发 minimum viable body（给最挑剔/最古老的端点兜底） */
  minimal: {
    id: 'minimal',
    label: '极简兼容',
    path: '/chat/completions',
    auth: 'bearer',
    requiresKey: false,
    supports: { detail: false, thinking: false, reasoningEffort: false, responseFormat: false, streamOptions: false },
    detailMap: { low: undefined, high: undefined, original: undefined, auto: undefined },
    maxTokensField: 'max_tokens'
  }
});

/** 合法画像 id（配置校验用） */
export const PROFILE_IDS = Object.freeze(['auto', 'deepseek', 'openai', 'minimal']);

/**
 * 自动判定画像：按 baseURL 特征识别。
 *  - 含 `deepseek`     → deepseek
 *  - 含 `localhost` / `127.0.0.1` / `0.0.0.0` → openai（本地 OpenAI 兼容端，最常见的形态）
 *  - 其他（含 openai.com 与国内厂商）→ openai（保守：不发专有字段）
 * @param {string} baseURL - 端点根地址
 * @returns {'deepseek'|'openai'}
 */
export function detectProfileId(baseURL) {
  const s = String(baseURL ?? '').toLowerCase();
  if (s.includes('deepseek')) return 'deepseek';
  return 'openai';
}

/**
 * 解析画像 id（显式配置优先，'auto'/非法 → 自动判定）。
 * @param {string} [configured] - 配置里的 provider 值
 * @param {string} baseURL - 端点根地址
 * @returns {string} 画像 id（一定存在于 PROFILES）
 */
export function resolveProfileId(configured, baseURL) {
  const raw = String(configured ?? 'auto').trim().toLowerCase();
  if (raw && raw !== 'auto' && PROFILES[raw]) return raw;
  return detectProfileId(baseURL);
}

/* ------------------------------------------------------------------ */
/* URL / 认证                                                           */
/* ------------------------------------------------------------------ */

/**
 * 拼接请求 URL。
 *  - baseURL 末尾斜杠会被去掉；
 *  - 若 baseURL 本身已以 `/chat/completions` 结尾（用户直接给了完整 URL）→ 不再追加路径；
 *  - apiPath 可为空（用画像默认），也可带 query（如 `?api-version=2024-10-21`）。
 * @param {string} baseURL - 端点根地址（或完整 URL）
 * @param {string} [apiPath] - 路径覆盖
 * @param {object} [profile] - 画像（提供默认 path）
 * @returns {string} 最终 URL
 */
export function composeUrl(baseURL, apiPath, profile) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  const explicit = String(apiPath ?? '').trim();
  const path = explicit.length > 0 ? explicit : (profile?.path ?? '/chat/completions');
  if (/\/chat\/completions$/i.test(base) || /\/api\/chat$/i.test(base)) return base;
  return `${base}${path.startsWith('/') || path.startsWith('?') ? '' : '/'}${path}`;
}

/**
 * 构造认证头。
 * 规则：extraHeaders 中的同名头（大小写不敏感）**优先**——用户显式配置永远压过画像默认。
 * @param {object} profile - 画像
 * @param {string} [apiKey] - API key（可空：本地端点常态）
 * @param {object} [extraHeaders] - 用户附加/覆盖头
 * @returns {Record<string,string>} 请求头（已含 content-type）
 */
export function buildHeaders(profile, apiKey, extraHeaders = {}) {
  const headers = { 'content-type': 'application/json' };
  const extra = sanitizeHeaders(extraHeaders);
  // 用户是否自己提供了认证头（authorization / api-key / x-api-key）
  // —— 提供了就让位：否则 Azure 这类「有 api-key 就不认 Bearer」的端点会收到两个认证头而报错
  const hasOwnAuth = Object.keys(extra).some((k) => /^(authorization|api-key|x-api-key)$/i.test(k));
  const key = String(apiKey ?? '').trim();
  if (key.length > 0 && !hasOwnAuth) {
    if (profile?.auth === 'api-key') headers['api-key'] = key;
    else if (profile?.auth !== 'none') headers.authorization = `Bearer ${key}`;
  }
  // 用户附加头：同名覆盖（含自定义认证头，如 Azure 的 api-key）
  for (const [k, v] of Object.entries(extra)) {
    const existing = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
    if (existing) delete headers[existing];
    headers[k] = v;
  }
  return headers;
}

/**
 * 过滤用户附加头：只接受字符串值，剔除 CR/LF（防头注入），限制数量。
 * @param {object} raw - 原始对象
 * @returns {Record<string,string>} 安全头集合
 */
export function sanitizeHeaders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= 32) break;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const name = String(k).replace(/[\r\n:]/g, '').trim();
    const value = String(v).replace(/[\r\n]/g, ' ').trim();
    if (name.length === 0) continue;
    out[name] = value;
    n += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 字段开关                                                             */
/* ------------------------------------------------------------------ */

/**
 * 解析要下发的 `detail` 值。
 * @param {object} profile - 画像
 * @param {'low'|'high'|'original'|'auto'|undefined} want - 调用方语义（默认按 original 处理）
 * @param {string} [configMode='auto'] - 配置项 image_detail：auto/off/low/high/original
 * @returns {string|undefined} 要发的值；undefined = **不发该字段**
 */
export function resolveDetail(profile, want, configMode = 'auto') {
  const mode = String(configMode ?? 'auto').trim().toLowerCase();
  if (mode === 'off') return undefined;                       // 用户强制关闭
  if (!profile?.supports?.detail) return undefined;           // 画像不支持（如 minimal）
  const explicit = ['low', 'high', 'original'].includes(mode) ? mode : null;
  const semantic = explicit ?? (want === 'low' ? 'low' : 'original');
  const mapped = profile.detailMap?.[semantic];
  return mapped === undefined ? undefined : mapped;
}

/**
 * 解析要下发的 `thinking` 值。
 * @param {object} profile - 画像
 * @param {'enabled'|'disabled'|undefined} want - 调用方语义（预检/区域识别希望 disabled）
 * @param {string} [configMode='auto'] - 配置项 thinking_mode：auto/on/off
 * @returns {'enabled'|'disabled'|undefined} undefined = 不发该字段
 */
export function resolveThinking(profile, want, configMode = 'auto') {
  const mode = String(configMode ?? 'auto').trim().toLowerCase();
  if (mode === 'off') return undefined;
  if (!profile?.supports?.thinking) return undefined;         // 非 DeepSeek 默认不发（会 400）
  if (mode === 'on') return 'enabled';
  return want === 'enabled' || want === 'disabled' ? want : undefined;
}

/**
 * 解析 token 上限字段名。
 * @param {object} profile - 画像
 * @param {string} [configMode='auto'] - auto/max_tokens/max_completion_tokens
 * @returns {'max_tokens'|'max_completion_tokens'} 字段名
 */
export function resolveMaxTokensField(profile, configMode = 'auto') {
  const mode = String(configMode ?? 'auto').trim().toLowerCase();
  if (mode === 'max_tokens' || mode === 'max_completion_tokens') return mode;
  return profile?.maxTokensField ?? 'max_tokens';
}

/* ------------------------------------------------------------------ */
/* 请求体组装                                                           */
/* ------------------------------------------------------------------ */

/**
 * 把用户附加 body（JSON 对象）合入请求体。
 * 保护：**不允许覆盖 messages**（否则等于关掉整个视觉能力）；其余字段用户显式优先。
 * @param {object} body - 组装好的请求体
 * @param {object} extra - 用户附加字段
 * @returns {object} 合并后的请求体（新对象）
 */
export function mergeExtraBody(body, extra) {
  const out = { ...body };
  if (!extra || typeof extra !== 'object') return out;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'messages') continue; // 硬保护
    out[k] = v;
  }
  return out;
}

/**
 * 组装最终请求描述（URL + 头 + body），供 vision-client 直接 fetch。
 *
 * @param {object} opts
 * @param {object} opts.cfg - 插件配置（baseURL/model/apiPath/provider/apiKey/extraHeaders/extraBody/
 *                              imageDetail/thinkingMode/maxTokensField）
 * @param {string} [opts.apiKey] - 已解析出的 API key（可空）
 * @param {string} [opts.system] - system 文本（空则不下发）
 * @param {string} [opts.userText] - user 文本
 * @param {Array<{buffer:Buffer,mediaType:string}>} [opts.images] - 图片
 * @param {number} [opts.maxTokens] - 输出上限
 * @param {'low'|'original'} [opts.detail] - detail 语义（默认 original）
 * @param {'enabled'|'disabled'} [opts.thinking] - thinking 语义
 * @returns {{url:string, headers:Record<string,string>, body:object, profile:object,
 *            detail:string|undefined, thinking:string|undefined, tokenField:string}}
 */
export function buildBody(opts) {
  const { cfg = {}, system = '', userText = '', images = [], maxTokens = 8192 } = opts;
  const profile = PROFILES[resolveProfileId(cfg.provider, cfg.baseURL)];

  // 1. 内容：文本在前、图片在后（官方要求图片只在 user 消息；顺序不影响语义，但固定顺序便于比对）
  const content = [];
  const detail = resolveDetail(profile, opts.detail, cfg.imageDetail);
  if (String(userText).trim().length > 0) content.push({ type: 'text', text: userText });
  for (const img of images) {
    const imageUrl = { url: `data:${img.mediaType};base64,${Buffer.from(img.buffer).toString('base64')}` };
    if (detail !== undefined) imageUrl.detail = detail;
    content.push({ type: 'image_url', image_url: imageUrl });
  }

  // 2. 消息：system 文本 + user 内容
  const messages = [];
  if (String(system).trim().length > 0) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content });

  // 3. body：最小通用集合 + 按画像开启的专有字段
  const tokenField = resolveMaxTokensField(profile, cfg.maxTokensField);
  const thinking = resolveThinking(profile, opts.thinking, cfg.thinkingMode);
  const body = { model: cfg.model, messages, [tokenField]: maxTokens, stream: false };
  if (thinking !== undefined) body.thinking = { type: thinking };

  return {
    body: mergeExtraBody(body, cfg.extraBody),
    profile,
    detail,
    thinking,
    tokenField
  };
}

/**
 * 组装最终请求描述（URL + 头 + body），供 vision-client 直接 fetch。
 *
 * @param {object} opts
 * @param {object} opts.cfg - 插件配置（baseURL/model/apiPath/provider/apiKey/extraHeaders/extraBody/
 *                              imageDetail/thinkingMode/maxTokensField）
 * @param {string} [opts.apiKey] - 已解析出的 API key（可空）
 * @param {string} [opts.system] - system 文本（空则不下发）
 * @param {string} [opts.userText] - user 文本
 * @param {Array<{buffer:Buffer,mediaType:string}>} [opts.images] - 图片
 * @param {number} [opts.maxTokens] - 输出上限
 * @param {'low'|'original'} [opts.detail] - detail 语义（默认 original）
 * @param {'enabled'|'disabled'} [opts.thinking] - thinking 语义
 * @returns {{url:string, headers:Record<string,string>, body:object, profile:object,
 *            detail:string|undefined, thinking:string|undefined, tokenField:string}}
 */
export function buildRequest(opts) {
  const { cfg = {}, apiKey } = opts;
  const built = buildBody(opts);
  return {
    url: composeUrl(cfg.baseURL, cfg.apiPath, built.profile),
    headers: buildHeaders(built.profile, apiKey, cfg.extraHeaders),
    ...built
  };
}

/* ------------------------------------------------------------------ */
/* 错误分类与响应解析                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把 HTTP 错误分类，供 vision-client 决定「重试 / 换字段 / 直接抛」。
 * 依据：调研报告 3.3 的试探-回退策略（400 才试探，401/403/413 一律不重试）。
 *
 * @param {number} status - HTTP 状态码
 * @param {string} text - 响应文本（用于关键字定位）
 * @returns {{kind:string, retryable:boolean, toggleV1?:boolean, suggestTokenField?:string, offendingField?:string}}
 *   kind 取值：'path'(路径错) | 'token-field' | 'field'(专有字段不被接受) | 'auth' | 'too-large'
 *             | 'rate-limit' | 'server' | 'client' | 'unknown'
 */
export function classifyHttpError(status, text = '') {
  const msg = String(text ?? '');
  if (status === 404 || status === 405) return { kind: 'path', retryable: false, toggleV1: true };
  if (status === 429) return { kind: 'rate-limit', retryable: true };
  if (status >= 500) return { kind: 'server', retryable: true };
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 413) return { kind: 'too-large', retryable: false };
  if (status === 400) {
    if (/max_completion_tokens/i.test(msg)) {
      return { kind: 'token-field', retryable: false, suggestTokenField: 'max_completion_tokens' };
    }
    if (/max_tokens/i.test(msg) && /not supported|unsupported|unknown|invalid/i.test(msg)) {
      return { kind: 'token-field', retryable: false, suggestTokenField: 'max_completion_tokens' };
    }
    for (const field of ['detail', 'thinking', 'reasoning_effort', 'stream_options', 'response_format']) {
      if (new RegExp(field, 'i').test(msg)) return { kind: 'field', retryable: false, offendingField: field };
    }
    return { kind: 'client', retryable: false };
  }
  return { kind: 'unknown', retryable: false };
}

/**
 * 从响应体里提取助手正文，并区分「空正文」的不同成因（调研 3.3 的 extractText）。
 *
 * ⚠️ 关键纪律：**HTTP 200 也可能是业务失败**（MiniMax 用 `base_resp.status_code !== 0`），
 * 「没报错」≠「成功」——必须校验正文非空并把空正文的真实原因带出来。
 *
 * @param {object} payload - 已解析的响应 JSON
 * @returns {{content:string, emptyReason:string|null, finishReason:string, reasoning:string}}
 *   content 非空时 emptyReason 为 null。
 */
export function extractAssistantText(payload) {
  // 1) 业务层错误（HTTP 200 但业务失败）
  const bizCode = payload?.base_resp?.status_code;
  if (bizCode !== undefined && Number(bizCode) !== 0) {
    return {
      content: '',
      emptyReason: `端点业务错误（base_resp.status_code=${bizCode}）：${payload?.base_resp?.status_msg ?? '无描述'}`,
      finishReason: 'biz-error',
      reasoning: ''
    };
  }
  const choice = payload?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const finishReason = choice.finish_reason ?? 'n/a';
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
  if (content.trim().length > 0) {
    return { content, emptyReason: null, finishReason, reasoning };
  }
  // 2) 空正文的五类成因（分别给出可操作提示，而不是笼统一句"识别失败"）
  let reason;
  if (finishReason === 'length') reason = '撞 token 上限（思考可能吃掉了输出预算），请提高 max_tokens';
  else if (finishReason === 'content_filter') reason = '被端点内容安全策略拦截';
  else if (reasoning.length > 0) reason = '只返回了思维链（reasoning_content），未产出正文';
  else if (Array.isArray(msg.content)) reason = '返回的是结构化内容数组，正文为空';
  else reason = '响应为空（原因未判定：可能是端点不认图、或模型未按要求输出）';
  return { content: '', emptyReason: reason, finishReason, reasoning };
}

/**
 * 是否应该为「路径错误」切换 `/v1` 前缀重试。
 * 只在用户**没有**显式给 api_path、且 baseURL 不是完整 URL 时才自动切换。
 *
 * ⚠️ 返回的是**新的 baseURL**（不是完整 URL）：调用方把它当 baseURL 用，
 * 再由 composeUrl 统一拼路径——否则会出现
 * `http://host/http://host/v1/chat/completions` 这种双 URL（已踩过）。
 *
 * @param {object} cfg - 插件配置
 * @returns {{baseURL:string}|null} 建议替换的 baseURL；null = 不重试
 */
export function suggestV1Toggle(cfg) {
  const base = String(cfg?.baseURL ?? '').trim().replace(/\/+$/, '');
  if (String(cfg?.apiPath ?? '').trim().length > 0) return null; // 用户显式给了路径 → 不猜
  if (/\/chat\/completions$/i.test(base)) return null;           // 已是完整 URL → 不猜
  if (/\/v1$/i.test(base)) {
    // 已带 /v1 仍 404 → 去掉 /v1 再试一次（有些端点的根就是 /chat/completions）
    return { baseURL: base.replace(/\/v1$/i, '') };
  }
  // 未带 /v1 → 补上再试一次
  return { baseURL: `${base}/v1` };
}
