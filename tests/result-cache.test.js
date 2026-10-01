// tests/result-cache.test.js — v1.0.0 视觉结果缓存
// 覆盖：键计算（内容哈希 + 参数指纹）、往返读写、TTL、禁用开关、损坏容错、
//       原子写无残留、体积上限清理、清空、统计。

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
const ORIG = { ...process.env };

// 动态 import：确保模块拿到的是本测试设置的 env（模块内实际是函数内读 env，仍动态导入更稳）
const cache = await import('../src/result-cache.js');

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vet-rc-'));
  process.env.DSH_RESULT_CACHE_DIR = dir;
});
after(async () => {
  process.env = { ...ORIG };
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  // 每个用例前清空，避免相互影响
  process.env.DSH_RESULT_CACHE_DIR = dir;
  delete process.env.DSH_RESULT_CACHE;
  delete process.env.DSH_RESULT_CACHE_TTL_HOURS;
  delete process.env.DSH_RESULT_CACHE_MAX_MB;
  await cache.resultCacheClear();
});

const img = Buffer.from('fake-png-bytes-A');
const params = { model: 'm1', baseURL: 'http://x', blockSize: 800 };

test('hashBytes：稳定且对内容敏感', () => {
  assert.equal(cache.hashBytes(img), cache.hashBytes(Buffer.from('fake-png-bytes-A')));
  assert.notEqual(cache.hashBytes(img), cache.hashBytes(Buffer.from('fake-png-bytes-B')));
  assert.equal(cache.hashBytes(img).length, 32);
});

test('fingerprint：与键序无关，与参数值和提示词版本有关', () => {
  const a = cache.fingerprint({ model: 'm1', baseURL: 'http://x' });
  const b = cache.fingerprint({ baseURL: 'http://x', model: 'm1' });
  assert.equal(a, b, '同样的参数换书写顺序必须同指纹');
  assert.notEqual(a, cache.fingerprint({ model: 'm2', baseURL: 'http://x' }), '换模型必须换指纹');
  assert.notEqual(a, cache.fingerprint({ model: 'm1', baseURL: 'http://y' }), '换端点必须换指纹');
  assert.ok(cache.PROMPT_VERSION >= 1);
});

test('resultCacheKey：图片或参数变化 → 键变化', () => {
  const k = cache.resultCacheKey(img, params);
  assert.equal(k, cache.resultCacheKey(Buffer.from('fake-png-bytes-A'), { ...params }));
  assert.notEqual(k, cache.resultCacheKey(Buffer.from('fake-png-bytes-B'), params));
  assert.notEqual(k, cache.resultCacheKey(img, { ...params, blockSize: 400 }));
});

test('set/get：往返一致，且缓存目录有真实文件', async () => {
  const key = cache.resultCacheKey(img, params);
  assert.equal(await cache.resultCacheSet(key, { answer: '你好', n: 42 }), true);
  const got = await cache.resultCacheGet(key);
  assert.equal(got.cached, true);
  assert.deepEqual(got.value, { answer: '你好', n: 42 });
  assert.ok(existsSync(cache.resultCachePath(key)), '缓存文件应已落盘');
});

test('get：未写入的键返回 null（miss 不抛错）', async () => {
  assert.equal(await cache.resultCacheGet('deadbeef-0000000000000000'), null);
});

test('TTL：过期条目当 miss（极短 TTL + 等待）', async () => {
  const key = cache.resultCacheKey(img, params);
  await cache.resultCacheSet(key, { answer: 'x' });
  assert.ok(await cache.resultCacheGet(key), '未过期应命中');
  process.env.DSH_RESULT_CACHE_TTL_HOURS = '0.000001'; // ≈3.6ms
  await new Promise((r) => setTimeout(r, 12));
  assert.equal(await cache.resultCacheGet(key), null, '过期后应 miss');
  delete process.env.DSH_RESULT_CACHE_TTL_HOURS;
  assert.ok(await cache.resultCacheGet(key), '恢复 TTL 后应再次命中（过期不删除，只当 miss）');
});

test('TTL：非法/≤0 视为永不过期', async () => {
  const key = cache.resultCacheKey(img, params);
  await cache.resultCacheSet(key, { answer: 'x' });
  for (const v of ['0', '-1', 'abc']) {
    process.env.DSH_RESULT_CACHE_TTL_HOURS = v;
    assert.equal(cache.resultCacheTtlMs(), 0, `TTL=${v} 应为 0（不限制）`);
    assert.ok(await cache.resultCacheGet(key), `TTL=${v} 时不应过期`);
  }
});

