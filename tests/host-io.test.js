/**
 * host-io.test.js — v0.5.0 文件访问抽象（替代旧 ctx.fs）测试
 *
 * 覆盖 openImageSource 的四条路径：
 *   1. 绝对路径 → node:fs 直读；
 *   2. 相对路径 + 执行期环境提供 readWorkspaceFile → 委托宿主解析（会话 cwd 语义）；
 *   3. 相对路径 + 无执行期环境 → process.cwd() 兜底直读；
 *   4. 异常语义：文件不存在 / 非普通文件 / 超过字节上限 / 委托失败透传。
 *
 * 纯 node 测试，不依赖宿主。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openImageSource, setActiveExecEnv } from '../src/host-io.js';

/* 每个测试独立临时目录，末尾清理。 */
const dirs = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vision-hostio-'));
  dirs.push(dir);
  return dir;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('绝对路径：node:fs 直读返回 bytes/displayPath/hostPath/ext/size', async () => {
  const dir = tmpDir();
  const file = join(dir, 'a.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a])); // 假 PNG 头
  const src = await openImageSource(file, {});
  assert.equal(src.ext, '.png');
  assert.equal(src.displayPath, file);
  assert.equal(src.hostPath, file);
  assert.equal(src.size, 5);
  assert.deepEqual([...src.bytes], [0x89, 0x50, 0x4e, 0x47, 0x0a]);
});

test('相对路径 + 执行期 readWorkspaceFile：委托宿主按会话 cwd 解析', async () => {
  const dir = tmpDir();
  const hostDir = join(dir, 'workspace');
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(join(hostDir, 'rel.png'), Buffer.from([1, 2, 3]));
  setActiveExecEnv({
    readWorkspaceFile: async (rel, _max) => ({
      path: join(hostDir, rel),
      name: 'rel.png',
      data: new Uint8Array([1, 2, 3]),
    }),
  });
  try {
    const src = await openImageSource('rel.png', {});
    assert.equal(src.displayPath, join(hostDir, 'rel.png'));
    assert.deepEqual([...src.bytes], [1, 2, 3]);
    assert.equal(src.ext, '.png');
  } finally {
    setActiveExecEnv(null);
  }
});

test('相对路径 + 无执行期环境：process.cwd() 兜底直读', async () => {
  const dir = tmpDir();
  const name = `.hostio-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  const file = join(process.cwd(), name);
  writeFileSync(file, Buffer.from([9, 9]));
  try {
    const src = await openImageSource(name, {});
    assert.equal(src.displayPath, file);
    assert.deepEqual([...src.bytes], [9, 9]);
  } finally {
    rmSync(file, { force: true });
  }
});

test('相对路径委托失败：原样透传宿主错误（不回退 cwd，避免误读别处同名文件）', async () => {
  setActiveExecEnv({ readWorkspaceFile: async () => { throw new Error('host 拒绝'); } });
  try {
    await assert.rejects(() => openImageSource('nope.png', {}), /host 拒绝/);
  } finally {
    setActiveExecEnv(null);
  }
});

test('超过字节上限抛错（stat 预检）', async () => {
  const dir = tmpDir();
  const file = join(dir, 'big.png');
  writeFileSync(file, Buffer.alloc(256));
  await assert.rejects(() => openImageSource(file, { maxBytes: 64 }), /超过 64 字节上限/);
});

test('文件不存在抛中文友好错误', async () => {
  const dir = tmpDir();
  await assert.rejects(() => openImageSource(join(dir, 'missing.png'), {}), /文件不存在/);
});

test('HTTP 类 URL 不被当作本地路径（按不存在处理，不裸抛栈）', async () => {
  await assert.rejects(() => openImageSource('http://example.com/a.png', {}), /不存在/);
});

test('空 file_path 抛错', async () => {
  await assert.rejects(() => openImageSource('   ', {}), /非空字符串/);
});

test('signal 已中止时直接拒绝', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => openImageSource('x.png', { signal: ctrl.signal }), /已取消/);
});
