// tests/pipeline-size.test.js — 回归：尺寸未知时 pipeline 必须自行探测
//
// 背景（真实缺陷）：批量流水线拿不到图片尺寸，曾给 runPipeline 传 width:0/height:0，
// 而「相对坐标 → 像素坐标」用 normalizeRect(rect, 0, 0) 会把每个文字区域钳成 (0,0)-(0,0)：
// **不报错、不中断**，但 precheck.json 与后续裁剪全用错坐标（静默错数据）。
// 本测试用真实 PNG 做反证：修复前像素坐标全是 0，修复后必须等于 相对坐标 × 真实尺寸。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { runPipeline } from '../src/pipeline.js';
import { probeImageSize } from '../src/tile-engine.js';

let cacheDir;
const ORIG = { ...process.env };

before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'vet-size-'));
  process.env.DSH_RESULT_CACHE_DIR = cacheDir;
});
after(async () => {
  process.env = { ...ORIG };
  await rm(cacheDir, { recursive: true, force: true });
});

/** 造一张纯色 PNG（真实可解码，供 sharp/pngjs 读取尺寸与裁剪） */
function makePng(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(240);
  return PNG.sync.write(png);
}

/** 预检返回：一个文字区域（相对 0..1）+ 无兴趣点 */
function previewFetch(question = '') {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            hasText: true,
            textRegions: [{ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6, isHandwrite: false }],
            interestRegions: [],
            summary: `概要${question}`
          })
        },
        finish_reason: 'stop'
      }]
    })
  });
}

const ocrOverride = async () => ({ engine: 'mock', text: '第一行', lines: [{ text: '第一行', score: 0.99 }] });

test('probeImageSize：能读出真实宽高（sharp 或回退解码）', async () => {
  const buf = makePng(400, 300);
  const size = await probeImageSize(buf, '.png');
  assert.equal(size.width, 400);
  assert.equal(size.height, 300);
});

test('runPipeline：width/height=0 时自行探测，像素坐标按真实尺寸换算（回归红线）', async () => {
  const buf = makePng(400, 300);
  const res = await runPipeline({
    apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm',
    buf, ext: '.png', width: 0, height: 0,
    tempDir: join(cacheDir, 'run-1'),
    ocrOverride, fetchImpl: previewFetch(), timeoutMs: 5000
  });
  assert.equal(res.textRegions.length, 1, '预检应给出 1 个文字区域');
  const r = res.textRegions[0];
  // 0.1×400=40, 0.2×300=60, 0.5×400=200, 0.6×300=180
  assert.equal(r.x0, 40, '像素 x0 必须是 相对坐标 × 真实宽度（传 0 曾被钳成 0）');
  assert.equal(r.y0, 60);
  assert.equal(r.x1, 200);
  assert.equal(r.y1, 180);
  assert.ok(res.stages.some((s) => s.kind === 'image-size' && s.source === 'probed'), '应记录尺寸来源=probed');
});

test('runPipeline：调用方给了真实尺寸时，结果与自行探测完全一致（两条路径不得漂移）', async () => {
  const buf = makePng(400, 300);
  const common = {
    apiKey: 'k', baseURL: 'https://api.deepseek.com', model: 'm',
    buf, ext: '.png', ocrOverride, timeoutMs: 5000
  };
  const probed = await runPipeline({ ...common, width: 0, height: 0, tempDir: join(cacheDir, 'run-2a'), fetchImpl: previewFetch('a') });
  const given = await runPipeline({ ...common, width: 400, height: 300, tempDir: join(cacheDir, 'run-2b'), fetchImpl: previewFetch('b') });
  assert.deepEqual(
    given.textRegions.map(({ x0, y0, x1, y1 }) => [x0, y0, x1, y1]),
    probed.textRegions.map(({ x0, y0, x1, y1 }) => [x0, y0, x1, y1]),
    '同一张图：探测路径与显式传参路径的像素坐标必须一致'
  );
  assert.ok(given.stages.some((s) => s.kind === 'image-size' && s.source === 'caller'));
});