test('禁用开关：DSH_RESULT_CACHE=0 时读写皆空操作', async () => {
  const key = cache.resultCacheKey(img, params);
  process.env.DSH_RESULT_CACHE = '0';
  assert.equal(cache.resultCacheEnabled(), false);
  assert.equal(await cache.resultCacheSet(key, { a: 1 }), false);
  assert.equal(await cache.resultCacheGet(key), null);
  delete process.env.DSH_RESULT_CACHE;
  assert.equal(cache.resultCacheEnabled(), true);
});

test('损坏容错：非法 JSON 当 miss 并删除坏文件', async () => {
  const key = cache.resultCacheKey(img, params);
  const file = cache.resultCachePath(key);
  await mkdir(join(cache.resultCacheDir(), key.slice(0, 2)), { recursive: true });
  await writeFile(file, '{ not json', 'utf8');
  assert.equal(await cache.resultCacheGet(key), null);
  assert.equal(existsSync(file), false, '坏文件应被顺手删除');
});

test('不可序列化的值：不写缓存但不抛错（缓存永不阻断主流程）', async () => {
  const key = cache.resultCacheKey(img, params);
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(await cache.resultCacheSet(key, cyclic), false);
  assert.equal(await cache.resultCacheGet(key), null);
});

test('原子写：目录中不残留 .tmp 文件', async () => {
  const key = cache.resultCacheKey(img, params);
  await cache.resultCacheSet(key, { ok: 1 });
  const shard = join(cache.resultCacheDir(), key.slice(0, 2));
  const files = await readdir(shard);
  assert.deepEqual(files.filter((f) => f.includes('.tmp')), []);
});

test('stat：统计条目数与字节数', async () => {
  await cache.resultCacheSet(cache.resultCacheKey(img, params), { a: 'x'.repeat(50) });
  await cache.resultCacheSet(cache.resultCacheKey(Buffer.from('other'), params), { a: 'y' });
  const st = await cache.resultCacheStat();
  assert.equal(st.files, 2);
  assert.ok(st.bytes > 0);
  assert.equal(st.dir, dir);
});

test('prune：TTL 过期条目被删除', async () => {
  const key = cache.resultCacheKey(img, params);
  await cache.resultCacheSet(key, { a: 1 });
  process.env.DSH_RESULT_CACHE_TTL_HOURS = '0.000001'; // ≈3.6ms
  await new Promise((r) => setTimeout(r, 12));
  const r = await cache.resultCachePrune();
  assert.equal(r.removed, 1);
  assert.equal(existsSync(cache.resultCachePath(key)), false);
});

test('prune：超过体积上限时按最旧优先清理', async () => {
  const k1 = cache.resultCacheKey(Buffer.from('img-1'), params);
  const k2 = cache.resultCacheKey(Buffer.from('img-2'), params);
  const k3 = cache.resultCacheKey(Buffer.from('img-3'), params);
  const big = 'z'.repeat(2000);
  await cache.resultCacheSet(k1, { a: big });
  await new Promise((r) => setTimeout(r, 15)); // 拉开 mtime，保证"最旧"可判定
  await cache.resultCacheSet(k2, { a: big });
  await new Promise((r) => setTimeout(r, 15));
  await cache.resultCacheSet(k3, { a: big });
  process.env.DSH_RESULT_CACHE_MAX_MB = String(3 / 1024); // ≈3KB 上限，装不下 3 条
  const r = await cache.resultCachePrune();
  assert.ok(r.removed >= 1, `应至少删 1 条，实际 ${r.removed}`);
  assert.equal(existsSync(cache.resultCachePath(k1)), false, '最旧条目应被优先删除');
});

test('clear：清空所有条目', async () => {
  await cache.resultCacheSet(cache.resultCacheKey(Buffer.from('a'), params), { a: 1 });
  await cache.resultCacheSet(cache.resultCacheKey(Buffer.from('b'), params), { a: 1 });
  const r = await cache.resultCacheClear();
  assert.equal(r.removed, 2);
  const st = await cache.resultCacheStat();
  assert.equal(st.files, 0);
});
