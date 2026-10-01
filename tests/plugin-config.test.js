/**
 * plugin-config.test.js — 设置页配置覆盖层（pickOverrides）单元测试
 *
 * 背景（真机踩坑）：DSH 0.2.0 里标了 `.volatile()` 的配置字段，传给 `apply(ctx, config)`
 * 的是**可热更新的包装对象**（取当前值需调 `.get()`），不是裸值。早期版本直接把它并入
 * 配置链，导致插件启用失败：
 *   `config: overlap 必须是 0~399 的整数（实际: [object Object]）`
 * 本测试锁住修复后的契约：解包 volatile + 只收标量 + 空值视为未设置。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, pickOverrides } from '../src/plugin-config.js';

/** 造一个「volatile 包装」替身（与宿主运行时行为一致：带 get()，取当前值）。 */
function volatileOf(value) {
  return { get: () => value };
}

test('pickOverrides：解包 volatile 包装对象（不再是 [object Object]）', () => {
  const out = pickOverrides({ overlap: volatileOf(64), block_size: volatileOf(800) });
  assert.deepEqual(out, { overlap: 64, block_size: 800 });
});

test('pickOverrides：裸标量原样保留（未包装的情形）', () => {
  const out = pickOverrides({ model: 'm', quality: 90, with_overview: true });
  assert.deepEqual(out, { model: 'm', quality: 90, with_overview: true });
});

test('pickOverrides：未设置/空值一律跳过（让下层回落配置文件与默认）', () => {
  const out = pickOverrides({
    base_url: undefined,
    model: null,
    out_dir: '   ',
    api_key_env: volatileOf(undefined)
  });
  assert.deepEqual(out, {});
});

test('pickOverrides：非标量（对象/数组/函数）一律跳过，避免污染配置链', () => {
  const out = pickOverrides({
    // 嵌套对象不是本插件字段的合法形态 → 必须被过滤
    nested: { a: 1 },
    list: [1, 2],
    fn: () => {},
    weird: { get: () => ({ deep: true }) }, // .get() 仍返回对象 → 也要过滤
    good: volatileOf('ok')
  });
  assert.deepEqual(out, { good: 'ok' });
});

test('pickOverrides：.get() 抛异常时跳过该字段而不是整体失败', () => {
  const out = pickOverrides({
    boom: { get: () => { throw new Error('host error'); } },
    ok: volatileOf(1)
  });
  assert.deepEqual(out, { ok: 1 });
});

test('pickOverrides：非对象入参安全返回空对象', () => {
  assert.deepEqual(pickOverrides(undefined), {});
  assert.deepEqual(pickOverrides(null), {});
  assert.deepEqual(pickOverrides('x'), {});
});

test('Config：全部字段都是 volatile（否则不会出现在设置页）', () => {
  const dict = Config?.dict ?? {};
  const keys = Object.keys(dict);
  assert.ok(keys.length >= 10, `字段数应 >= 10，实际 ${keys.length}`);
  for (const key of keys) {
    assert.equal(dict[key].meta?.volatile, true, `${key} 应标 volatile`);
  }
});

test('Config：字段一律不带默认值（设置页「留空 = 回落下层」语义的前提）', () => {
  const dict = Config?.dict ?? {};
  for (const key of Object.keys(dict)) {
    assert.equal(dict[key].meta?.default, undefined, `${key} 不应有默认值`);
  }
});
