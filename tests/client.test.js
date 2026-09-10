/**
 * client.test.js — 针对 vision-client.js API 客户端的单元测试（mock fetch，不真调网络）
 *
 * 覆盖：
 *  - buildRequestBody：请求体结构（system / user 消息、图只放 user、detail=original）
 *  - callChat：成功调用、API 错误、URL/鉴权/body 校验
 *  - checkImageBatchLimits：图片数量与单张大小限制
 *  - recognize：single 模式（单请求）与 layered 模式（分组+聚合）编排
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequestBody,
  callChat,
  checkImageBatchLimits,
  splitGroups,
  estimateBase64Bytes,
  MAX_IMAGES_PER_REQUEST,
  MAX_SINGLE_IMAGE_BYTES,
  recognize
} from '../src/vision-client.js';

/* ------------------------------------------------------------------ */
/* buildRequestBody                                                    */
/* ------------------------------------------------------------------ */

test('buildRequestBody 组装系统消息 + 带图片的 user 消息', () => {
  const images = [
    { buffer: Buffer.alloc(16), mediaType: 'image/png' },
    { buffer: Buffer.alloc(16), mediaType: 'image/png' }
  ];
  const model = 'deepseek-v4-flash-vision-exp';
  const body = buildRequestBody({ model, system: '系统说明', userText: '请描述图片', images, maxTokens: 2048, detail: 'original' });

  // 模型名正确
  assert.equal(body.model, model);
  // messages[0] 为 system 文本
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[0].content, '系统说明');
  // messages[1] 为 user，content 是数组
  assert.equal(body.messages[1].role, 'user');
  const content = body.messages[1].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[0].text, '请描述图片');
  // 两张图片是 image_url
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[2].type, 'image_url');
  // 图片 data URL 前缀正确
  assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(content[2].image_url.url.startsWith('data:image/png;base64,'));
  // detail 为 original（保持原图，不降采样）
  assert.equal(content[1].image_url.detail, 'original');
  assert.equal(content[2].image_url.detail, 'original');
  // 非流式
  assert.equal(body.stream, false);
});

test('buildRequestBody 无 userText 时只有图片，无 text 块', () => {
  const images = [{ buffer: Buffer.alloc(16), mediaType: 'image/png' }];
  const body = buildRequestBody({ model: 'm', system: 's', userText: '   ', images });
  const content = body.messages[1].content;
  assert.equal(content[0].type, 'image_url'); // 文本被 trim 后为空 → 无 text 块
});

test('buildRequestBody 支持思考模式开关（thinking enabled/disabled）', () => {
  const images = [{ buffer: Buffer.alloc(16), mediaType: 'image/png' }];
  // 不传 → 请求体无 thinking 字段（官方默认启用思考）
  const dft = buildRequestBody({ model: 'm', images });
  assert.equal(dft.thinking, undefined);
  // 显式 disabled → 携带 {"thinking":{"type":"disabled"}}（关闭思考，预检/区域识别用）
  const off = buildRequestBody({ model: 'm', images, thinking: 'disabled' });
  assert.deepEqual(off.thinking, { type: 'disabled' });
  const on = buildRequestBody({ model: 'm', images, thinking: 'enabled' });
  assert.deepEqual(on.thinking, { type: 'enabled' });
});

/* ------------------------------------------------------------------ */
/* callChat — 成功调用                                                  */
/* ------------------------------------------------------------------ */

test('callChat 成功调用：URL/鉴权/返回值/图片仅 user 消息', async () => {
  const captured = [];
  const fetchImpl = async (url, opts) => {
    captured.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 30 }
      })
    };
  };

  const images = [{ buffer: Buffer.alloc(16), mediaType: 'image/png' }];
  const res = await callChat({
    apiKey: 'test-key',
    model: 'deepseek-v4-flash-vision-exp',
    system: '系统说明',
    userText: '描述图片',
    images,
    fetchImpl
  });

  assert.equal(captured.length, 1);
  const { url, opts } = captured[0];
  // URL 以 /chat/completions 结尾
  assert.ok(url.endsWith('/chat/completions'));
  // Authorization Bearer
  assert.equal(opts.headers.authorization, 'Bearer test-key');
  assert.equal(opts.headers['content-type'], 'application/json');
  // 方法
  assert.equal(opts.method, 'POST');

  // 请求体：图片只在 user 消息
  const body = JSON.parse(opts.body);
  assert.equal(body.messages[0].role, 'system');
  assert.ok(typeof body.messages[0].content === 'string'); // system 是纯文本
  const userContent = body.messages[1].content;
  const hasImage = userContent.some((c) => c.type === 'image_url');
  assert.ok(hasImage);
  // 图片只允许出现在 user 消息：system 等非 user 消息必须是纯文本字符串（无 image_url）
  for (const m of body.messages) {
    if (m.role !== 'user') {
      assert.equal(typeof m.content, 'string', `${m.role} 消息应为纯文本`);
    }
  }

  // 返回值（本插件不解析 usage/token，只返回内容文本）
  assert.equal(res.content, '你好');
  assert.equal(res.usage, undefined);
});

