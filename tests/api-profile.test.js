// tests/api-profile.test.js — v1.0.0 端点画像（多模态端点泛化）
// 覆盖：画像判定、URL 拼接、认证头与自定义头、detail/thinking/token 字段开关、
//       请求体组装（含 DeepSeek 行为逐字段回归）、错误分类、响应解析（含 200 业务失败）、/v1 切换建议。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROFILES, PROFILE_IDS, detectProfileId, resolveProfileId, composeUrl, buildHeaders,
  sanitizeHeaders, resolveDetail, resolveThinking, resolveMaxTokensField, mergeExtraBody,
  buildRequest, classifyHttpError, extractAssistantText, suggestV1Toggle
} from '../src/api-profile.js';

const DS = { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp', maxTokens: 8192 };

test('画像判定：显式优先，auto 按 baseURL 特征', () => {
  assert.equal(detectProfileId('https://api.deepseek.com'), 'deepseek');
  assert.equal(detectProfileId('https://api.openai.com/v1'), 'openai');
  assert.equal(detectProfileId('http://localhost:8000/v1'), 'openai');
  assert.equal(detectProfileId('https://open.bigmodel.cn/api/paas/v4'), 'openai');
  assert.equal(resolveProfileId('deepseek', 'http://localhost:8000/v1'), 'deepseek', '显式配置压过自动判定');
  assert.equal(resolveProfileId('auto', 'https://api.deepseek.com'), 'deepseek');
  assert.equal(resolveProfileId('不认识的值', 'https://api.deepseek.com'), 'deepseek', '非法值回落自动判定');
  assert.equal(resolveProfileId(undefined, 'http://localhost:8000/v1'), 'openai');
  assert.deepEqual(PROFILE_IDS, ['auto', 'deepseek', 'openai', 'minimal']);
});

test('composeUrl：路径拼接与各种边界', () => {
  assert.equal(composeUrl('https://api.deepseek.com', '', PROFILES.deepseek), 'https://api.deepseek.com/chat/completions');
  assert.equal(composeUrl('https://api.deepseek.com/', '', PROFILES.deepseek), 'https://api.deepseek.com/chat/completions', '尾部斜杠要去掉');
  assert.equal(composeUrl('http://localhost:8000/v1', '', PROFILES.openai), 'http://localhost:8000/v1/chat/completions');
  assert.equal(composeUrl('https://api.deepseek.com/chat/completions', '', PROFILES.deepseek), 'https://api.deepseek.com/chat/completions', '已是完整 URL 不再追加');
  assert.equal(composeUrl('https://api.deepseek.com', '/v2/chat/completions', PROFILES.deepseek), 'https://api.deepseek.com/v2/chat/completions', 'api_path 覆盖');
  assert.equal(composeUrl('https://x.azure.com/openai', '?api-version=2024-10-21', PROFILES.openai), 'https://x.azure.com/openai?api-version=2024-10-21', '带 query 的逃生口');
});

test('buildHeaders：认证头与用户覆盖（含头注入防护）', () => {
  assert.deepEqual(buildHeaders(PROFILES.deepseek, 'sk-1'), {
    'content-type': 'application/json', authorization: 'Bearer sk-1'
  });
  assert.deepEqual(buildHeaders(PROFILES.deepseek, ''), { 'content-type': 'application/json' }, '无 key 时不带认证头（本地端点常态）');
  const azure = buildHeaders(PROFILES.openai, 'k', { 'api-key': 'k2' });
  assert.equal(azure['api-key'], 'k2');
  assert.equal(azure.authorization, undefined, '用户显式给 api-key 时不应再带 Bearer（Azure 会报错）');
  const custom = buildHeaders(PROFILES.deepseek, 'k', { authorization: 'Bearer 用户自己的' });
  assert.equal(custom.authorization, 'Bearer 用户自己的', '同名自定义头应覆盖自动生成的头');
  const noKeyOwn = buildHeaders(PROFILES.openai, '', { 'x-api-key': 'k3' });
  assert.equal(noKeyOwn['x-api-key'], 'k3');
  const inj = sanitizeHeaders({ 'x-a\r\nX-Evil: 1': 'v', 'x-b': 'v2\r\nX-Evil: 2', bad: { obj: 1 } });
  assert.equal(inj['x-aX-Evil: 1'], undefined);
  assert.ok(!Object.keys(inj).some((k) => /\r|\n/.test(k)));
  assert.ok(!Object.values(inj).some((v) => /\r|\n/.test(v)));
  assert.equal(inj.bad, undefined, '非字符串值应被丢弃');
});

test('resolveDetail：只发共同安全子集（DeepSeek 保持原样，其余降级 high）', () => {
  assert.equal(resolveDetail(PROFILES.deepseek, 'original'), 'original', 'DeepSeek 必须原样透传（回归红线）');
  assert.equal(resolveDetail(PROFILES.deepseek, 'low'), 'low');
  assert.equal(resolveDetail(PROFILES.openai, 'original'), 'high', '非 DeepSeek 的 original → high');
  assert.equal(resolveDetail(PROFILES.openai, 'low'), 'low');
  assert.equal(resolveDetail(PROFILES.openai, 'original', 'low'), 'low', '配置显式指定优先');
  assert.equal(resolveDetail(PROFILES.openai, 'original', 'off'), undefined, '配置 off → 不发');
  assert.equal(resolveDetail(PROFILES.minimal, 'low'), undefined, '画像不支持 → 不发');
});

test('resolveThinking：仅 DeepSeek 画像默认下发，其余默认不发（发了会 400）', () => {
  assert.deepEqual(resolveThinking(PROFILES.deepseek, 'disabled'), 'disabled');
  assert.equal(resolveThinking(PROFILES.deepseek, undefined), undefined);
  assert.equal(resolveThinking(PROFILES.openai, 'disabled'), undefined, '非 DeepSeek 默认不发 thinking');
  assert.equal(resolveThinking(PROFILES.deepseek, 'disabled', 'off'), undefined, '配置 off 强制不发');
  assert.equal(resolveThinking(PROFILES.deepseek, undefined, 'on'), 'enabled', '配置 on 强制发');
  assert.equal(resolveThinking(PROFILES.openai, undefined, 'on'), undefined, '画像不支持时 on 也不发（防 400）');
});

test('resolveMaxTokensField：默认按画像，配置可覆盖', () => {
  assert.equal(resolveMaxTokensField(PROFILES.deepseek), 'max_tokens');
  assert.equal(resolveMaxTokensField(PROFILES.deepseek, 'max_completion_tokens'), 'max_completion_tokens');
  assert.equal(resolveMaxTokensField(PROFILES.openai, 'auto'), 'max_tokens');
});

test('mergeExtraBody：合入用户字段，但绝不允许覆盖 messages', () => {
  const out = mergeExtraBody({ model: 'm', messages: [1] }, { temperature: 0.2, messages: [2], model: 'm2' });
  assert.deepEqual(out.messages, [1], 'messages 是硬保护，不允许被覆盖');
  assert.equal(out.temperature, 0.2);
  assert.equal(out.model, 'm2', '其余字段用户显式优先');
});

test('buildRequest：DeepSeek 画像与 v0.5.0 行为逐字段一致（回归红线）', () => {
  const img = { buffer: Buffer.from([1, 2, 3]), mediaType: 'image/png' };
  const req = buildRequest({
    cfg: { ...DS, thinkingMode: 'auto', imageDetail: 'auto', maxTokensField: 'auto' },
    apiKey: 'sk-x',
    system: 'SYS',
    userText: 'TXT',
    images: [img],
    maxTokens: 4096,
    detail: 'original',
    thinking: 'disabled'
  });
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer sk-x');
  assert.equal(req.tokenField, 'max_tokens');
  assert.deepEqual(Object.keys(req.body), ['model', 'messages', 'max_tokens', 'stream', 'thinking'], '字段集合应与旧版一致（仅多出可选的 thinking）');
  assert.equal(req.body.max_tokens, 4096);
  assert.equal(req.body.stream, false);
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.equal(req.body.messages[0].role, 'system');
  const parts = req.body.messages[1].content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.detail, 'original', 'DeepSeek 必须保留 original');
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
});

