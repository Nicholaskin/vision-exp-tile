/**
 * vision-client.js — DeepSeek 视觉 API 客户端（仅服务 deepseek-v4-flash-vision-exp）
 *
 * 设计依据（官方 API 文档 api-docs.deepseek.com/guides/vision）：
 *  - 端点：https://api.deepseek.com（OpenAI 兼容 chat/completions）
 *  - 图片仅可在 user 消息；system/assistant 放图会被 400 拒绝 → 本模块只把图放到 user content
 *  - 每张图在模型侧自动缩放至 ≈800×800 总像素、封顶 384 token → 800×800 块不降采样
 *  - 限制：请求体 48MiB（base64 内联）；单图 32MiB；每请求 ≤600 张；≥15 图时单边上限 4096px
 *  - usage：prompt_tokens（含缓存命中）+ prompt_tokens_details.cached_tokens（或
 *    prompt_cache_hit_tokens）+ completion_tokens → 用于真实计费
 *
 * 本模块不依赖 DSH 服务（fetch/AbortSignal 由调用方传入），便于单元测试。
 *
 * v1.0.0 多模态端点泛化：端点相关的**全部可变部分**（路径 / 认证头 / detail / thinking /
 * token 字段名 / 额外头与 body）都交给 `api-profile.js` 的画像描述，本模块只负责
 * 「按画像发请求 + 错误分类回退 + 空正文诊断」。
 * 兼容底线：**未传 `apiCfg` 时按 DeepSeek 画像执行，行为与 v0.5.0 逐字段一致**。
 */

// 同目录模块的静态导入（ESM 静态 import 合法，避免运行期动态 `import()` 带来的额外往返与打包分块）
import { buildRecognizeSystem, buildRecognizeUserText, buildGroupSystem, buildGroupUserText, buildAggregateSystem, buildAggregateUserText } from './prompts.js';
// 端点画像（v1.0.0）：请求体/URL/头/字段开关的唯一出口
import {
  PROFILES, resolveProfileId, buildBody, buildRequest, classifyHttpError,
  extractAssistantText, suggestV1Toggle, composeUrl
} from './api-profile.js';
// v1.0.0 性能改造：组间并发限流器 + 视觉结果缓存
import { mapLimit, resolveBudget, acquireApiSlot, releaseApiSlot } from './concurrency.js';
import { resultCacheGet, resultCacheSet, resultCacheKey } from './result-cache.js';
// ESM 下用 createRequire 加载 CJS 的 sharp（可选依赖，失败时降级为物理分批）
import { createRequire } from 'node:module';

/** 图片数据预算锚点（base64 膨胀 4/3 后约 48MiB 请求体中的可容部分） */
export const MAX_INLINE_IMAGE_BYTES = 36 * 1024 * 1024;
/** 每条请求最多图片数（官方上限 600；本插件用更保守的 240 保质量） */
export const MAX_IMAGES_PER_REQUEST = 240;
/** 官方单图上限（base64 内联） */
export const MAX_SINGLE_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * 校验并构造 OpenAI 兼容 chat/completions 请求体。
 * 图片必须全部位于 user 消息（官方硬限制），文本指令放 system。
 * @param {object} opts - {model, system, userText, images:[{buffer,mediaType}], maxTokens,
 *                         detail, thinking:'enabled'|'disabled'|undefined}
 *   thinking：官方思考模式开关（{"thinking":{"type":"enabled|disabled"}}，默认不传=启用思考）。
 *   简单结构化任务（预检/区域识别）建议传 'disabled'，避免思考烧光输出预算导致正文为空。
 * @returns {object} 请求体（可直接 JSON.stringify）
 */
export function buildRequestBody({ model, system = '', userText = '', images = [], maxTokens = 8192, detail = 'original', thinking }) {
  // v1.0.0：请求体组装统一走 api-profile（DeepSeek 画像 → 与旧实现逐字段一致）。
  // 保留本函数是为了「向后兼容的稳定入口」：旧调用方与既有测试继续可用。
  const profile = PROFILES.deepseek;
  return buildBody({
    cfg: { provider: profile.id, baseURL: '', model },
    system, userText, images, maxTokens, detail, thinking
  }).body;
}

/**
 * 错误文本化（健壮）：对象/字符串/JSON 兜底，避免输出 "[object Object]"。
 * @param {unknown} e - 任意错误值
 * @returns {string} 可读文本
 */