/* ------------------------------------------------------------------ */
/* callChat — API 错误                                                  */
/* ------------------------------------------------------------------ */

test('callChat 遇到 API 错误时给出 HTTP 状态码', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: 'x', code: 'y' } })
  });
  await assert.rejects(
    () => callChat({ apiKey: 'test-key', model: 'm', system: 's', userText: 'u', fetchImpl }),
    (err) => {
      assert.ok(err.message.includes('API error HTTP 400'));
      assert.ok(err.message.includes('x'));
      assert.ok(err.message.includes('y'));
      return true;
    }
  );
});

test('callChat 缺少 apiKey 时抛错', async () => {
  await assert.rejects(
    () => callChat({ model: 'm', system: 's', userText: 'u', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) }),
    /missing DeepSeek API key/
  );
});

/* ------------------------------------------------------------------ */
/* callChat — 空 content 自动重试（模型思考后未落正文）                   */
/* ------------------------------------------------------------------ */

test('callChat：content 为空（有 reasoning）时自动增大 max_tokens 重试一次', async () => {
  const calls = []; // 记录每次请求的 max_tokens
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.max_tokens);
    const emptyFirst = calls.length === 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(emptyFirst ? {
        choices: [{
          message: { content: '', reasoning_content: '我在思考…' },
          finish_reason: 'length'
        }]
      } : {
        choices: [{ message: { content: '重试后的正文' }, finish_reason: 'stop' }]
      })
    };
  };
  const res = await callChat({ apiKey: 'test-key', model: 'm', userText: 'u', maxTokens: 2048, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 2048);
  assert.equal(calls[1], 2048 + 4096); // 重试时放大 max_tokens
  assert.equal(res.content, '重试后的正文');
  assert.equal(res.retried, true);
});

test('callChat：重试后 content 仍为空时抛出带 finish_reason/reasoning 摘要的错误', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: '', reasoning_content: '思考内容摘要XYZ' }, finish_reason: 'length' }]
    })
  });
  await assert.rejects(
    () => callChat({ apiKey: 'test-key', model: 'm', userText: 'u', fetchImpl }),
    (err) => {
      assert.ok(err.message.includes('未输出正文'));
      assert.ok(err.message.includes('finish_reason=length'));
      assert.ok(err.message.includes('思考内容摘要XYZ'));
      return true;
    }
  );
});

test('callChat：空正文最多重试 2 次（+4096、再 +8192）', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.max_tokens);
    const ok = calls.length === 3; // 第 3 次才成功
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: ok ? '第三次成功正文' : '' }, finish_reason: ok ? 'stop' : 'length' }]
      })
    };
  };
  const res = await callChat({ apiKey: 'test-key', model: 'm', userText: 'u', maxTokens: 2048, fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[1], 2048 + 4096);
  assert.equal(calls[2], 2048 + 4096 + 8192);
  assert.equal(res.content, '第三次成功正文');
});

test('callChat：中止时错误信息可读（不输出 [object Object]）', async () => {
  const controller = new AbortController();
  const fetchImpl = async () => {
    controller.abort(new Error('会话被用户中断'));
    throw controller.signal.reason; // 异常对象（无 message 的场景由 reason 兜底）
  };
  await assert.rejects(
    () => callChat({ apiKey: 'test-key', model: 'm', userText: 'u', signal: controller.signal, fetchImpl }),
    (err) => {
      assert.ok(err.message.includes('request aborted'));
      assert.ok(!err.message.includes('[object Object]'));
      assert.ok(err.message.includes('会话被用户中断'));
      return true;
    }
  );
});

/* ------------------------------------------------------------------ */
/* checkImageBatchLimits                                               */
/* ------------------------------------------------------------------ */

test('checkImageBatchLimits：图片数超上限', () => {
  const images241 = Array.from({ length: 241 }, () => ({ buffer: Buffer.alloc(1000) }));
  assert.equal(checkImageBatchLimits(images241).ok, false);

  const images600 = Array.from({ length: 600 }, () => ({ buffer: Buffer.alloc(1000) }));
  assert.equal(checkImageBatchLimits(images600).ok, false);
  // 600 已超过 240（官方 600 → 保守上限 240）
  assert.ok(images600.length > MAX_IMAGES_PER_REQUEST);
});

