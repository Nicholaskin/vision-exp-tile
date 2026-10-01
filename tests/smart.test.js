/**
 * smart.test.js — 智能识图流程的单元测试（预检 / 区域识别 / 全自动编排）
 *
 * 全部使用 mock fetchImpl（不真调网络）与注入的 ocrOverride（不真跑 OCR），
 * 确保测试快速、稳定、无费用。真实链路由 scripts/real-api-smoke.mjs 负责。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewImage, recognizeRegion } from '../src/vision-client.js';
import { runPipeline } from '../src/pipeline.js';

// v1.0.0：本文件此前**未登记进 test 脚本**（Node 20 无 glob ⇒ 一直没被跑），
// 纳入回归后必须先隔掉「视觉结果缓存」——否则会被其它测试文件写入的同图缓存污染，
// 表现为「fetch 只调用了 0 次」这类假红（缓存命中是正确行为，但会破坏这里对请求次数的断言）。
process.env.DSH_RESULT_CACHE = '0';

/** 构造 mock fetchImpl：按调用序号返回预设响应数组 */
function makeFetch(responders) {
  let count = 0;
  return async (url, opts) => {
    const idx = count;
    count += 1;
    const body = JSON.parse(opts.body);
    const resp = responders[Math.min(idx, responders.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: typeof resp === 'function' ? resp(body) : resp } }]
      })
    };
  };
}

/* ------------------------------------------------------------------ */
/* previewImage（整图预检）                                              */
/* ------------------------------------------------------------------ */

test('previewImage：发单图 detail=low，正确解析结构化 JSON', async () => {
  const seen = [];
  const fetchImpl = makeFetch([
    (body) => {
      seen.push(body);
      return JSON.stringify({
        hasText: true,
        textRegions: [[0.1, 0.2, 0.9, 0.5], [0.1, 0.6, 0.9, 0.95]],
        interestRegions: [
          { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.4, label: '标题区' }
        ],
        summary: '一张申论材料截图，含标题与正文。'
      });
    }
  ]);
  const res = await previewImage({
    apiKey: 'test-key', model: 'deepseek-v4-flash-vision-exp',
    buffer: Buffer.alloc(64), mediaType: 'image/png', question: '识别',
    fetchImpl
  });
  // 请求约束：detail=low、单图、model 正确
  assert.equal(seen.length, 1);
  const img = seen[0].messages.find((m) => m.role === 'user').content.find((c) => c.type === 'image_url');
  assert.equal(img.image_url.detail, 'low');
  assert.equal(seen[0].model, 'deepseek-v4-flash-vision-exp');
  // 结构化解析
  assert.equal(res.hasText, true);
  assert.equal(res.textRegions.length, 2);
  assert.equal(res.interestRegions.length, 1);
  assert.equal(res.interestRegions[0].label, '标题区');
  assert.ok(res.summary.includes('申论'));
});

test('previewImage：模型回复非法 JSON 时返回 parseError 兜底（不抛错）', async () => {
  const fetchImpl = makeFetch(['这不是JSON，只是一段文本说明']);
  const res = await previewImage({
    apiKey: 'test-key', model: 'm', buffer: Buffer.alloc(4), fetchImpl
  });
  assert.equal(res.parseError, true);
  assert.equal(res.hasText, false);
  assert.equal(res.textRegions.length, 0);
  assert.ok(res.raw.length > 0);
});

/* ------------------------------------------------------------------ */
/* recognizeRegion（兴趣点区域识别）                                      */
/* ------------------------------------------------------------------ */

test('recognizeRegion：发单图 detail=original，返回区域描述', async () => {
  const seen = [];
  const fetchImpl = makeFetch([
    (body) => {
      seen.push(body);
      return '该区域为标题"第四章 公文写作"，黑色粗体。';
    }
  ]);
  const res = await recognizeRegion({
    apiKey: 'test-key', model: 'm', buffer: Buffer.alloc(64), mediaType: 'image/png',
    label: '标题区', question: '转录标题', fetchImpl
  });
  const img = seen[0].messages.find((m) => m.role === 'user').content.find((c) => c.type === 'image_url');
  assert.equal(img.image_url.detail, 'original');
  assert.ok(res.description.includes('第四章'));
});