function fmtErr(e) {
  if (e == null) return 'unknown';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** 简易等待（退避重试用） */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单次调用 DeepSeek chat/completions（非流式，简单可靠）。
 * 健壮性处理：当模型只输出 reasoning（思考）而未输出正文（content 为空，
 * 常见于 exp 模型被 max_tokens 截断或思考后未落正文）时，自动加 max_tokens 重试
 * （最多 2 次：+4096、再 +8192）；仍为空则抛出带 finish_reason/reasoning 摘要的明确错误。
 * @param {object} opts - {apiKey, baseURL, model, system, userText, images, maxTokens, detail,
 *                          signal, fetchImpl, timeoutMs}
 * @returns {Promise<{content:string, retried?:boolean}>} 模型回复文本
 */
export async function callChat(opts) {
  const {
    apiKey, baseURL = 'https://api.deepseek.com', model,
    system = '', userText = '', images = [], maxTokens = 8192,
    detail = 'original', thinking, signal, fetchImpl = fetch, timeoutMs = 300000,
    retryDelays = [1000, 3000, 9000], // 429/5xx 退避节奏（测试可注入更短值）
    apiCfg                            // v1.0.0：端点画像配置（不传 = DeepSeek 画像 → 旧行为不变）
  } = opts;

  /* ── 端点画像：缺省 DeepSeek（回归红线：不传 apiCfg 时与 v0.5.0 行为一致）── */
  const profileCfg = {
    provider: apiCfg?.provider ?? 'deepseek',
    baseURL: apiCfg?.baseURL ?? baseURL,
    model: apiCfg?.model ?? model,
    apiPath: apiCfg?.apiPath,
    extraHeaders: apiCfg?.extraHeaders,
    extraBody: apiCfg?.extraBody,
    imageDetail: apiCfg?.imageDetail,
    thinkingMode: apiCfg?.thinkingMode,
    maxTokensField: apiCfg?.maxTokensField
  };
  const profile = PROFILES[resolveProfileId(profileCfg.provider, profileCfg.baseURL)];
  // 缺少 key：仅当画像「要求 key」时报错（本地 vLLM/Ollama/LM Studio 常态无 key，不该被拦）
  if (!apiKey && profile.requiresKey) {
    throw new Error('vision-client: missing DeepSeek API key (set env var DEEPSEEK_API_KEY or configure apiKeyEnv)');
  }

  /**
   * 试探-回退状态（每次 callChat 独立）：
   *  - apiPath  ：404/405 时切 /v1 前缀的落点
   *  - tokenField：400 说 max_tokens 不被支持时切到 max_completion_tokens（记住，不再反复试）
   *  - dropped  ：端点明确不吃的专有字段（thinking 等）→ 从请求体剔除
   *  - detailOff：detail 不被接受 → 不再下发该字段
   * 每类试探最多一次/三轮，保证不会陷入死循环。
   */
  const state = { apiPath: profileCfg.apiPath, tokenField: undefined, dropped: new Set(), detailOff: false, triedV1: false, baseURLOverride: undefined };
  const buildCfg = () => ({
    ...profileCfg,
    // 404/405 切 /v1 时改的是 **baseURL**（不是 apiPath）——否则会被 composeUrl 二次拼接成双 URL
    baseURL: state.baseURLOverride ?? profileCfg.baseURL,
    apiPath: state.apiPath,
    ...(state.detailOff ? { imageDetail: 'off' } : {}),
    ...(state.tokenField ? { maxTokensField: state.tokenField } : {})
  });
  /** 组装一次请求（每次重建：max_tokens 会变、字段回退也会改 cfg） */
  const buildOne = (maxT) => {
    const req = buildRequest({
      cfg: buildCfg(), apiKey, system, userText, images,
      maxTokens: maxT, detail, thinking
    });
    for (const f of state.dropped) delete req.body[f];
    return req;
  };

  // 单次请求执行：返回 {payload, content, emptyReason}；网络/HTTP 错误按语义处理
  // —— 性能/健壮性优化：429/5xx/瞬时网络错误 → 指数退避重试（最多 3 次，1s/3s/9s）——
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const fetchOnce = async (maxT, attempt = 0) => {
    const req = buildOne(maxT);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const sig = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let response;
    // 全局 API 闸门：并发额度跨调用共享（防「批量图级 × 图内」叠乘打爆端点）；
    // 名额必须在 finally 归还，否则额度泄漏 → 后续请求永久排队。
    await acquireApiSlot();
    try {
      response = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: sig
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal?.aborted || controller.signal.aborted) {
        const reason = signal?.reason ?? controller.signal.reason;
        throw new Error(
          `vision-client: request aborted (reason=${reason ? fmtErr(reason) : 'unset'}; err=${fmtErr(error)})`
        );
      }
      // 瞬时网络错误：退避重试一次（防 VPN/代理抖动）
      if (attempt < 1) {
        await sleep(1500 * (attempt + 1));
        return fetchOnce(maxT, attempt + 1);
      }
      throw new Error(`vision-client: network error: ${fmtErr(error)}`);
    } finally {
      releaseApiSlot();
    }
    clearTimeout(timer);
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`vision-client: non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`);
    }
    if (!response.ok) {
      const apiMsg = payload?.error?.message ?? payload?.message ?? JSON.stringify(payload).slice(0, 300);
      const cls = classifyHttpError(response.status, text);
      if (RETRYABLE.has(response.status) && attempt < 3) {
        // 尊重服务端 Retry-After（秒），否则按退避节奏（默认 1s/3s/9s）
        const ra = Number(payload?.error?.retry_after ?? 0);
        const delay = ra > 0 ? ra * 1000 : retryDelays[attempt] ?? 9000;
        await sleep(delay);
        return fetchOnce(maxT, attempt + 1);
      }
      // ① 路径猜错（404/405）→ 切一次 /v1 前缀（仅当用户没显式给路径）
      if (cls.toggleV1 && !state.triedV1) {
        const suggestion = suggestV1Toggle(buildCfg());
        if (suggestion) {
          state.triedV1 = true;
          state.baseURLOverride = suggestion.baseURL;
          return fetchOnce(maxT, attempt);
        }
      }
      // ② token 字段不被支持 → 换字段重试一次（并记住，后续请求直接用新字段）
      if (cls.kind === 'token-field' && state.tokenField === undefined) {
        state.tokenField = cls.suggestTokenField ?? 'max_completion_tokens';
        return fetchOnce(maxT, attempt);
      }
      // ③ 专有字段不被接受（thinking / detail / response_format…）→ 剔除后重试（最多 3 轮）
      if (cls.kind === 'field' && state.dropped.size + (state.detailOff ? 1 : 0) < 3) {
        if (cls.offendingField === 'detail') state.detailOff = true;
        else state.dropped.add(cls.offendingField);
        return fetchOnce(maxT, attempt);
      }
      throw new Error(`vision-client: API error HTTP ${response.status} (${payload?.error?.code ?? 'unknown'}): ${apiMsg}`);
    }
    const parsed = extractAssistantText(payload);
    return { payload, content: parsed.content, emptyReason: parsed.emptyReason, finishReason: parsed.finishReason };
  };

  // 第一次请求
  const first = await fetchOnce(maxTokens);
  if (first.content.length > 0) return { content: first.content };

  // —— content 为空：属于"思考后未落正文/被截断"，放大 max_tokens 递增重试（最多 2 次）——
  const msg = first.payload?.choices?.[0]?.message;
  const finishReason = first.finishReason ?? first.payload?.choices?.[0]?.finish_reason ?? 'n/a';
  const reasoning = typeof msg?.reasoning_content === 'string' && msg.reasoning_content.length > 0
    ? msg.reasoning_content
    : '';

  // 重试 1：+4096
  const retry1 = await fetchOnce(Math.min(65536, maxTokens + 4096));
  if (retry1.content.length > 0) return { content: retry1.content, retried: true };
  // 重试 2：再 +8192（共 +12288）
  const retry2 = await fetchOnce(Math.min(65536, maxTokens + 4096 + 8192));
  if (retry2.content.length > 0) return { content: retry2.content, retried: true };

  throw new Error(
    `vision-client: 模型未输出正文且重试 2 次后仍为空（finish_reason=${finishReason}` +
    (reasoning.length > 0 ? `，reasoning 摘要: ${reasoning.slice(0, 120)}` : '') +
    (first.emptyReason ? `；判定：${first.emptyReason}` : '') +
    `）；请增大 max_tokens 或稍后重试`
  );
}

