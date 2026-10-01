/**
 * settings-file.test.js — v0.5.0 设置文件化模块测试
 *
 * 覆盖：
 *   1. parseYamlSection：旧 settings.yaml 分区行级解析（缩进边界 / 行内注释 /
 *      引号 / 非目标键跳过 / 空分区）。
 *   2. readSnapshot / setSetting：原子写回、覆盖、undefined 删除、损坏 JSON 容错。
 *   3. mtime 缓存：写回后立即读回最新值（缓存正确刷新）。
 *   4. initFileSettings 迁移：候选 settings.yaml 的旧分区一次性落盘为独立 JSON，
 *      sourceGetter 归一化后含迁移值。
 *
 * 全部操作隔离在临时 DSH_HOME 下，不触碰真实 ~/.dsh。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseYamlSection,
  readSnapshot,
  setSetting,
  getConfigPath,
  initFileSettings,
  _overrideConfigPathForTest,
} from '../src/settings-file.js';

/* 每个测试独立临时 DSH_HOME + 配置路径。 */
const homes = [];
function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'vision-sf-'));
  process.env.DSH_HOME = home;
  homes.push(home);
  _overrideConfigPathForTest(join(home, 'vision-exp-tile.json'));
  return home;
}
test.beforeEach(() => { tmpHome(); });
test.after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  delete process.env.DSH_HOME;
  _overrideConfigPathForTest(null);
});

/* ------------------------------------------------------------------ */
/* parseYamlSection                                                     */
/* ------------------------------------------------------------------ */

const YAML = [
  'other: 1',
  '',
  'vision-exp-tile:',
  '  base_url: https://api.custom.example/v1   # 行内注释',
  "  model: 'deepseek-v4-flash-vision-exp'",
  '  ocr_engine: paddle',
  '  device_benchmark: false',
  '  not_a_target: 111',   // 非目标键 → 跳过
  'other-plugin:',
  '  base_url: nope'        // 其他分区 → 不属于本分区
].join('\n');

test('parseYamlSection：提取目标键，清洗注释/引号，尊重缩进边界', () => {
  const sec = parseYamlSection(YAML, 'vision-exp-tile');
  assert.deepEqual(sec, {
    base_url: 'https://api.custom.example/v1',
    model: 'deepseek-v4-flash-vision-exp',
    ocr_engine: 'paddle',
    device_benchmark: 'false',
  });
});

test('parseYamlSection：分区不存在返回空对象', () => {
  assert.deepEqual(parseYamlSection(YAML, 'ghost'), {});
});

test('parseYamlSection：v1.0.0 新增 12 项也在白名单内（可迁移），未知键仍被跳过', () => {
  const yaml = [
    'vision-exp-tile:',
    "  provider: openai",
    "  api_path: /v1/chat/completions",
    "  api_key: sk-test-123",
    '  extra_headers: \'{"api-key":"abc"}\'',
    '  extra_body: \'{"temperature":0.2}\'',
    '  image_detail: low',
    '  thinking_mode: off',
    '  max_tokens_field: max_tokens',
    '  api_concurrency: 2',
    '  result_cache: false',
    '  result_cache_ttl_hours: 24',
    '  result_cache_max_mb: 64',
    '  unknown_new_key: 1'   // 不在白名单 → 跳过
  ].join('\n');
  const sec = parseYamlSection(yaml, 'vision-exp-tile');
  assert.deepEqual(sec, {
    provider: 'openai',
    api_path: '/v1/chat/completions',
    api_key: 'sk-test-123',
    extra_headers: '{"api-key":"abc"}',
    extra_body: '{"temperature":0.2}',
    image_detail: 'low',
    thinking_mode: 'off',
    max_tokens_field: 'max_tokens',
    api_concurrency: '2',
    result_cache: 'false',
    result_cache_ttl_hours: '24',
    result_cache_max_mb: '64',
  });
});

test('parseYamlSection：空值键被丢弃', () => {
  const sec = parseYamlSection('vision-exp-tile:\n  base_url: \n  model: x\n', 'vision-exp-tile');
  assert.deepEqual(sec, { model: 'x' });
});

/* ------------------------------------------------------------------ */
/* readSnapshot / setSetting                                            */
/* ------------------------------------------------------------------ */

test('setSetting 写回后可读，覆盖与 undefined 删除生效', () => {
  assert.deepEqual(readSnapshot(), {});
  setSetting('base_url', 'https://a.example/v1');
  setSetting('block_size', 600);
  const snap = readSnapshot();
  assert.equal(snap.base_url, 'https://a.example/v1');
  assert.equal(snap.block_size, 600);
  // 覆盖
  setSetting('base_url', 'https://b.example/v1');
  assert.equal(readSnapshot().base_url, 'https://b.example/v1');
  // undefined 删除
  setSetting('block_size', undefined);
  assert.equal('block_size' in readSnapshot(), false);
});

test('setSetting 原子落盘：配置文件存在且为合法 JSON', () => {
  setSetting('model', 'm1');
  const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
  assert.equal(onDisk.model, 'm1');
});

test('损坏 JSON：readSnapshot 返回 {} 不抛', () => {
  writeFileSync(getConfigPath(), '{ not json !!!', 'utf8');
  assert.deepEqual(readSnapshot(), {});
});

test('mtime 缓存正确刷新：写回后立即读回为最新', () => {
  setSetting('ocr_engine', 'windows');
  assert.equal(readSnapshot().ocr_engine, 'windows'); // 同一函数内两次读
});

/* ------------------------------------------------------------------ */
/* initFileSettings 迁移                                                 */
/* ------------------------------------------------------------------ */

test('initFileSettings：首次运行时从候选 settings.yaml 迁移旧分区', () => {
  const home = process.env.DSH_HOME;
  writeFileSync(join(home, 'settings.yaml'), YAML, 'utf8');
  const sourceGetter = initFileSettings({ peer: null });
  // 迁移落盘
  assert.equal(existsSync(getConfigPath()), true);
  const migrated = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
  assert.equal(migrated.base_url, 'https://api.custom.example/v1');
  assert.equal(migrated.ocr_engine, 'paddle');
  // sourceGetter → 归一化配置（snake→camel；ocr_engine 无 configKey → 以 snake 键透传）
  const cfg = sourceGetter();
  assert.equal(cfg.baseURL, 'https://api.custom.example/v1');
  assert.equal(cfg.ocr_engine, 'paddle');
});

test('initFileSettings：配置文件已存在则不再覆盖（幂等）', () => {
  setSetting('base_url', 'https://keep.example/v1');
  writeFileSync(join(process.env.DSH_HOME, 'settings.yaml'), YAML, 'utf8');
  initFileSettings();
  assert.equal(readSnapshot().base_url, 'https://keep.example/v1');
});

test('initFileSettings：无旧设置且无配置文件 → 全默认', () => {
  const sourceGetter = initFileSettings();
  const cfg = sourceGetter();
  assert.equal(cfg.baseURL, 'https://api.deepseek.com');
  assert.equal(existsSync(getConfigPath()), false); // 迁移不落盘空文件
});