test('checkImageBatchLimits：单张超过 32MiB', () => {
  const images = [
    { buffer: Buffer.alloc(33 * 1024 * 1024) },
    { buffer: Buffer.alloc(33 * 1024 * 1024) }
  ];
  assert.equal(checkImageBatchLimits(images).ok, false);
  assert.ok(images[0].buffer.byteLength > MAX_SINGLE_IMAGE_BYTES);
});

test('checkImageBatchLimits：小图正常通过', () => {
  const images = [
    { buffer: Buffer.alloc(1000) },
    { buffer: Buffer.alloc(1000) }
  ];
  assert.equal(checkImageBatchLimits(images).ok, true);
});

test('estimateBase64Bytes 按 4/3 估算', () => {
  assert.equal(estimateBase64Bytes([{ buffer: Buffer.alloc(3) }]), 4);
});

/* ------------------------------------------------------------------ */
/* splitGroups                                                          */
/* ------------------------------------------------------------------ */

test('splitGroups 按 groupSize 顺序切分', () => {
  const tiles = Array.from({ length: 90 }, (_, i) => ({ i }));
  const groups = splitGroups(tiles, 40);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].length, 40);
  assert.equal(groups[1].length, 40);
  assert.equal(groups[2].length, 10);
  // 顺序保持：组1 取 0..39，组3 取 80..89
  assert.equal(groups[0][0].i, 0);
  assert.equal(groups[2][groups[2].length - 1].i, 89);
});

/* ------------------------------------------------------------------ */
/* recognize — single 模式                                              */
/* ------------------------------------------------------------------ */

test('recognize single 模式：单请求、图片数、答案', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: '整图描述' } }]
      })
    };
  };

  const tiles = [
    { row: 0, col: 0, x: 0, y: 0, w: 800, h: 800, buffer: Buffer.alloc(100), mediaType: 'image/png' },
    { row: 0, col: 1, x: 800, y: 0, w: 800, h: 800, buffer: Buffer.alloc(100), mediaType: 'image/png' }
  ];
  const grid = { rows: 1, cols: 2 };

  const res = await recognize({
    apiKey: 'test-key',
    model: 'deepseek-v4-flash-vision-exp',
    width: 1600,
    height: 800,
    tiles,
    grid,
    question: '描述',
    mode: 'single',
    fetchImpl
  });

  assert.equal(res.mode, 'single');
  assert.equal(res.imageCount, 2);
  assert.equal(callCount, 1);
  assert.equal(res.answer, '整图描述');
  // 按需求：recognize 不代为统计/不显示 token 与费用 → 返回中不应出现 usage/cost 字段
  assert.equal(res.usage, undefined);
  assert.equal(res.cost, undefined);
});

/* ------------------------------------------------------------------ */
/* recognize — layered 模式                                             */
/* ------------------------------------------------------------------ */

test('recognize layered 模式：3 组 + 1 聚合，聚合请求无图片', async () => {
  const callImgCounts = []; // 每次调用的图片数量
  let callCount = 0;
  const fetchImpl = async (url, opts) => {
    callCount += 1;
    const body = JSON.parse(opts.body);
    const userContent = body.messages.find((m) => m.role === 'user').content;
    const imgCount = (userContent || []).filter((c) => c.type === 'image_url').length;
    callImgCounts.push(imgCount);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: 'result' } }]
      })
    };
  };

  const tiles = Array.from({ length: 90 }, (_, i) => ({
    row: Math.floor(i / 10),
    col: i % 10,
    x: (i % 10) * 800,
    y: Math.floor(i / 10) * 800,
    w: 800,
    h: 800,
    buffer: Buffer.alloc(100),
    mediaType: 'image/png'
  }));
  const grid = { rows: 9, cols: 10 };

  const res = await recognize({
    apiKey: 'test-key',
    model: 'deepseek-v4-flash-vision-exp',
    width: 1600,
    height: 800,
    tiles,
    grid,
    mode: 'layered',
    groupSize: 40,
    fetchImpl
  });

  // 3 组（40/40/10）+ 1 聚合 = 4 次调用
  assert.equal(callCount, 4);
  assert.equal(res.mode, 'layered');
  assert.equal(res.groups, 3);
  // 3 个组请求各携带 40/40/10 张图
  assert.equal(callImgCounts[0], 40);
  assert.equal(callImgCounts[1], 40);
  assert.equal(callImgCounts[2], 10);
  // 最后 1 次（聚合）无图片（images 空）—— 注意：仅有最后一个请求是聚合且无图
  assert.equal(callImgCounts[callImgCounts.length - 1], 0);
  assert.equal(callImgCounts.length, 4);
});