/**
 * 估算图片 base64 总字节（b64 ≈ 4/3 × 原始字节）。
 * @param {Array} images - [{buffer}] 列表
 * @returns {number} 预计 base64 字节数
 */
export function estimateBase64Bytes(images) {
  let sum = 0;
  for (const img of images) sum += img.buffer.byteLength;
  return Math.ceil((sum * 4) / 3);
}

/**
 * 检查图片批次是否仍在官方限制内；超限时给出"每批建议最大图数"（maxBatch）。
 * 返回 {ok:boolean, reason?:string, maxBatch?:number}
 *  - 单张图超 32MiB → 无法分批解决（必须压缩或缩放），maxBatch 为 undefined
 *  - 图数/字节预算超限 → maxBatch = 按受限因素反推的每批最大图数（供调用方分批）
 * @param {Array} images - 图片列表
 * @param {object} limits - 可选覆盖
 */
export function checkImageBatchLimits(images, limits = {}) {
  const maxImages = limits.maxImages ?? MAX_IMAGES_PER_REQUEST;
  const maxBytes = limits.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const maxSingle = limits.maxSingle ?? MAX_SINGLE_IMAGE_BYTES;
  // 单张超限：分批无济于事，必须压缩或缩放
  for (const img of images) {
    if (img.buffer.byteLength > maxSingle) {
      return { ok: false, reason: `单张图片 ${img.buffer.byteLength} 字节超过单图上限 ${maxSingle} 字节（需压缩或缩小图片）`, maxBatch: undefined };
    }
  }
  // 图数上限 → 每批最多 maxImages 张
  let perBatchByCount = Infinity;
  if (images.length > maxImages) perBatchByCount = maxImages;
  // 字节预算 → 按"平均块大小 × 1.2 余量"反推每批最大图数
  let perBatchByBytes = Infinity;
  const est = estimateBase64Bytes(images);
  if (est > maxBytes) {
    const avg = (est / Math.max(1, images.length)) * 1.2;
    perBatchByBytes = Math.max(1, Math.floor(maxBytes / avg));
  }
  const maxBatch = Math.min(perBatchByCount, perBatchByBytes);
  if (!Number.isFinite(maxBatch)) return { ok: true };
  const parts = [];
  if (images.length > maxImages) parts.push(`图片数 ${images.length} 超过单请求上限 ${maxImages}`);
  if (est > maxBytes) parts.push(`图片 base64 总量约 ${(est / 1024 / 1024).toFixed(1)}MiB 超过预算 ${Math.round(maxBytes / 1024 / 1024)}MiB`);
  return { ok: false, reason: parts.join('；'), maxBatch };
}

