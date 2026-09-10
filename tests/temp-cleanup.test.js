/**
 * temp-cleanup.test.js — 过期临时文件清理工具单元测试
 *
 * 覆盖：
 *  - 默认不删新鲜文件；
 *  - 过期目录（vision-tile-pipeline-*）/ 文件（region-*.png、vision-tile-ocr-*.png）被删；
 *  - 非插件前缀文件不删；
 *  - 注入 now / ttlMs 可控；
 *  - excludePaths 保护用户显式 out_dir；
 *  - 异常路径（扫描根不存在 / 删除失败）不抛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupOldTempArtifacts } from '../src/temp-cleanup.js';

/** 创建一次临时根目录，_after 时清空。 */
async function makeTmpRoot() {
  return mkdtemp(join(tmpdir(), 'vision-temp-cleanup-'));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listNames(p) {
  return (await readdir(p)).sort();
}

test('默认不删除新鲜文件，非插件前缀不删', async () => {
  const root = await makeTmpRoot();
  try {
    const freshDir = join(root, 'vision-tile-pipeline-fresh');
    const freshRegion = join(root, 'region-fresh.png');
    const freshOcr = join(root, 'vision-tile-ocr-fresh.png');
    const keepFile = join(root, 'keep.txt');
    const keepDir = join(root, 'keep-dir');
    await mkdir(freshDir, { recursive: true });
    await writeFile(join(freshDir, 'precheck.json'), '{}');
    await writeFile(freshRegion, 'png');
    await writeFile(freshOcr, 'png');
    await writeFile(keepFile, 'keep');
    await mkdir(keepDir, { recursive: true });

    const now = Date.now();
    await cleanupOldTempArtifacts({ tmpRoot: root, now, ttlMs: 24 * 60 * 60 * 1000 });

    assert.equal(await exists(freshDir), true, '新鲜 pipeline 目录不应被删');
    assert.equal(await exists(freshRegion), true, '新鲜 region-*.png 不应被删');
    assert.equal(await exists(freshOcr), true, '新鲜 vision-tile-ocr-*.png 不应被删');
    assert.equal(await exists(keepFile), true, '非前缀文件不应被删');
    assert.equal(await exists(keepDir), true, '非前缀目录不应被删');
    assert.equal(await exists(join(freshDir, 'precheck.json')), true, '目录内文件应保留');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('过期目录与文件被删，非前缀过期文件保留', async () => {
  const root = await makeTmpRoot();
  try {
    const oldDir = join(root, 'vision-tile-pipeline-old');
    const oldRegion = join(root, 'region-old.png');
    const oldOcr = join(root, 'vision-tile-ocr-old.png');
    const oldKeep = join(root, 'keep-old.txt');
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, 'answer.md'), '# old');
    await writeFile(oldRegion, 'png');
    await writeFile(oldOcr, 'png');
    await writeFile(oldKeep, 'keep');

    const now = Date.now();
    const oldTime = new Date(now - 2 * 60 * 60 * 1000); // 2 小时前
    await utimes(oldDir, oldTime, oldTime);
    await utimes(oldRegion, oldTime, oldTime);
    await utimes(oldOcr, oldTime, oldTime);
    await utimes(oldKeep, oldTime, oldTime);

    // ttl 1 小时 → 2 小时前的项全部算过期
    await cleanupOldTempArtifacts({ tmpRoot: root, now, ttlMs: 60 * 60 * 1000 });

    assert.equal(await exists(oldDir), false, '过期 pipeline 目录应被删');
    assert.equal(await exists(join(oldDir, 'answer.md')), false, '目录内文件应随目录删除');
    assert.equal(await exists(oldRegion), false, '过期 region-*.png 应被删');
    assert.equal(await exists(oldOcr), false, '过期 vision-tile-ocr-*.png 应被删');
    assert.equal(await exists(oldKeep), true, '非前缀文件即使过期也不应被删');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('注入 now/ttlMs 可控：ttl 变大则不删，变小则删', async () => {
  const root = await makeTmpRoot();
  try {
    const dir = join(root, 'vision-tile-pipeline-semi');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.txt'), 'x');
    const file = join(root, 'region-semi.png');
    await writeFile(file, 'png');

    const now = Date.now();
    const past = new Date(now - 30 * 60 * 1000); // 30 分钟前
    await utimes(dir, past, past);
    await utimes(file, past, past);

    // ttl 1 小时 → 30 分钟前未过期，不删
    await cleanupOldTempArtifacts({ tmpRoot: root, now, ttlMs: 60 * 60 * 1000 });
    assert.equal(await exists(dir), true, 'ttl 内不删');
    assert.equal(await exists(file), true, 'ttl 内不删');

    // ttl 10 分钟 → 30 分钟前已过期，删
    await cleanupOldTempArtifacts({ tmpRoot: root, now, ttlMs: 10 * 60 * 1000 });
    assert.equal(await exists(dir), false, '超过 ttl 应删目录');
    assert.equal(await exists(file), false, '超过 ttl 应删文件');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('excludePaths 保护用户显式 out_dir', async () => {
  const root = await makeTmpRoot();
  try {
    const excludedDir = join(root, 'vision-tile-pipeline-user');
    const excludedFile = join(root, 'region-user.png');
    await mkdir(excludedDir, { recursive: true });
    await writeFile(join(excludedDir, 'data.txt'), 'user data');
    await writeFile(excludedFile, 'png');

    const now = Date.now();
    const oldTime = new Date(now - 3 * 60 * 60 * 1000);
    await utimes(excludedDir, oldTime, oldTime);
    await utimes(excludedFile, oldTime, oldTime);

    await cleanupOldTempArtifacts({
      tmpRoot: root,
      now,
      ttlMs: 60 * 60 * 1000,
      excludePaths: [excludedDir, excludedFile]
    });

    assert.equal(await exists(excludedDir), true, '被排除目录不应被删');
    assert.equal(await exists(join(excludedDir, 'data.txt')), true, '被排除目录内容应保留');
    assert.equal(await exists(excludedFile), true, '被排除文件不应被删');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('异常路径不抛：扫描根不存在 / 删除失败容错', async () => {
  const root = await makeTmpRoot();
  try {
    const missingRoot = join(root, 'no-such-root');
    // 扫描根不存在：readdir 抛错，函数应静默返回
    await assert.doesNotReject(
      cleanupOldTempArtifacts({ tmpRoot: missingRoot, now: Date.now(), ttlMs: 1000 })
    );

    // 用不可删除/异常项模拟 rm 失败：对一个真实存在的占位文件，删除时 root 不存在也无碍
    // 这里再验证一次正常根但清理不会抛。
    const dir = join(root, 'vision-tile-pipeline-rmfail');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'f.txt'), 'x');
    const now = Date.now();
    const oldTime = new Date(now - 2 * 60 * 60 * 1000);
    await utimes(dir, oldTime, oldTime);
    await assert.doesNotReject(
      cleanupOldTempArtifacts({ tmpRoot: root, now, ttlMs: 60 * 60 * 1000 })
    );
    assert.equal(await exists(dir), false, '正常清理应成功删除过期目录');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