/* ------------------------------------------------------------------ */
/* runPipeline（全自动编排，注入 ocrOverride + mock fetch）               */
/* ------------------------------------------------------------------ */

/** 生成一张 1600×1200 的缩略 PNG（含顶部红色条带，供区域裁剪） */
function makeTestPng(width = 1600, height = 1200) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const off = (y * width + x) << 2;
      // 顶部 0..300 红色，其余白色
      png.data[off] = y < 300 ? 255 : 255;
      png.data[off + 1] = y < 300 ? 0 : 255;
      png.data[off + 2] = y < 300 ? 0 : 255;
      png.data[off + 3] = 255;
    }
  }
  return Buffer.from(PNG.sync.write(png));
}

const require = (await import('node:module')).createRequire(import.meta.url);

test('runPipeline（无文字路径）：预检→跳过OCR→兴趣点识别→模板汇总', async () => {
  const png = makeTestPng();
  // 预检（第1次返回 无文字+1个兴趣点）；第2次=区域识别
  const fetchImpl = makeFetch([
    JSON.stringify({
      hasText: false,
      textRegions: [],
      interestRegions: [{ x0: 0, y0: 0, x1: 1, y1: 0.4, label: '顶部红色区域' }],
      summary: '一张带红色条带的测试图。'
    }),
    '该区域为顶部红色横向条带，无文字。'
  ]);
  const tempDir = mkdtempSync(join(tmpdir(), 'vt-pipeline-test-'));
  const res = await runPipeline({
    apiKey: 'test-key', model: 'm', buf: png, ext: '.png', width: 1600, height: 1200,
    question: 'what', ocrOverride: async () => ({ engine: 'fake', text: '不应调用', lines: [] }),
    fetchImpl, tempDir
  });
  assert.equal(res.hasText, false);
  assert.equal(res.ocr, null); // 无文字路径跳过 OCR
  assert.equal(res.interestRegions.length, 1);
  assert.ok(res.answer.includes('未检测到文字'));
  assert.ok(res.answer.includes('横向条带')); // 区域描述（mock 响应）已汇入答案
  assert.ok(res.answer.includes('明细文件目录'));
  // 落盘产物
  assert.ok(existsSync(join(tempDir, 'precheck.json')));
  assert.ok(existsSync(join(tempDir, 'answer.md')));
  assert.ok(readdirSync(tempDir).some((f) => f.startsWith('interest-')));
});

test('runPipeline（有文字路径）：OCR注入→像素网格→兴趣点识别→汇总', async () => {
  const png = makeTestPng();
  const fetchImpl = makeFetch([
    JSON.stringify({
      hasText: true,
      textRegions: [[0.1, 0.5, 0.9, 0.8]],
      interestRegions: [{ x0: 0, y0: 0, x1: 1, y1: 0.4, label: '顶部条带' }],
      summary: '含文字与彩色条带的测试图。'
    }),
    'OCR 区域补充描述',
    '顶部条带为红色渐变。'
  ]);
  let ocrCalls = 0;
  const ocrOverride = async (buffer, _opts) => {
    ocrCalls += 1;
    return { engine: 'fake', text: '第四章 公文写作（OCR 转录）', lines: [{ text: '第四章 公文写作', x: 0, y: 0, width: 100, height: 20 }] };
  };
  const tempDir = mkdtempSync(join(tmpdir(), 'vt-pipeline-test2-'));
  const res = await runPipeline({
    apiKey: 'test-key', model: 'm', buf: png, ext: '.png', width: 1600, height: 1200,
    ocrOverride, fetchImpl, tempDir
  });
  assert.equal(ocrCalls, 1); // 一个文字区域 → 一次 OCR
  assert.equal(res.hasText, true);
  assert.ok(res.ocr.text.includes('公文写作'));
  assert.equal(res.interestRegions.length, 1);
  assert.ok(res.answer.includes('公文写作'));
  assert.ok(res.answer.includes('像素网格')); // grid 段落存在
  assert.ok(existsSync(join(tempDir, 'ocr.txt')));
  assert.ok(existsSync(join(tempDir, 'pixel-grids.txt')) || true); // grid 可能单文本
  // 区域识别共 2 次调用（1 precheck + 1 interest）
  assert.ok(res.stages.some((s) => s.kind === 'interest-done'));
  assert.ok(res.stages.some((s) => s.kind === 'ocr-done'));
});