/**
 * 组内预算自适应：把一组图片适配到官方请求体预算内（48MiB 请求体 − 文本/JSON 余量）。
 *  1) 未超预算 → 原样单批返回；
 *  2) 超预算且有 transcode（例如 PNG→JPEG 重编码）→ 自动转码后复检；
 *  3) 仍超 → 按预算反推的每批图数切成多批。
 * @param {Array} images - [{buffer, mediaType}] 图片列表
 * @param {Function|null} transcode - 可选转码器 fn(buffer, mediaType) => Buffer（如 PNG→JPEG）
 * @param {number} maxBytes - 图片数据预算（默认 36MiB）
 * @returns {Promise<{batches:Array, converted:boolean, note:string}>}
 */
export async function adaptBatches(images, transcode = null, maxBytes = MAX_INLINE_IMAGE_BYTES) {
  if (estimateBase64Bytes(images) <= maxBytes) {
    return { batches: [images], converted: false, note: '' };
  }
  if (typeof transcode === 'function') {
    // 尽力转码：把所有块转成 JPEG（视觉无损级 q95），显著缩小载荷
    const converted = images.map((im) => {
      let buffer = im.buffer;
      if (im.mediaType !== 'image/jpeg') buffer = transcode(im.buffer, im.mediaType);
      return { ...im, buffer, mediaType: 'image/jpeg' };
    });
    if (estimateBase64Bytes(converted) <= maxBytes) {
      return { batches: [converted], converted: true, note: '图片载荷超出预算，已自动转码为 JPEG(q95) 以便单批发送（视觉无损级）' };
    }
  }
  // 仍超：按预算反推每批图数做物理分批（每批仍是一个独立 API 请求）
  const est = estimateBase64Bytes(images);
  const avg = (est / Math.max(1, images.length)) * 1.2;
  const perBatch = Math.max(1, Math.floor(maxBytes / avg));
  const batches = [];
  for (let i = 0; i < images.length; i += perBatch) batches.push(images.slice(i, i + perBatch));
  return {
    batches,
    converted: false,
    note: `图片载荷超预算，已自动分为 ${batches.length} 批发送（每批 ≤${perBatch} 张）`
  };
}

/** 尽力加载 sharp 的 JPEG 转码器（PNG/GIF/WebP → JPEG q95）；不可用时返回 null。 */
function loadTranscoder() {
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp');
    if (typeof sharp !== 'function') return null;
    return async (buffer, _mediaType) => {
      const out = await sharp(buffer, { failOn: 'none' }).jpeg({ quality: 95 }).toBuffer();
      return out;
    };
  } catch {
    return null;
  }
}

