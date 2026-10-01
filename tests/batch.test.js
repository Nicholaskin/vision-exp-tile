// tests/batch.test.js — v1.0.0 批量识别编排
// 覆盖：批次目录与报告落盘、续跑、失败隔离、批内去重、limit 限制、
//       时间预算收工、参数校验、策略校验。全部用注入的 pipelineOverride，
//       不触网、不依赖真实图片解码。

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBatch } from '../src/batch.js';

let root;
let inputDir;
const cfg = {
  baseURL: 'http://localhost:9999/v1',
  model: 'test-model',
  maxTokens: 1024,
  blockSize: 800,
  overlap: 0,
  cutThreshold: 800,
  format: 'png',
  quality: 90,
  timeoutMs: 5000,
  performanceTier: 'slow' // 让并发预算稳定为 1，便于断言调用次数
};

/** 造一个伪 pipeline：记录调用、返回固定答案；可指定某些文件抛错 */
function makePipeline(callLog, failOn = []) {
  return async (opts) => {
    const name = opts.buf.toString('utf8');
    callLog.push(name);
    if (failOn.includes(name)) throw new Error(`模拟失败：${name}`);
    // 模拟 pipeline 的落盘行为（answer.md）
    await mkdir(opts.tempDir, { recursive: true });
    await writeFile(join(opts.tempDir, 'answer.md'), `# 结果\n\n来自 ${name} 的答案`, 'utf8');
    return {
      answer: `# 结果\n\n来自 ${name} 的答案`,
      outputDir: opts.tempDir,
      hasText: true,
      textRegions: [{}],
      interestRegions: [],
      stages: [{ kind: 'precheck' }]
    };
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vet-batchrun-'));
  inputDir = join(root, 'in');
  await mkdir(inputDir, { recursive: true });
  await writeFile(join(inputDir, 'a.png'), Buffer.from('IMG-A'));
  await writeFile(join(inputDir, 'b.png'), Buffer.from('IMG-B'));
  await writeFile(join(inputDir, 'c.png'), Buffer.from('IMG-C'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('runBatch：基本流程产出报告三件套 + index.jsonl', async () => {
  const outDir = join(root, 'out-1');
  const calls = [];
  const res = await runBatch({
    inputDir, outDir, strategy: 'pipeline', cfg,
    limit: 10, pipelineOverride: makePipeline(calls)
  });
  assert.equal(res.total, 3);
  assert.equal(res.processed, 3);
  assert.equal(res.ok, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.remaining, 0);
  assert.equal(calls.length, 3, '每张图应进入 pipeline 一次');

  assert.ok(existsSync(join(res.batchDir, 'index.jsonl')), 'index.jsonl 必须存在（续跑依据）');
  assert.ok(existsSync(join(res.batchDir, 'report.md')));
  assert.ok(existsSync(join(res.batchDir, 'report-full.md')));
  assert.ok(existsSync(join(res.batchDir, 'report.json')));

  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /批量识别报告/);
  assert.match(md, /图片总数：\*\*3\*\*（成功 3 \/ 失败 0 \/ 待处理 0）/);
  const full = await readFile(join(res.batchDir, 'report-full.md'), 'utf8');
  assert.match(full, /IMG-A/, '全文报告应含各图答案');

  const idx = (await readFile(join(res.batchDir, 'index.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(idx.length, 3, '每张图一条索引');
});

test('runBatch：续跑跳过已完成项（不重复烧 API）', async () => {
  const outDir = join(root, 'out-2');
  const calls1 = [];
  const first = await runBatch({ inputDir, outDir, cfg, limit: 10, pipelineOverride: makePipeline(calls1) });
  assert.equal(first.processed, 3);

  const calls2 = [];
  const second = await runBatch({
    inputDir, outDir, batchId: first.batchId, cfg, limit: 10, pipelineOverride: makePipeline(calls2)
  });
  assert.equal(second.processed, 0, '第二次不应有新的处理');
  assert.equal(calls2.length, 0, '第二次不应再次调用识别');
  assert.equal(second.ok, 3, '历史成功项应计入总成功数');
  const md = await readFile(join(second.batchDir, 'report.md'), 'utf8');
  assert.match(md, /IMG-A/, '续跑后重建的报告应仍含历史答案（从明细目录回读）');
});

test('runBatch：resume=false 时全量重跑', async () => {
  const outDir = join(root, 'out-3');
  const first = await runBatch({ inputDir, outDir, cfg, limit: 10, pipelineOverride: makePipeline([]) });
  const calls = [];
  const again = await runBatch({
    inputDir, outDir, batchId: first.batchId, cfg, limit: 10, resume: false, pipelineOverride: makePipeline(calls)
  });
  assert.equal(calls.length, 3, 'resume=false 应重跑全部');
  assert.equal(again.processed, 3);
});

test('runBatch：单图失败不中断整批（失败隔离）', async () => {
  const outDir = join(root, 'out-4');
  const calls = [];
  const res = await runBatch({
    inputDir, outDir, cfg, limit: 10, pipelineOverride: makePipeline(calls, ['IMG-B'])
  });
  assert.equal(res.ok, 2);
  assert.equal(res.failed, 1);
  assert.equal(res.processed, 3);
  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /⚠ 失败清单/);
  assert.match(md, /模拟失败：IMG-B/);
});

test('runBatch：失败项在续跑时自动重试', async () => {
  const outDir = join(root, 'out-5');
  const first = await runBatch({ inputDir, outDir, cfg, limit: 10, pipelineOverride: makePipeline([], ['IMG-C']) });
  assert.equal(first.failed, 1);
  const calls = [];
  const second = await runBatch({
    inputDir, outDir, batchId: first.batchId, cfg, limit: 10, pipelineOverride: makePipeline(calls)
  });
  assert.deepEqual(calls, ['IMG-C'], '只应重试失败那张');
  assert.equal(second.failed, 0);
  assert.equal(second.ok, 3);
});

test('runBatch：批内相同内容的图片只识别一次（去重）', async () => {
  const dupIn = join(root, 'in-dup');
  await mkdir(dupIn, { recursive: true });
  await writeFile(join(dupIn, 'x1.png'), Buffer.from('SAME-CONTENT'));
  await writeFile(join(dupIn, 'x2.png'), Buffer.from('SAME-CONTENT'));
  await writeFile(join(dupIn, 'y.png'), Buffer.from('OTHER'));
  const calls = [];
  const res = await runBatch({
    inputDir: dupIn, outDir: join(root, 'out-6'), cfg, limit: 10, pipelineOverride: makePipeline(calls)
  });
  assert.equal(calls.length, 2, '相同内容只应识别一次');
  assert.equal(res.duplicates, 1);
  assert.equal(res.ok, 3);
  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /内容完全相同/);
});

test('runBatch：limit 限制本次处理数，剩余留待续跑', async () => {
  const outDir = join(root, 'out-7');
  const calls = [];
  const res = await runBatch({ inputDir, outDir, cfg, limit: 1, pipelineOverride: makePipeline(calls) });
  assert.equal(res.processed, 1);
  assert.equal(res.remaining, 2);
  assert.equal(calls.length, 1);
  const md = await readFile(join(res.batchDir, 'report.md'), 'utf8');
  assert.match(md, /待处理（可再次调用批量工具续跑）/);
});

test('runBatch：时间预算到点即收工（剩余项保持 pending）', async () => {
  const outDir = join(root, 'out-8');
  const calls = [];
  const res = await runBatch({
    inputDir, outDir, cfg, limit: 10, timeBudgetMs: -1, pipelineOverride: makePipeline(calls)
  });
  assert.equal(res.processed, 0);
  assert.equal(res.remaining, 3);
  assert.equal(calls.length, 0, '超预算不应发起任何识别');
});

test('runBatch：参数与策略校验（坏输入必须明确报错）', async () => {
  await assert.rejects(() => runBatch({ inputDir: '', cfg }), /input_dir/);
  await assert.rejects(() => runBatch({ inputDir: join(root, 'nope'), cfg }), /输入目录不存在/);
  await assert.rejects(
    () => runBatch({ inputDir, cfg, strategy: 'smart' }),
    /strategy 仅支持 pipeline\/full/
  );
});

test('runBatch：空目录也能产出报告（不抛错）', async () => {
  const emptyIn = join(root, 'in-empty');
  await mkdir(emptyIn, { recursive: true });
  const res = await runBatch({ inputDir: emptyIn, outDir: join(root, 'out-9'), cfg });
  assert.equal(res.total, 0);
  assert.equal(res.processed, 0);
  assert.ok(existsSync(join(res.batchDir, 'report.md')));
});
