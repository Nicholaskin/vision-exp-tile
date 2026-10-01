/**
 * scripts/cordis-entry-smoke.mjs — Cordis 入口（main 入口）冒烟自检
 *
 * 背景（v0.5.0-rc.3 双形态）：
 *   package.json 的 main/exports["."] 指回 `src/index.js`（Cordis bundle 形态，
 *   DSH 0.2.0 实际支持的装载路径），`std-facet.js` 作为 `./std-facet` 子导出保留
 *   （dsh-std 生态形态）。std-facet-smoke 只覆盖后者，本脚本覆盖前者。
 *
 * 检查项：
 *   1. 模块导出 apply（函数）与 name（字符串）；
 *   2. 用最小 ctx 垫片（logger/effect/tools.register）调用 apply 后，
 *      恰好注册 3 个工具且名字与预期一致；
 *   3. ctx.effect 返回的清理函数可执行且不抛；
 *   4. package.json 的双形态声明与随包文件齐备（main / exports / dsh.bundle.patch /
 *      files 含 cordis.patch.yml，且 dsh-plugin.json 仍在——两者并存才算双形态）；
 *   5. cordis.patch.yml 结构有效（含顶层 insert，且 id/name 均为 vision-exp-tile）。
 *
 * ⚠ 隔离：apply 内部会初始化文件化设置（读写 <DSH_HOME>/vision-exp-tile.json）
 *   并可能异步回写 device_profile，因此本脚本先把 DSH_HOME 指向临时目录，
 *   结束后整目录删除——绝不触碰真实用户配置。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/* ---------- 断言工具 ---------- */
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

/* ---------- 0. 隔离 DSH_HOME（必须在 import src/index.js 之前设置） ---------- */
const home = mkdtempSync(join(tmpdir(), 'vet-cordis-smoke-'));
process.env.DSH_HOME = home;

/* ---------- 1. 导入入口模块 ---------- */
let mod;
try {
  mod = await import(new URL('../src/index.js', import.meta.url).href);
  check('src/index.js 可被导入（Cordis 入口模块）', true);
} catch (error) {
  check('src/index.js 可被导入（Cordis 入口模块）', false, String(error));
  rmSync(home, { recursive: true, force: true });
  process.exit(1);
}

check('导出 apply 为函数', typeof mod.apply === 'function', typeof mod.apply);
check('导出 name = vision-exp-tile', mod.name === 'vision-exp-tile', String(mod.name));
// ⚠ 关键回归项：Cordis 要求插件声明它用到的宿主服务，声明后才能访问 ctx.tools。
// 宿主实测缺失时会报 `cannot get property "tools" without inject`（插件启用失败）。
check(
  "inject 声明含 'tools'（Cordis 服务注入，缺失即启用失败）",
  Array.isArray(mod.inject) && mod.inject.includes('tools'),
  JSON.stringify(mod.inject)
);

/* ---------- 2. 最小 ctx 垫片：tools.register 收集 + effect 收集 ---------- */
// tools 特意做成 getter 并复现 Cordis 的约束：未在 inject 声明就访问直接抛错
// ——这样「忘了写 inject」会在这里红，而不是等到宿主里启用失败。
const registered = [];
const cleanups = [];
const toolsApi = {
  register(def) {
    registered.push(def);
    return () => {}; // disposer 垫片
  }
};
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  /** Cordis effect 垫片：立即执行 setup，返回的清理函数收进 cleanups */
  effect(setup) {
    const cleanup = setup();
    if (typeof cleanup === 'function') cleanups.push(cleanup);
    return cleanup;
  },
  get tools() {
    if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) {
      throw new Error('cannot get property "tools" without inject');
    }
    return toolsApi;
  }
};

/* ---------- 3. 调用 apply（不应抛） ---------- */
try {
  mod.apply(ctx, undefined);
  check('apply(ctx) 调用不抛异常', true);
} catch (error) {
  check('apply(ctx) 调用不抛异常', false, String(error));
}

const names = registered.map((t) => t.name).sort();
const expected = ['vision_region_crop', 'vision_tile_recognize', 'vision_tile_split'];
check('恰好注册 3 个工具', registered.length === 3, `实际 ${registered.length}：${names.join(', ')}`);
check('工具名与预期一致', JSON.stringify(names) === JSON.stringify(expected), names.join(', '));
check(
  '每个工具含 name/description/parameters/execute',
  registered.every((t) => t.name && t.description && t.parameters && typeof t.execute === 'function')
);

/* ---------- 4. 清理函数可执行 ---------- */
try {
  for (const c of cleanups) c();
  check('effect 清理函数执行不抛', true);
} catch (error) {
  check('effect 清理函数执行不抛', false, String(error));
}

/* ---------- 5. 双形态声明与随包文件 ---------- */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('main 指向 src/index.js（Cordis 形态）', pkg.main === 'src/index.js', String(pkg.main));
check('exports["."] 指向 src/index.js', pkg.exports?.['.'] === './src/index.js', String(pkg.exports?.['.']));
check('exports["./std-facet"] 保留（生态形态）', pkg.exports?.['./std-facet'] === './std-facet.js', String(pkg.exports?.['./std-facet']));
check('声明 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch));
check('files 含 cordis.patch.yml（随包发布）', Array.isArray(pkg.files) && pkg.files.includes('cordis.patch.yml'));
check('dsh-plugin.json 仍在（双形态并存）', existsSync(join(ROOT, 'dsh-plugin.json')));
check('std-facet.js 仍在（双形态并存）', existsSync(join(ROOT, 'std-facet.js')));

/* ---------- 6. cordis.patch.yml 结构 ---------- */
try {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  const okInsert = /^\s*-\s*insert:\s*$/m.test(patch);
  const okId = /^\s*-\s*id:\s*vision-exp-tile\s*$/m.test(patch);
  const okName = /^\s*name:\s*'?vision-exp-tile'?\s*$/m.test(patch);
  check('patch 含顶层 insert', okInsert);
  check('patch 插入行 id = vision-exp-tile', okId);
  check('patch 插入行 name = vision-exp-tile', okName);
} catch (error) {
  check('cordis.patch.yml 可读', false, String(error));
}

/* ---------- 收尾 ---------- */
rmSync(home, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'PASS：cordis 入口冒烟全部通过' : `FAIL：${failures} 项断言失败`));
process.exit(failures === 0 ? 0 : 1);