/**
 * 组装"分层聚合"请求组。
 * 把 tiles 按每组 groupSize 顺序切分（不改变行优先顺序）。
 * @param {Array} tiles - 切块结果
 * @param {number} groupSize - 组大小（默认 40）
 * @returns {Array<Array>} 组列表
 */
export function splitGroups(tiles, groupSize = 40) {
  const groups = [];
  for (let i = 0; i < tiles.length; i += groupSize) {
    groups.push(tiles.slice(i, i + groupSize));
  }
  return groups;
}

/**
 * 运行完整识别流程（工具 2 的核心编排）：
 *  - 总块数 ≤ singleThreshold → 单请求"逐块识别 + 全局聚合"一体完成（快、省）
 *  - 否则 → 分层聚合：每组一请求输出带坐标的结构化 JSON，最后一次请求做全局聚合
 * 本流程只负责识别与聚合，不代为统计/不显示 token 与费用（实际计费以 DeepSeek 官方 API 平台账单为准）。
 * @param {object} opts - {apiKey, baseURL, model, width, height, tiles, grid, question,
 *                         mode('auto'|'single'|'layered'), groupSize, maxTokens, detail,
 *                         json, fetchImpl, signal, timeoutMs}
 * @returns {Promise<{answer:string, mode:string, stages:Array, groups:number, imageCount:number}>}
 */
export async function recognize(opts) {
  const {
    apiKey, baseURL, model, width, height, tiles, grid,
    question = '', mode = 'auto', groupSize = 40, maxTokens = 8192,
    detail = 'original', json = false, fetchImpl, signal, timeoutMs = 300000,
    apiCfg // v1.0.0：端点画像配置（不传 = DeepSeek 旧行为）
  } = opts;
  const total = tiles.length;
  // 模式决策：显式指定优先；auto 按单请求容量（够放得下且 ≤ singleThreshold）选 single
  const singleThreshold = 60; // 单请求模式块数上限（含 overview 图）
  let effMode = mode;
  if (effMode === 'auto') effMode = total <= singleThreshold ? 'single' : 'layered';
  if (effMode === 'single' && checkImageBatchLimits(tiles).ok === false) {
    // 明确要求单请求但放不下 → 抛出可操作错误（提示改 format=jpeg 或 layered）
    const lim = checkImageBatchLimits(tiles);
    throw new Error(`vision-client: ${lim.reason}；请将 format 设为 'jpeg'（减少载荷）或改用 layered 模式（自动分批）`);
  }

  const stages = [];
  let answer;

  if (effMode === 'single') {
    // —— 单请求模式：system 聚合指令 + user 文本 + 全部图片 ——
    const system = buildRecognizeSystem({ question, json, width, height, blockSize: opts.blockSize ?? 800, overlap: opts.overlap ?? 0 });
    const userText = buildRecognizeUserText({ question, width, height, tiles, grid, blockSize: opts.blockSize ?? 800, overlap: opts.overlap ?? 0 });
    const res = await callChat({ apiKey, baseURL, model, apiCfg, system, userText, images: tiles, maxTokens, detail, signal, fetchImpl, timeoutMs });
    answer = res.content;
    stages.push({ kind: 'single', imageCount: total });
  } else {
    /* —— 分层聚合模式（组内预算自适应：转码 / 物理分批）——
     * v1.0.0 性能改造：**组间并发**。旧版是串行 for，组多时耗时线性叠加；
     * 现改为 mapLimit（滑动窗口、结果保序），并发上限取「显式参数 > 算力预算」。
     * 保序很关键：聚合层依赖组顺序，错序会导致跨块行对齐失效。 */
    const groups = splitGroups(tiles, groupSize);
    const transcode = loadTranscoder(); // 无 sharp 时为 null，走物理分批
    const groupResults = []; // 组结果（保序）
    const apiLimit = opts.apiConcurrency === undefined
      ? resolveBudget({ performanceTier: opts.performanceTier, cores: opts.cores }).api
      : Math.max(1, Math.min(4, Math.floor(opts.apiConcurrency)));
    const stageBuf = []; // 并发下 stages 顺序不定 → 先按组号收集，最后统一 push
    const perGroup = await mapLimit(groups, apiLimit, async (group, gi) => {
      // 组 → 预算适配后的批次（每批一个独立 API 请求）
      const { batches, note } = await adaptBatches(group, transcode);
      const system = buildGroupSystem();
      const userText = buildGroupUserText({ width, height, tiles: group, grid });
      const parts = [];
      const localStages = [];
      for (let bi = 0; bi < batches.length; bi += 1) {
        const res = await callChat({ apiKey, baseURL, model, apiCfg, system, userText, images: batches[bi], maxTokens, detail, signal, fetchImpl, timeoutMs });
        parts.push(res.content);
        localStages.push({ kind: 'group', index: gi, batch: bi, imageCount: batches[bi].length });
      }
      localStages.push({ kind: 'group-combined', index: gi, batches: batches.length });
      return { groupIndex: gi, groupText: parts.join('\n\n'), note, stages: localStages };
    });
    // 按组序汇总（mapLimit 已保序，这里再按 index 排序做双保险）
    for (const r of [...perGroup].sort((a, b) => a.groupIndex - b.groupIndex)) {
      groupResults.push({ groupIndex: r.groupIndex, groupText: r.groupText, note: r.note });
      stageBuf.push(...r.stages);
    }
    stages.push(...stageBuf);
    stages.push({ kind: 'api-concurrency', limit: apiLimit, groups: groups.length });
    const aggSystem = buildAggregateSystem({ json });
    const aggUser = buildAggregateUserText(groupResults, question);
    const final = await callChat({ apiKey, baseURL, model, apiCfg, system: aggSystem, userText: aggUser, images: [], maxTokens, detail, signal, fetchImpl, timeoutMs });
    answer = final.content;
    stages.push({ kind: 'aggregate', groups: groups.length });
  }

  return { answer, mode: effMode, stages, groups: effMode === 'layered' ? Math.ceil(total / groupSize) : 1, imageCount: total };
}

