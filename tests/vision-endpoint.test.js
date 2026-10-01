// tests/vision-endpoint.test.js — v1.0.0 端点泛化在 vision-client 层的接线验证
//
// 单测 api-profile 只能证明「描述对象算得对」；本文件证明**请求真的按画像发出去了**：
// URL、认证头、专有字段开关、以及三类自动回退（/v1 前缀、token 字段、专有字段）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { callChat } from '../src/vision-client.js';

const ORIG = { ...process.env };
before(() => { process.env.DSH_RESULT_CACHE = '0'; });
after(() => { process.env = { ...ORIG }; });

/** 记录每次请求的假端点 */
function recorder(responses) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return {
      ok: r.status === undefined || (r.status >= 200 && r.status < 300),
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.payload ?? { choices: [{ message: { content: r.content ?? 'OK' } }] })
    };
  };
  return { fetchImpl, calls };
}

test('端点泛化：OpenAI 兼容画像 —— 不发 thinking/detail，且允许空 key（本地端点）', async () => {
  const { fetchImpl, calls } = recorder([{ content: '本地模型回答' }]);
  const res = await callChat({
    apiCfg: { provider: 'auto', baseURL: 'http://localhost:8000/v1', model: 'qwen2.5-vl' },
    apiKey: '',
    system: 'S',
    userText: 'U',
    images: [{ buffer: Buffer.from('x'), mediaType: 'image/jpeg' }],
    fetchImpl
  });
  assert.equal(res.content, '本地模型回答');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8000/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, undefined, '无 key 不应带认证头');
  assert.equal('thinking' in calls[0].body, false, '非 DeepSeek 画像不应下发 thinking（会 400）');
  const imgPart = calls[0].body.messages.at(-1).content.find((c) => c.type === 'image_url');
  assert.equal(imgPart.image_url.detail, 'high', 'original 在非 DeepSeek 画像下降级为 high');
});

test('端点泛化：DeepSeek 画像保持旧行为（detail=original + thinking 照发 + Bearer）', async () => {
  const { fetchImpl, calls } = recorder([{ content: 'DS 回答' }]);
  await callChat({
    apiCfg: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' },
    apiKey: 'sk-1',
    system: 'S', userText: 'U',
    images: [{ buffer: Buffer.from('x'), mediaType: 'image/png' }],
    detail: 'original', thinking: 'disabled',
    fetchImpl
  });
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer sk-1');
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  const imgPart = calls[0].body.messages.at(-1).content.find((c) => c.type === 'image_url');
  assert.equal(imgPart.image_url.detail, 'original');
});

test('端点泛化：extra_headers / extra_body 真的进了请求', async () => {
  const { fetchImpl, calls } = recorder([{ content: 'ok' }]);
  await callChat({
    apiCfg: {
      provider: 'openai', baseURL: 'https://x.openai.azure.com', model: 'gpt-vision',
      apiPath: '/openai/deployments/d/chat/completions?api-version=2024-10-21',
      extraHeaders: { 'api-key': 'azure-key' },
      extraBody: { temperature: 0.2 }
    },
    apiKey: 'should-be-ignored',
    system: '', userText: 'U', images: [],
    fetchImpl
  });
  assert.match(calls[0].url, /api-version=2024-10-21$/);
  assert.equal(calls[0].headers['api-key'], 'azure-key');
  assert.equal(calls[0].headers.authorization, undefined, '用户自带 api-key 时不应再带 Bearer');
  assert.equal(calls[0].body.temperature, 0.2);
});

test('自动回退①：404 → 切 /v1 前缀重试一次（用户没显式给路径时）', async () => {
  const { fetchImpl, calls } = recorder([
    { status: 404, payload: { error: { message: 'not found', code: 'nf' } } },
    { content: '重试成功' }
  ]);
  const res = await callChat({
    apiCfg: { provider: 'openai', baseURL: 'http://localhost:8000', model: 'm' },
    apiKey: '', userText: 'U', fetchImpl
  });
  assert.equal(res.content, '重试成功');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://localhost:8000/chat/completions');
  assert.equal(calls[1].url, 'http://localhost:8000/v1/chat/completions', '404 后应补 /v1 重试');
});

test('自动回退①：用户显式给了 apiPath 时**不猜**路径（404 直接报错）', async () => {
  const { fetchImpl, calls } = recorder([{ status: 404, payload: { error: { message: 'nope', code: 'nf' } } }]);
  await assert.rejects(
    () => callChat({
      apiCfg: { provider: 'openai', baseURL: 'http://localhost:8000', apiPath: '/custom/path', model: 'm' },
      apiKey: '', userText: 'U', fetchImpl
    }),
    /404/
  );
  assert.equal(calls.length, 1, '不应擅自换路径再试');
});

test('自动回退②：400 说 max_tokens 不支持 → 自动换 max_completion_tokens 再试一次', async () => {
  const { fetchImpl, calls } = recorder([
    { status: 400, payload: { error: { message: 'Unsupported parameter: max_tokens; use max_completion_tokens', code: 'bad' } } },
    { content: '换字段后成功' }
  ]);
  const res = await callChat({
    apiCfg: { provider: 'openai', baseURL: 'http://localhost:8000/v1', model: 'gpt-5-ish' },
    apiKey: '', userText: 'U', maxTokens: 1234, fetchImpl
  });
  assert.equal(res.content, '换字段后成功');
  assert.equal(calls.length, 2);
  assert.ok('max_tokens' in calls[0].body);
  assert.equal(calls[1].body.max_completion_tokens, 1234, '第二次应改用 max_completion_tokens');
  assert.equal('max_tokens' in calls[1].body, false);
  // 且字段切换被记住：后续调用直接用新字段
  const third = recorder([{ content: 'x' }]);
  await callChat({
    apiCfg: { provider: 'openai', baseURL: 'http://localhost:8000/v1', model: 'gpt-5-ish' },
    apiKey: '', userText: 'U', fetchImpl: third.fetchImpl
  });
  assert.ok('max_tokens' in third.calls[0].body, '新的一次 callChat 是独立状态（记忆不跨调用，符合当前实现）');
});

test('自动回退③：400 说 thinking 字段不认识 → 剔除该字段重试', async () => {
  const { fetchImpl, calls } = recorder([
    { status: 400, payload: { error: { message: 'unknown field thinking', code: 'bad' } } },
    { content: '去掉 thinking 后成功' }
  ]);
  const res = await callChat({
    apiCfg: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', model: 'm', thinkingMode: 'auto' },
    apiKey: 'k', userText: 'U', thinking: 'disabled', fetchImpl
  });
  assert.equal(res.content, '去掉 thinking 后成功');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  assert.equal('thinking' in calls[1].body, false, '第二次应剔除 thinking');
});

test('端点泛化：HTTP 200 但业务失败（base_resp）不能被当成成功', async () => {
  const { fetchImpl } = recorder([{ payload: { base_resp: { status_code: 1002, status_msg: '余额不足' }, choices: [] } }]);
  await assert.rejects(
    () => callChat({
      apiCfg: { provider: 'openai', baseURL: 'http://localhost:8000/v1', model: 'm' },
      apiKey: '', userText: 'U', fetchImpl
    }),
    (err) => {
      assert.match(err.message, /未输出正文/);
      assert.match(err.message, /余额不足/, '业务错误原因必须透出，不能只报「空正文」');
      return true;
    }
  );
});
