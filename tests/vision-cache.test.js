// tests/vision-cache.test.js — v1.0.0「视觉结果缓存」接线验证
// 反证式断言：第二次调用**必须不再发请求**（fetchImpl 直接抛错），
// 否则说明缓存没接上——这类"没报错就算过"的检查最容易假绿。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { previewImage, recognizeRegion } from '../src/vision-client.js';

let dir;
const ORIG = { ...process.env };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-vcache-'));
  process.env.DSH_RESULT_CACHE_DIR = dir;
  delete process.env.DSH_RESULT_CACHE;
});
after(async () => {
  process.env = { ...ORIG };
  await rm(dir, { recursive: true, force: true });
});

/** 会记账的假端点：返回固定内容；第二次被调用即视为"缓存失效" */
function countingFetch(content, counter) {
  return async () => {
    counter.n += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })
    };
  };
}

const PREVIEW_JSON = JSON.stringify({
  hasText: true,
  textRegions: [{ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.3, isHandwrite: false }],
  interestRegions: [{ x0: 0, y0: 0, x1: 1, y1: 1, label: '图表' }],
  summary: '整图概要'
});

test('previewImage：首次发请求，第二次命中缓存（不再发请求）', async () => {
  const buf = Buffer.from('preview-image-bytes-1');
  const counter = { n: 0 };
  const fetchImpl = countingFetch(PREVIEW_JSON, counter);

  const r1 = await previewImage({ apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl });
  assert.equal(counter.n, 1, '首次应发一次请求');
  assert.equal(r1.cached, undefined);
  assert.equal(r1.summary, '整图概要');

  const r2 = await previewImage({ apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl });
  assert.equal(counter.n, 1, '第二次不应再发请求（这就是缓存生效的可观察证据）');
  assert.equal(r2.cached, true);
  assert.deepEqual(r2.textRegions, r1.textRegions);
  assert.equal(r2.summary, r1.summary);
});

test('previewImage：参数变化必须 miss（换模型/换提问/换端点/换图）', async () => {
  const buf = Buffer.from('preview-image-bytes-2');
  const counter = { n: 0 };
  const fetchImpl = countingFetch(PREVIEW_JSON, counter);
  const base = { apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl };

  await previewImage(base);
  await previewImage({ ...base, model: 'other-model' });      // 换模型 → 新键
  await previewImage({ ...base, question: '关注表格' });        // 换提问 → 新键
  await previewImage({ ...base, baseURL: 'http://localhost:8000/v1' }); // 换端点 → 新键
  await previewImage({ ...base, buffer: Buffer.from('别的图') });      // 换图 → 新键
  assert.equal(counter.n, 5, `5 组不同参数应各发一次请求，实际 ${counter.n}`);
});

test('previewImage：解析失败的结果不进缓存（错误不被固化）', async () => {
  const buf = Buffer.from('preview-bad-json');
  const counter = { n: 0 };
  const fetchImpl = countingFetch('这不是 JSON，只是一段兜底文字', counter);
  const r1 = await previewImage({ apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl });
  assert.equal(r1.parseError, true);
  await previewImage({ apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl });
  assert.equal(counter.n, 2, '失败结果不缓存 → 第二次仍应重试（否则用户永远看不到修复后的结果）');
});

test('recognizeRegion：命中缓存后不再发请求，且返回值一致', async () => {
  const buf = Buffer.from('region-image-bytes-1');
  const counter = { n: 0 };
  const fetchImpl = countingFetch('区域里有一张表格，写着「测试」', counter);
  const args = { apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, label: '表格区', question: '读出文字', fetchImpl };

  const r1 = await recognizeRegion(args);
  assert.equal(counter.n, 1);
  assert.match(r1.description, /表格/);
  const r2 = await recognizeRegion(args);
  assert.equal(counter.n, 1, '第二部分不应再发请求');
  assert.equal(r2.cached, true);
  assert.equal(r2.description, r1.description);
  // 换个 label（语义上不同的请求）→ 必须 miss
  await recognizeRegion({ ...args, label: '另一个区域' });
  assert.equal(counter.n, 2);
});

test('识别缓存：DSH_RESULT_CACHE=0 时完全绕过（不读也不写）', async () => {
  const buf = Buffer.from('cache-disabled-bytes');
  const counter = { n: 0 };
  const fetchImpl = countingFetch(PREVIEW_JSON, counter);
  const args = { apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm', buffer: buf, fetchImpl };

  await previewImage(args);
  process.env.DSH_RESULT_CACHE = '0';
  await previewImage(args);
  await previewImage(args);
  delete process.env.DSH_RESULT_CACHE;
  assert.equal(counter.n, 3, '关闭缓存后每次都该真发请求');
});