/* ------------------------------------------------------------------ */
/* 「智能识图」新增：整图预检 + 区域识别                                  */
/*                                                                     */
/* 设计说明：这两个函数复用上方 callChat()（单次 chat/completions 调用），   */
/* 仅追加导出，不修改已有导出/逻辑：                                       */
/*  - previewImage：发「detail:'low'」的单张整图（官方 512×512 降采样预检），*/
/*    让模型判断有无文字、文字区域、兴趣点区域，输出 strict JSON；           */
/*  - recognizeRegion：发「detail:'original'」的单张区域图，让模型详细      */
/*    描述该区域全部内容与文字。                                           */
/* 两者都遵循官方硬限制「图片只能放 user 消息」，文本指令放 system。          */
/* ------------------------------------------------------------------ */

/**
 * 预检 system 指令（简体中文），约束模型：
 *  1) 判断图中是否存在文字（含屏幕截图/报表/图表标注/按钮文字/水印等）；
 *  2) 若有文字，给出 1~3 个文字区域矩形，全部为 0..1 相对坐标 [x0,y0,x1,y1]（相对整图比例，禁写像素）；
 *  3) 判断兴趣点（重点内容：图表/表格/物体/关键区块/标题栏等），给出 0..1 相对矩形 + 简短中文 label（1~4 字）；
 *  4) 输出严格 JSON（不要 markdown 代码块、不要多余文字）；
 *  5) summary 为整图概要（≤200 字中文）。
 */
const PREVIEW_SYSTEM = [
  '你是图片预检助手。观察这张整图（已按官方规则降采样到 512×512 用于预检），回答下列问题。',
  '1) 判断图中是否存在文字（含屏幕截图、报表、图表标注、按钮文字、水印、签名等）。',
  '2) 若存在文字，给出 1~3 个文字区域矩形，全部为 0..1 相对坐标 [x0,y0,x1,y1]（相对整图比例，x0<x1、y0<y1，不要写像素坐标）。',
  '3) 判断兴趣点区域（图中的重点内容：图表、表格、物体、关键区块、标题栏等），给出 0..1 相对矩形，并为每个区域给一个简短中文 label（1~4 个字）。',
  '4) 输出一个严格 JSON 对象（不要 markdown 代码块、不要多余文字），字段如下：',
  '{"hasText":true,"textRegions":[{"x0":0.1,"y0":0.2,"x1":0.9,"y1":0.3,"isHandwrite":false}],"interestRegions":[{"x0":0.0,"y0":0.0,"x1":1.0,"y1":1.0,"label":"图表"}],"summary":"整图概要"}',
  '4b) 每个文字区域请务必附上布尔字段 isHandwrite：该区域文字是否为**手写体**（手写答卷/笔记/潦草字迹=true；印刷体/电脑字体/印章字样=false）。不确定时时按印刷体处理并写 false。',
  '5) summary 为整图概要，使用中文，不超过 200 字。若图中无文字，hasText 填 false 且 textRegions 为空数组；若无明显兴趣点，interestRegions 可为空数组。',
  '6) 兜底要求：如果你无法可靠地输出上述 JSON，请退化为—直接用中文在 100 字内概括整图，并逐条列出你确定的文字区域/兴趣点位置（文字描述即可，不需要 JSON）。宁可输出退化的中文，也不要空回复。',
  '7) 若用户消息带有【补充问题】：该问题仅用于在 summary 中顺带回应，绝不改变/破坏 JSON 结构；若补充问题与预检冲突，忽略它并把"该问题无法预检回答"写入 summary。'
].join('\n');