test('buildRequest：OpenAI 兼容画像默认不发专有字段，且 max_tokens 可换名', () => {
  const req = buildRequest({
    cfg: { provider: 'auto', baseURL: 'http://localhost:8000/v1', model: 'qwen-vl', maxTokensField: 'max_completion_tokens' },
    apiKey: '',
    userText: 'TXT',
    images: [{ buffer: Buffer.from('x'), mediaType: 'image/jpeg' }],
    maxTokens: 512,
    detail: 'original',
    thinking: 'disabled'
  });
  assert.equal(req.url, 'http://localhost:8000/v1/chat/completions');
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.tokenField, 'max_completion_tokens');
  assert.ok('max_completion_tokens' in req.body);
  assert.ok(!('max_tokens' in req.body));
  assert.equal(req.detail, 'high', 'original 在非 DeepSeek 画像下降级 high');
  assert.equal('thinking' in req.body, false, '非 DeepSeek 不发 thinking');
});

test('buildRequest：extraBody 透传（temperature 等），images 为空时 body 仍合法', () => {
  const req = buildRequest({
    cfg: { ...DS, extraBody: { temperature: 0.1, top_p: 0.9 } },
    apiKey: 'k', system: '', userText: 'only text', images: [], maxTokens: 100
  });
  assert.equal(req.body.temperature, 0.1);
  assert.equal(req.body.top_p, 0.9);
  assert.equal(req.body.messages.length, 1, '无 system 时只有 user 消息');
  assert.equal(req.body.messages[0].content[0].type, 'text');
});

