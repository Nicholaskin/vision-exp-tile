// tests/batch-report.test.js — v1.0.0 批量识别：枚举 / 索引 / 报告
// 覆盖：模式解析、目录枚举（过滤/递归/排序/隐藏项/上限）、流式哈希、
//       index.jsonl 往返与坏行容错、续跑计划（resume/limit/失败重试）、
//       报告三件套内容与落盘。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PATTERNS, parsePatterns, listImages, hashFile,
  readIndex, appendIndex, indexPath, planBatch,
  humanMs, previewOf, buildMarkdownReport, buildFullReport, buildJsonReport,
  writeReports, batchDirName, safeItemDirName
} from '../src/batch-report.js';

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vet-batch-'));
  // 造目录结构：
  //   a.png b.jpg c.txt .hidden.png sub/d.webp sub/e.PNG sub/deep/f.gif
  await writeFile(join(root, 'a.png'), Buffer.from('AAA'));
  await writeFile(join(root, 'b.jpg'), Buffer.from('BBB'));
  await writeFile(join(root, 'c.txt'), Buffer.from('not image'));
  await writeFile(join(root, '.hidden.png'), Buffer.from('hidden'));
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'd.webp'), Buffer.from('DDD'));
  await writeFile(join(root, 'sub', 'e.PNG'), Buffer.from('EEE'));
  await mkdir(join(root, 'sub', 'deep'), { recursive: true });
  await writeFile(join(root, 'sub', 'deep', 'f.gif'), Buffer.from('FFF'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('parsePatterns：多种写法与默认值', () => {
  assert.deepEqual([...parsePatterns('*.png;*.jpg')].sort(), ['.jpg', '.png']);
  assert.deepEqual([...parsePatterns('png,jpg')].sort(), ['.jpg', '.png']);
  assert.deepEqual([...parsePatterns('*.PNG')], ['.png']);
  assert.deepEqual([...parsePatterns('')].sort(), [...new Set(DEFAULT_PATTERNS.map((p) => p.replace('*', '')))].sort());
  // 只给分隔符 → 回落默认
  assert.ok(parsePatterns(';;').size > 0);
});

test('listImages：默认只收顶层图片、跳过隐藏项与非图片', async () => {
  const files = await listImages(root);
  assert.deepEqual(files.map((f) => f.rel), ['a.png', 'b.jpg']);
  assert.ok(files.every((f) => f.size > 0), '应带上文件大小');
});

test('listImages：递归 + 大小写扩展名 + 稳定排序', async () => {
  const files = await listImages(root, { recursive: true });
  const rels = files.map((f) => f.rel);
  assert.ok(rels.includes('sub/e.PNG'), '大写扩展名应被识别');
  assert.ok(rels.includes('sub/deep/f.gif'));
  assert.equal(rels.length, 5);
  assert.deepEqual(rels, [...rels].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')), '顺序必须稳定可复现');
});

test('listImages：pattern 限定扩展名', async () => {
  const files = await listImages(root, { recursive: true, pattern: '*.webp' });
  assert.deepEqual(files.map((f) => f.rel), ['sub/d.webp']);
});

test('listImages：不存在的目录返回空数组（不抛错）', async () => {
  assert.deepEqual(await listImages(join(root, 'nope')), []);
});

test('listImages：maxFiles 上限生效', async () => {
  const files = await listImages(root, { recursive: true, maxFiles: 2 });
  assert.equal(files.length, 2);
});

test('hashFile：内容相同哈希相同，内容不同哈希不同，缺失文件返回空串', async () => {
  const h1 = await hashFile(join(root, 'a.png'));
  const h2 = await hashFile(join(root, 'a.png'));
  const h3 = await hashFile(join(root, 'b.jpg'));
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(h1.length, 32);
  assert.equal(await hashFile(join(root, 'nope.png')), '');
});

test('index.jsonl：追加 + 读取（同一 rel 以最后一次为准）', async () => {
  const dir = join(root, 'idx1');
  await appendIndex(dir, { rel: 'a.png', status: 'failed', error: 'x' });
  await appendIndex(dir, { rel: 'a.png', status: 'done', ms: 100 });
  await appendIndex(dir, { rel: 'b.jpg', status: 'done', ms: 200 });
  const map = await readIndex(dir);
  assert.equal(map.size, 2);
  assert.equal(map.get('a.png').status, 'done');
  assert.equal(map.get('a.png').ms, 100);
  const text = await readFile(indexPath(dir), 'utf8');
  assert.equal(text.trim().split('\n').length, 3, '索引应为每行一条 JSONL');
});

test('readIndex：坏行被跳过，其余照常读取；无索引文件返回空 Map', async () => {
  const dir = join(root, 'idx2');
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(dir), '{"rel":"a.png","status":"done"}\n{ 坏行\n\n{"rel":"b.png","status":"done"}\n', 'utf8');
  const map = await readIndex(dir);
  assert.equal(map.size, 2);
  assert.equal((await readIndex(join(root, 'no-such-dir'))).size, 0);
});

test('planBatch：续跑只补未完成项（done 跳过、failed 重试、无记录待处理）', async () => {
  const files = [{ rel: 'a.png' }, { rel: 'b.jpg' }, { rel: 'c.webp' }];
  const index = new Map([
    ['a.png', { rel: 'a.png', status: 'done' }],
    ['b.jpg', { rel: 'b.jpg', status: 'failed', error: 'boom' }]
  ]);
  const plan = planBatch(files, index, { resume: true });
  assert.deepEqual(plan.todo.map((x) => x.rel), ['b.jpg', 'c.webp'], '失败项要重试，已完成项跳过');
  assert.deepEqual(plan.done.map((x) => x.rel), ['a.png']);
  assert.deepEqual(plan.failed.map((x) => x.rel), ['b.jpg']);
});

test('planBatch：resume=false 时全部重跑；limit 把超出部分放进 skipped', async () => {
  const files = [{ rel: 'a.png' }, { rel: 'b.jpg' }, { rel: 'c.webp' }];
  const index = new Map([['a.png', { rel: 'a.png', status: 'done' }]]);
  const all = planBatch(files, index, { resume: false });
  assert.equal(all.todo.length, 3, 'resume=false 应全量重跑');
  const limited = planBatch(files, new Map(), { limit: 2 });
  assert.equal(limited.todo.length, 2, 'limit 应限制本次处理数');
  assert.equal(limited.skipped.length, 1, '超出部分应被标记为 skipped（下次续跑）');
});

test('humanMs / previewOf：展示格式化', () => {
  assert.equal(humanMs(500), '500ms');
  assert.equal(humanMs(1500), '1.5s');
  assert.equal(humanMs(63000), '1m03s');
  assert.equal(humanMs(3720000), '1h02m');
  assert.equal(humanMs(NaN), 'n/a');
  assert.equal(previewOf('# 标题\n\n正文内容'), '正文内容');
  assert.equal(previewOf(''), '');
  assert.ok(previewOf('x'.repeat(1000), 100).endsWith('…'));
});

test('buildMarkdownReport：含统计、失败清单与逐图状态', () => {
  const md = buildMarkdownReport({
    batchId: 'batch-20261002-101530',
    inputDir: 'D:\\in',
    outDir: 'D:\\out\\batch-20261002-101530',
    results: [{ rel: 'a.png', status: 'done', ms: 1200, answer: '# 结果\n\n摘要内容' }],
    pendingAll: [
      { rel: 'a.png', status: 'done', ms: 1200, answer: '# 结果\n\n摘要内容', outDir: 'D:\\out\\a', sha: 'abcdef0123456789' },
      { rel: 'b.jpg', status: 'failed', error: 'API 超时' },
      { rel: 'c.webp', status: 'pending' }
    ],
    meta: { model: 'm1', baseURL: 'http://x', concurrency: 1, cacheHits: 0 }
  });
  assert.match(md, /图片总数：\*\*3\*\*（成功 1 \/ 失败 1 \/ 待处理 1）/);
  assert.match(md, /⚠ 失败清单/);
  assert.match(md, /API 超时/);
  assert.match(md, /摘要内容/);
  assert.match(md, /待处理（可再次调用批量工具续跑）/);
});

test('buildMarkdownReport：缓存命中只在 >0 时出现（0 命中不得写"未产生 API 请求"）', () => {
  const base = { batchId: 'b', inputDir: 'D:\\in', outDir: 'D:\\out', results: [], pendingAll: [] };
  const zero = buildMarkdownReport({ ...base, meta: { cacheHits: 0 } });
  assert.doesNotMatch(zero, /缓存命中/, '0 命中时不应出现该行（真机验证踩到过误导文案）');
  const hit = buildMarkdownReport({ ...base, meta: { cacheHits: 3 } });
  assert.match(hit, /缓存命中：3 张/);
  assert.match(hit, /未产生 API 请求/);
});

test('buildFullReport / buildJsonReport：全文与机读结构', () => {
  const results = [
    { rel: 'a.png', status: 'done', answer: '第一张的完整答案' },
    { rel: 'b.jpg', status: 'failed', error: 'boom' }
  ];
  const full = buildFullReport({ batchId: 'b1', inputDir: 'D:\\in', results });
  assert.match(full, /第一张的完整答案/);
  assert.doesNotMatch(full, /boom/, '失败项不应进全文报告');

  const json = JSON.parse(buildJsonReport({
    batchId: 'b1', inputDir: 'D:\\in', outDir: 'D:\\o', results,
    pendingAll: [
      { rel: 'a.png', status: 'done', ms: 10, sha: 's1' },
      { rel: 'b.jpg', status: 'failed', error: 'boom' }
    ],
    meta: { model: 'm' }
  }));
  assert.equal(json.stats.total, 2);
  assert.equal(json.stats.done, 1);
  assert.equal(json.stats.failed, 1);
  assert.equal(json.items[1].error, 'boom');
  assert.equal(json.meta.model, 'm');
});

test('writeReports：三份报告落盘', async () => {
  const batchDir = join(root, 'batch-out');
  const paths = await writeReports(batchDir, {
    batchId: 'b2', inputDir: 'D:\\in', outDir: batchDir,
    results: [{ rel: 'a.png', status: 'done', answer: 'ok', ms: 5 }],
    pendingAll: [{ rel: 'a.png', status: 'done', answer: 'ok', ms: 5 }]
  });
  for (const p of [paths.report, paths.full, paths.json]) {
    assert.ok(existsSync(p), `${p} 应存在`);
  }
  assert.match(await readFile(paths.report, 'utf8'), /批量识别报告/);
  assert.doesNotThrow(() => JSON.parse(readFileSync(paths.json, 'utf8')));
});

test('batchDirName / safeItemDirName：命名可预测且安全', () => {
  const name = batchDirName(new Date(2026, 9, 2, 10, 15, 30));
  assert.equal(name, 'batch-20261002-101530');
  assert.equal(safeItemDirName('子目录/我的 图片(1).png'), '我的_图片_1_');
  assert.equal(safeItemDirName('....png'), 'image', '名字被清空时要有兜底');
});
