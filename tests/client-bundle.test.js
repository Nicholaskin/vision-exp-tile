/**
 * client-bundle.test.js — client.js（Web 设置页 bundle）结构冒烟断言
 *
 * 背景：v0.5.0-rc.4 起 client.js 按 **DSH 0.2.0 的新设置机制**重写
 * （旧版的 ctx.settingsScope 通道在 0.2.0 已被移除），因此本测试也随之一并改写：
 * 只做「源码级结构断言」（client.js 是浏览器 bundle，node 侧由
 * scripts/client-settings-smoke.mjs 用 vm 模拟环境做执行级验证）。
 *
 * 断言面：
 *  1. ModuleLoader 工厂格式，且 id 必须等于包名（宿主按此 id 装载客户端模块）；
 *  2. 工厂返回 { inject, apply }，inject 含 slots / configForms；
 *  3. 注册进插件页 slot `plugins.item`，条目 id = 包名；
 *  4. 数据通道用 ctx.configForms.get('<包名>')（profile 条目 id）；
 *  5. **不 require 任何宿主客户端 UI 包**（官方明确劝阻第三方插件这样做）；
 *  6. 不再出现已被移除的 settingsScope API；
 *  7. 自绘控件（inline style 注入 + 自行渲染 input/select/checkbox），不依赖 UI 包组件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const clientPath = join(__dirname, '..', 'client.js');
const pkgPath = join(__dirname, '..', 'package.json');

const src = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
// 剥离注释后再做「不含某某」类断言——注释里可能只是提及旧 API 的名字（用于说明改造原因）
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const ENTRY_ID = pkg.name; // 包名 = profile 条目 id

test('client.js 存在且为 ModuleLoader 工厂格式', () => {
  assert.ok(src.length > 0, 'client.js 应存在且非空');
  assert.match(src, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(src, /factory\s*\(require\)\s*\{/);
  // 浏览器 bundle 不应用 ESM 语法导出
  assert.doesNotMatch(src, /^\s*export\s/m);
});

test('client.js 的模块 id 等于包名（宿主按 id 装载客户端模块）', () => {
  const m = src.match(/id:\s*'([^']+)'/);
  assert.ok(m, '应声明 id');
  assert.equal(m[1], ENTRY_ID);
});

test('client.js 声明 inject = [slots, configForms] 并返回 apply', () => {
  assert.match(src, /inject:\s*\[[^\]]*'slots'[^\]]*\]/);
  assert.match(src, /inject:\s*\[[^\]]*'configForms'[^\]]*\]/);
  assert.match(src, /apply\(ctx\)/);
});

test('client.js 注册进插件页 slot plugins.item，条目 id = 包名', () => {
  assert.match(src, /ctx\.slots\.inject\('plugins\.item'/);
  assert.match(src, /name:\s*'plugins\.item'/);
  assert.match(src, new RegExp(`id:\\s*ENTRY_ID|id:\\s*'${ENTRY_ID}'`));
});

test('client.js 通过 configForms.get(包名) 读写配置（0.2.0 设置通道）', () => {
  assert.match(src, /ctx\.configForms\.get\(/);
  assert.match(src, new RegExp(`ENTRY_ID\\s*=\\s*'${ENTRY_ID}'`));
});

test('client.js 不 require 任何宿主客户端 UI 包（官方劝阻第三方插件这样做）', () => {
  const hostRequires = [...code.matchAll(/require\('(@deepseek-ai\/[^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(hostRequires, [], `不应 require 宿主包，实际：${hostRequires.join(', ')}`);
  // 只允许 require('react')（浏览器模块表提供）
  const requires = [...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(requires.every((r) => r === 'react'), `仅允许 require('react')，实际：${requires.join(', ')}`);
});

test('client.js 不再使用已被 0.2.0 移除的 settingsScope API', () => {
  assert.doesNotMatch(code, /settingsScope/);
});

test('client.js 自绘控件（不依赖 UI 包组件）：注入样式 + 原生表单元素', () => {
  assert.match(src, /React\.createElement|const h = React\.createElement/);
  assert.match(src, /h\('style'/);
  assert.match(src, /type:\s*'checkbox'/);
  assert.match(src, /h\('select'/);
});

test('client.js 的字段键全部是 snake_case（与配置文件 / Config 一致）', () => {
  const keys = [...src.matchAll(/\{\s*key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 35, `字段数应 >= 35（全量覆盖），实际 ${keys.length}`);
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9_]*$/, `字段键应为 snake_case：${key}`);
  }
});

test('package.json 声明 dsh.client（platform=web）与 ./client 导出', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.equal(pkg.exports?.['./client'], './client.js');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('client.js'), 'files 应含 client.js');
});