test('classifyHttpError：错误语义分类（决定重试与否）', () => {
  assert.deepEqual(classifyHttpError(404, 'not found'), { kind: 'path', retryable: false, toggleV1: true });
  assert.equal(classifyHttpError(429, '').retryable, true);
  assert.equal(classifyHttpError(503, '').retryable, true);
  assert.equal(classifyHttpError(401, '').retryable, false);
  assert.equal(classifyHttpError(413, '').kind, 'too-large');
  assert.equal(classifyHttpError(400, 'Unsupported parameter: max_completion_tokens').suggestTokenField, 'max_completion_tokens');
  assert.equal(classifyHttpError(400, 'unknown field thinking').offendingField, 'thinking');
  assert.equal(classifyHttpError(400, 'invalid image detail value').offendingField, 'detail');
  assert.equal(classifyHttpError(400, 'bad request').kind, 'client');
});

test('extractAssistantText：正常正文', () => {
  const r = extractAssistantText({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] });
  assert.equal(r.content, '你好');
  assert.equal(r.emptyReason, null);
});

test('extractAssistantText：HTTP 200 但业务失败必须被识别（MiniMax base_resp）', () => {
  const r = extractAssistantText({ base_resp: { status_code: 1002, status_msg: 'rate limited' }, choices: [] });
  assert.equal(r.content, '');
  assert.match(r.emptyReason, /业务错误/);
  assert.match(r.emptyReason, /rate limited/);
});

test('extractAssistantText：空正文的成因要分开报（不能一律"识别失败"）', () => {
  const len = extractAssistantText({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
  assert.match(len.emptyReason, /token 上限/);
  const filt = extractAssistantText({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
  assert.match(filt.emptyReason, /内容安全/);
  const rea = extractAssistantText({ choices: [{ message: { content: '', reasoning_content: '思考中…' }, finish_reason: 'stop' }] });
  assert.match(rea.emptyReason, /思维链/);
  assert.equal(rea.reasoning, '思考中…');
  const unknown = extractAssistantText({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  assert.match(unknown.emptyReason, /响应为空/);
});

test('suggestV1Toggle：只在用户没显式给路径时猜 /v1（返回新的 baseURL，不是完整 URL）', () => {
  assert.equal(suggestV1Toggle({ baseURL: 'http://localhost:8000' }).baseURL, 'http://localhost:8000/v1');
  assert.equal(suggestV1Toggle({ baseURL: 'http://localhost:8000/v1' }).baseURL, 'http://localhost:8000', '带 /v1 仍 404 → 去掉再试');
  assert.equal(suggestV1Toggle({ baseURL: 'http://x/y', apiPath: '/custom' }), null, '用户显式给了路径 → 不猜');
  assert.equal(suggestV1Toggle({ baseURL: 'https://api.deepseek.com/chat/completions' }), null, '已是完整 URL → 不猜');
});