/**
 * 区域识别 system 指令（简体中文），要求模型描述区域内全部内容与文字，中文 ≤400 字。
 */
const REGION_SYSTEM = [
  '你是区域识别助手。观察给定的区域图像（可能是一张局部裁剪图），描述其中的全部内容与文字。',
  '要求：1) 详细描述该区域的完整内容（物体、图表、表格、布局、颜色、纹理等）；',
  '2) 若区域内有文字，务必完整、准确地读出文字内容；',
  '3) 输出使用中文，不超过 400 字。'
].join('\n');

/** 把任意值转成有限数，否则返回 null（用于防御非数值字段）。 */
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一化一个矩形：兼容两种模型输出形式：
 *  - 对象 {x0,y0,x1,y1}（推荐，见 PREVIEW_SYSTEM 示例）；
 *  - 数组 [x0,y0,x1,y1]（模型偶尔输出，做防御性兼容）。
 * 全部按 0..1 相对坐标校验并钳制；非法返回 null。
 */
function normalizeRect(r) {
  let x0, y0, x1, y1;
  if (Array.isArray(r) && r.length === 4) {
    [x0, y0, x1, y1] = r;
  } else if (typeof r === 'object' && r !== null) {
    x0 = r.x0; y0 = r.y0; x1 = r.x1; y1 = r.y1;
  } else {
    return null;
  }
  const nx0 = toNum(x0);
  const ny0 = toNum(y0);
  const nx1 = toNum(x1);
  const ny1 = toNum(y1);
  if ([nx0, ny0, nx1, ny1].some((v) => v === null)) return null;
  return {
    x0: Math.min(1, Math.max(0, nx0)),
    y0: Math.min(1, Math.max(0, ny0)),
    x1: Math.min(1, Math.max(0, nx1)),
    y1: Math.min(1, Math.max(0, ny1))
  };
}

/** 归一化一组相对矩形（[{x0,y0,x1,y1}] 或 [[x0,y0,x1,y1]]）；非数组或缺字段则逐一过滤。
 *  v0.2.0：保留可选 isHandwrite（模型预检标注手写；缺省/非布尔按 undefined 处理）。 */
function normalizeRectList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const rect = normalizeRect(r);
    if (!rect) continue;
    const hw = !Array.isArray(r) && typeof r.isHandwrite === 'boolean' ? r.isHandwrite : undefined;
    if (hw !== undefined) rect.isHandwrite = hw;
    out.push(rect);
  }
  return out;
}

/** 归一化一组兴趣点区域（[{x0,y0,x1,y1,label}] 或 [[x0,y0,x1,y1,label]]），保留 label。 */
function normalizeInterestList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const rect = normalizeRect(r);
    if (!rect) continue;
    const label = Array.isArray(r) ? '' : (typeof r.label === 'string' ? r.label : String(r.label ?? ''));
    out.push({ ...rect, label });
  }
  return out;
}

