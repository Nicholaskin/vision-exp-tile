/**
 * scripts/client-settings-smoke.mjs — client.js（Web 设置页）执行级冒烟
 *
 * 为什么需要它：client.js 是**浏览器 bundle**（window.__ModuleLoader__.load 形态，
 * 非 ESM），普通单测无法直接 import。本脚本用 node:vm 造一个最小浏览器环境
 * （window.__ModuleLoader__ + 假 React + 假 ctx），真实执行 factory 与 apply，
 * 验证设置页在「结构上装得起来、渲染不炸、字段与配置声明不漂移」。
 *
 * 检查项：
 *   1. ModuleLoader.load 被调用一次，id = 包名；
 *   2. factory 只 require('react')（不碰任何宿主包——官方明确劝阻）；
 *   3. 返回 { inject, apply }，inject 含 slots / configForms；
 *   4. apply(ctx)：configForms.get(包名) 被调用、slots.inject('plugins.item') 被调用、
 *      register 收到 name='plugins.item' 与 id=包名；
 *   5. 卡片组件：view='summary' 返回短摘要；完整渲染返回元素树且不抛；
 *   6. **字段双向一致**：client.js 的 FIELDS 键集合 ≡ src/plugin-config.js 的 Config 键集合
 *      （防「加了配置忘了加界面」或相反）；
 *   7. 保存路径确实调用 form.set / form.unset（源码级确认，交互本身需真实浏览器）。
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Config } from '../src/plugin-config.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ENTRY_ID = pkg.name;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || !detail ? '' : ` —— ${detail}`}`);
  if (!ok) failures += 1;
}

/* ---------- 1. 造浏览器环境并执行 client.js ---------- */
const src = readFileSync(join(ROOT, 'client.js'), 'utf8');
let loaded = null;
const requestedModules = [];
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(def) { loaded = def; }
    }
  }
};
createContext(sandbox);
try {
  runInContext(src, sandbox, { filename: 'client.js' });
  check('client.js 可在浏览器式环境执行', true);
} catch (error) {
  check('client.js 可在浏览器式环境执行', false, String(error));
  process.exit(1);
}

check('调用了 __ModuleLoader__.load', !!loaded, String(loaded));
check('模块 id = 包名', loaded?.id === ENTRY_ID, String(loaded?.id));

/* ---------- 2. 假 React（只实现本页用到的最小面） ---------- */
const ReactStub = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: { ...(props || {}), children } };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useEffect(fn) { const cleanup = fn(); return cleanup; }
};

/* 只允许 require('react') */
const mod = loaded.factory((name) => {
  requestedModules.push(name);
  if (name === 'react') return ReactStub;
  throw new Error('不应 require：' + name);
});
check('factory 只 require 了 react', requestedModules.every((n) => n === 'react'), requestedModules.join(', '));
check('返回对象含 apply 与 inject', typeof mod?.apply === 'function' && Array.isArray(mod?.inject), JSON.stringify(mod?.inject));
check("inject 含 'slots' 与 'configForms'", mod.inject.includes('slots') && mod.inject.includes('configForms'), mod.inject.join(','));

/* ---------- 3. 假 ctx：捕获注册行为 ---------- */
const calls = { configFormsGet: [], slotsInject: [], registered: [], effects: [] };
const fakeSnapshot = { status: 'ready', mode: 'host', writable: true, revision: 1, value: { block_size: 800 }, base: {}, user: {} };
const fakeForm = {
  getSnapshot: () => fakeSnapshot,
  subscribe: () => () => {},
  set: async () => true,
  unset: async () => true
};
const ctx = {
  configForms: { get(id) { calls.configFormsGet.push(id); return fakeForm; } },
  slots: {
    inject(name, fn) { calls.slotsInject.push(name); return fn(); },
    register(def, component) { calls.registered.push({ def, component }); return () => {}; }
  },
  effect(fn) { calls.effects.push(fn); const c = fn(); return c; }
};

try {
  mod.apply(ctx);
  check('apply(ctx) 执行不抛', true);
} catch (error) {
  check('apply(ctx) 执行不抛', false, String(error));
}

check('configForms.get 以包名（profile 条目 id）调用', calls.configFormsGet.includes(ENTRY_ID), calls.configFormsGet.join(','));
check("注册进 slot 'plugins.item'", calls.slotsInject.includes('plugins.item'), calls.slotsInject.join(','));
check('注册项 id = 包名、name = plugins.item', calls.registered[0]?.def?.id === ENTRY_ID && calls.registered[0]?.def?.name === 'plugins.item',
  JSON.stringify(calls.registered[0]?.def));
check('注册项提供 label 函数', typeof calls.registered[0]?.def?.label === 'function');

/* ---------- 4. 渲染卡片（summary 与完整视图） ---------- */
const Card = calls.registered[0]?.component;
/**
 * slot 注册的是「外层包装」：(props) => h(SettingsCard, {...props, form})。
 * 先调用它拿到元素，再调用元素的 type（真实卡片组件）即可得到渲染树。
 */
function renderCard(props) {
  const outer = Card(props);
  return outer && typeof outer.type === 'function' ? outer.type(outer.props) : outer;
}

try {
  const summary = renderCard({ view: 'summary', form: fakeForm });
  check('summary 视图返回短摘要字符串', typeof summary === 'string' && summary.length > 0, String(summary));
} catch (error) {
  check('summary 视图返回短摘要字符串', false, String(error));
}
try {
  const tree = renderCard({ view: 'full', form: fakeForm });
  check('完整视图渲染返回元素树', !!tree && tree.__el === true);
  const html = JSON.stringify(tree);
  check('渲染树含保存按钮与字段控件', html.includes('保存') && html.includes('vet-input'));
} catch (error) {
  check('完整视图渲染返回元素树', false, String(error));
}

/* ---------- 5. 字段双向一致（client FIELDS ≡ Config 键） ---------- */
const fieldKeys = [...src.matchAll(/\{\s*key:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
const configKeys = Object.keys(Config?.dict ?? {});
const onlyUi = fieldKeys.filter((k) => !configKeys.includes(k));
const onlyConfig = configKeys.filter((k) => !fieldKeys.includes(k));
check('界面字段 ⊆ 配置字段', onlyUi.length === 0, `仅界面有：${onlyUi.join(', ')}`);
check('配置字段 ⊆ 界面字段', onlyConfig.length === 0, `仅配置有：${onlyConfig.join(', ')}`);
check('字段数一致（>=10）', fieldKeys.length === configKeys.length && fieldKeys.length >= 10, `UI ${fieldKeys.length} / Config ${configKeys.length}`);

/* ---------- 6. 保存路径已接线 ---------- */
check('保存路径调用 form.set 与 form.unset', /await form\.set\(/.test(src) && /await form\.unset\(/.test(src));

console.log('\n' + (failures === 0 ? 'PASS：client 设置页冒烟全部通过' : `FAIL：${failures} 项断言失败`));
process.exit(failures === 0 ? 0 : 1);
