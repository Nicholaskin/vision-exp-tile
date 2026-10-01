// tests/batch-e2e.test.js — v1.0.0 批量识别**端到端**（真实 pipeline + 假端点 + 真实缓存）
//
// 与 batch.test.js 的区别：那里注入的是假 pipeline（只验编排逻辑）；
// 这里跑**真的** runPipeline（真预检/真裁剪/真 OCR 替身/真区域识别），
// 只有 HTTP 端点被替换成假 fetch —— 用来回答一个关键问题：
//   「批量工具接上真实识别链路后，端到端能不能跑通？缓存到底有没有省下请求？」
// 因此断言里包含**反证**：第二轮 resume=false 全量重跑时，HTTP 调用次数必须为 0。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { runBatch } from '../src/batch.js';

let root;
let inputDir;
let cacheDir;
const ORIG = { ...process.env };

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vet-e2e-'));
  cacheDir = join(root, 'cache');
  inputDir = join(root, 'in');
  await mkdir(inputDir, { recursive: true });
  process.env.DSH_RESULT_CACHE_DIR = cacheDir;
  delete process.env.DSH_RESULT_CACHE;
  // 两张**内容不同**的图片（尺寸也不同，顺带覆盖尺寸探测）
  await writeFile(join(inputDir, 'doc-a.png'), makePng(360, 240));
  await writeFile(join(inputDir, 'doc-b.png'), makePng(300, 300));
});

after(async () => {
  process.env = { ...ORIG };
  await rm(root, { recursive: true, force: true });
});

function makePng(width, height) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i * 7) % 255;
    png.data[i + 1] = (i * 3) % 255;
    png.data[i + 2] = (i * 11) % 255;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** 假端点：按 system 内容区分「预检」与「区域识别」两类请求 */
function makeFetch(counter) {
  return async (_url, opts) => {
    counter.n += 1;
    const body = JSON.parse(opts.body);
    const system = body.messages?.[0]?.content ?? '';
    const isPreview = typeof system === 'string' && system.includes('图片预检助手');
    if (isPreview) {
      return jsonResponse(JSON.stringify({
        hasText: true,
        textRegions: [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.2, isHandwrite: false }],
        interestRegions: [{ x0: 0.1, y0: 0.3, x1: 0.8, y1: 0.9, label: '正文' }],
        summary: '这是一张测试图片'
      }));
    }
    return jsonResponse('区域内容：测试文字「甲乙丙」');
  };
}

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  };
}

/** OCR 替身：不跑真实本地 OCR（慢且依赖 venv），直接给确定性文本 */
const ocrOverride = async () => ({ engine: 'mock', text: '测试文字甲乙丙', lines: [{ text: '测试文字甲乙丙', score: 0.99 }] });

const cfg = {
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash-vision-exp',
  maxTokens: 2048,
  blockSize: 800,
  overlap: 0,
  cutThreshold: 800,
  format: 'png',
  quality: 90,
  rotate: 0,
  timeoutMs: 10000,
  performanceTier: 'slow' // 并发稳定为 1，便于计数断言
};

test('端到端：真实 pipeline 跑通 2 张图，报告与明细齐全', async () => {
  const counter = { n: 0 };
  const res = await runBatch({
    inputDir, outDir: join(root, 'out-1'), cfg,
    limit: 10, apiKey: 'test-key', fetchImpl: makeFetch(counter), ocrOverride
  });

  assert.equal(res.total, 2);
  assert.equal(res.ok, 2, '两张图都应识别成功');
  assert.equal(res.failed, 0);
  assert.equal(counter.n, 4, `每图 1 次预检 + 1 次区域识别 = 4 次请求，实际 ${counter.n}`);

  // 报告三件套
  assert.ok(existsSync(join(res.batchDir, 'report.md')));
  assert.ok(existsSync(join(res.batchDir, 'report-full.md')));
  assert.ok(existsSync(join(res.batchDir, 'report.json')));

  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /doc-a\.png/);
  assert.match(md, /doc-b\.png/);
  assert.match(md, /图片总数：\*\*2\*\*（成功 2 \/ 失败 0 \/ 待处理 0）/);

  // 每图明细：pipeline 应把 answer.md / precheck.json / ocr.txt 落在图目录
  const items = res.items.map((x) => x.rel).sort();
  assert.deepEqual(items, ['doc-a.png', 'doc-b.png']);
  const mdJson = JSON.parse(await readFile(join(res.batchDir, 'report.json'), 'utf8'));
  assert.equal(mdJson.stats.done, 2);
  for (const it of mdJson.items) {
    const dir = it.outDir;
    assert.ok(dir && existsSync(join(dir, 'answer.md')), `${it.rel} 应有 answer.md`);
    assert.ok(existsSync(join(dir, 'precheck.json')), `${it.rel} 应有 precheck.json`);
  }
});

test('端到端：第二轮 resume=false 全量重跑时 HTTP 调用必须为 0（缓存真生效）', async () => {
  // 注意：用**独立目录 + 独立图片**，否则会命中上一个用例已经写好的缓存，第一轮就没有请求可数。
  const in2 = join(root, 'in-2');
  await mkdir(in2, { recursive: true });
  await writeFile(join(in2, 'p1.png'), makePng(280, 180));
  await writeFile(join(in2, 'p2.png'), makePng(180, 280));

  const counter1 = { n: 0 };
  const first = await runBatch({
    inputDir: in2, outDir: join(root, 'out-2'), cfg,
    limit: 10, apiKey: 'test-key', fetchImpl: makeFetch(counter1), ocrOverride
  });
  assert.equal(counter1.n, 4, `第一轮应真发 4 次请求，实际 ${counter1.n}`);

  const counter2 = { n: 0 };
  const second = await runBatch({
    inputDir: in2, outDir: join(root, 'out-2'), batchId: first.batchId, cfg,
    limit: 10, resume: false, apiKey: 'test-key', fetchImpl: makeFetch(counter2), ocrOverride
  });
  assert.equal(second.ok, 2);
  assert.equal(counter2.n, 0, `第二轮应全部命中缓存（0 次请求），实际 ${counter2.n}`);
  // v1.0.0 可观测性：缓存命中必须被**报告出来**（真机验证时曾因 pipeline 丢弃 cached 标记而恒显示 0 张）
  assert.equal(second.cacheHits, 2, `两图都应记为缓存命中，实际 ${second.cacheHits}`);
  const md2 = await readFile(join(second.batchDir, 'report.md'), 'utf8');
  assert.match(md2, /缓存命中：2 张/, '报告必须写明命中数，否则用户无法判断钱省没省');
});

test('端到端：单图失败不拖垮整批（坏文件 → failed，另一张照常）', async () => {
  const badIn = join(root, 'in-bad');
  await mkdir(badIn, { recursive: true });
  await writeFile(join(badIn, 'good.png'), makePng(200, 200));
  await writeFile(join(badIn, 'broken.png'), Buffer.from('这不是一张真 PNG'));
  const counter = { n: 0 };
  const res = await runBatch({
    inputDir: badIn, outDir: join(root, 'out-3'), cfg,
    limit: 10, apiKey: 'test-key', fetchImpl: makeFetch(counter), ocrOverride
  });
  assert.equal(res.total, 2);
  assert.equal(res.ok, 1, '好图应成功');
  assert.equal(res.failed, 1, '坏图应记为失败而不是崩溃');
  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /⚠ 失败清单/);
  assert.match(md, /broken\.png/);
});