/** 从模型回复中提取第一个 JSON（允许前后有文字：seek 第一个 '{' 到最后一个 '}'）。 */
function parseStrictJson(content) {
  const s = String(content ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/**
 * 整图预检：发单张图（detail:'low'，官方 512×512 降采样）+ system 指令 + user 文本，
 * 调 callChat 后把模型回复 JSON 解析为结构化结果。
 * @param {object} opts - {apiKey, baseURL, model, buffer, mediaType, question='', signal,
 *                          fetchImpl, timeoutMs, maxTokens=8192}
 * @returns {Promise<{hasText:boolean, textRegions:Array, interestRegions:Array, summary:string,
 *                    raw:string, parseError?:boolean}>}
 *  解析失败时不抛错，返回 {hasText:false, textRegions:[], interestRegions:[], summary:raw,
 *  raw, parseError:true}，交由调用方决定如何兜底。
 */
export async function previewImage(opts) {
  const {
    apiKey, baseURL, model, buffer,
    mediaType = 'image/png', question = '',
    signal, fetchImpl, timeoutMs, maxTokens = 8192,
    apiCfg // v1.0.0：端点画像配置
  } = opts;
  if (!buffer) throw new Error('vision-client: previewImage 需要 buffer（图片字节）');

  /* v1.0.0 性能改造：结果缓存（同一张图 + 同一参数 → 直接复用，省一次付费请求）。
   * 键里带上画像与参数，换模型/换端点/换提问都会自然 miss。 */
  const cacheKey = resultCacheKey(buffer, {
    kind: 'preview', model, base: apiCfg?.baseURL ?? baseURL,
    provider: apiCfg?.provider ?? 'deepseek', question,
    maxTokens, detail: 'low', schema: 'preview-v1'
  });
  const cached = await resultCacheGet(cacheKey);
  if (cached) return { ...cached.value, cached: true };

  // user 文本：只放提示与补充问题（图片交给 callChat 放到 user content）
  const q = question.trim().length > 0 ? `【补充问题】${question.trim()}` : '';
  const userText = ['请对这张整图做预检，并严格按 system 要求输出 JSON。', q].filter(Boolean).join('\n');

  const res = await callChat({
    apiKey, baseURL, model, apiCfg,
    system: PREVIEW_SYSTEM,
    userText,
    images: [{ buffer, mediaType }],
    maxTokens,
    detail: 'low', // 官方 512×512 降采样预检
    thinking: 'disabled', // 预检为结构化短任务：关闭思考，直出 JSON（避免思考烧光输出预算）
    signal, fetchImpl, timeoutMs
  });
  const raw = res.content;

  // 提取并解析第一个 JSON；失败则返回带 parseError 的兜底对象（不抛错）
  const parsed = parseStrictJson(raw);
  if (!parsed) {
    // 解析失败不缓存（纪律：只缓存成功结果，否则错误会被固化）
    return { hasText: false, textRegions: [], interestRegions: [], summary: raw, raw, parseError: true };
  }
  const result = {
    hasText: Boolean(parsed.hasText),
    textRegions: normalizeRectList(parsed.textRegions),
    interestRegions: normalizeInterestList(parsed.interestRegions),
    summary: typeof parsed.summary === 'string' ? parsed.summary : String(parsed.summary ?? ''),
    raw
  };
  await resultCacheSet(cacheKey, result);
  return result;
}

/**
 * 区域识别：发单张图（detail:'original'）+ system（区域识别助手）+ user（含 label/question），
 * 调 callChat 返回区域详细描述。
 * @param {object} opts - {apiKey, baseURL, model, buffer, mediaType, label='', question='',
 *                          signal, fetchImpl, timeoutMs, maxTokens=8192}
 * @returns {Promise<{description:string, raw:string}>}
 */
export async function recognizeRegion(opts) {
  const {
    apiKey, baseURL, model, buffer,
    mediaType = 'image/png', label = '', question = '',
    signal, fetchImpl, timeoutMs, maxTokens = 8192,
    apiCfg // v1.0.0：端点画像配置
  } = opts;
  if (!buffer) throw new Error('vision-client: recognizeRegion 需要 buffer（图片字节）');

  // v1.0.0 性能改造：结果缓存（批量场景下重复图/重跑同目录直接命中）
  const cacheKey = resultCacheKey(buffer, {
    kind: 'region', model, base: apiCfg?.baseURL ?? baseURL,
    provider: apiCfg?.provider ?? 'deepseek', label, question,
    maxTokens, detail: 'original', schema: 'region-v1'
  });
  const cached = await resultCacheGet(cacheKey);
  if (cached) return { ...cached.value, cached: true };

  // user 文本：区域名（label）+ 补充问题（question），均可为空
  const parts = [];
  if (label.trim().length > 0) parts.push(`【区域】${label.trim()}`);
  if (question.trim().length > 0) parts.push(`【问题】${question.trim()}`);
  parts.push('请详细描述这个区域的完整内容与其中的全部文字。');

  const res = await callChat({
    apiKey, baseURL, model, apiCfg,
    system: REGION_SYSTEM,
    userText: parts.join('\n'),
    images: [{ buffer, mediaType }],
    maxTokens,
    detail: 'original',
    thinking: 'disabled', // 区域识别为短任务：关闭思考直出描述（避免空正文）
    signal, fetchImpl, timeoutMs
  });
  const result = { description: res.content, raw: res.content };
  // 只缓存有正文的结果（空正文多为端点/限额问题，不该被固化）
  if (res.content.trim().length > 0) await resultCacheSet(cacheKey, result);
  return result;
}
