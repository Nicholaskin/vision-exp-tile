/**
 * scripts/client-preview.mjs — 生成设置页的**离线预览 HTML**（无需启动 DSH、无需浏览器插件环境）
 *
 * 为什么需要它：client.js 是浏览器 bundle，改完界面在真实插件页里看效果需要
 * 「同步到生产 → 刷新页面」，一轮成本高且不方便对比。本脚本把 client.js
 * **真实执行一遍**（vm 里造 window.__ModuleLoader__ + 假 React），拿到
 * SettingsCard 的渲染树，再序列化成静态 HTML，用浏览器直接打开即可看排版。
 *
 * ⚠ 能力边界（别把它当成端到端验证）：
 *   - 交互（点标题折叠、输入搜索、改字段、点保存）**演示不了**：假 React 的
 *     setState 是 no-op，页面呈现的是各组件的**初始态**。
 *   - 因此「未保存改动」的橙色高亮也不会出现（那要编辑后才触发）。
 *   - 真实验证仍然只能靠：① scripts/client-settings-smoke.mjs（执行级冒烟）
 *     ② 人工在插件页眼看。
 *
 * 用法：node scripts/client-preview.mjs  → 生成 _v1验证/client-preview.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const src = readFileSync(join(ROOT, 'client.js'), 'utf8');

/* ------------------------------------------------------------------ */
/* 1. 在 vm 里执行 client.js，取出注册进 plugins.item 的卡片组件        */
/* ------------------------------------------------------------------ */

let loaded = null;
const sandbox = { console, window: { __ModuleLoader__: { load(def) { loaded = def; } } } };
createContext(sandbox);
runInContext(src, sandbox, { filename: 'client.js' });

/** 假 React：只实现本页用到的面（createElement / useState / useEffect）。 */
const hooks = [];
let hookIndex = 0;
const ReactStub = {
  createElement(type, props, ...children) {
    return { __el: true, type, props: { ...(props || {}), children } };
  },
  useState(init) {
    const i = hookIndex;
    hookIndex += 1;
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init;
    // setState 是 no-op：预览只呈现初始态（见文件头「能力边界」）
    return [hooks[i], () => {}];
  },
  useEffect() { return undefined; }
};

const mod = loaded.factory((name) => {
  if (name === 'react') return ReactStub;
  throw new Error('不应 require：' + name);
});

const captured = { component: null };
/**
 * ⚠ 关键点：client.js 的 apply() 里把 `ctx.configForms.get(ENTRY_ID)` 的结果**闭包**
 * 进了外层包装组件 `(props) => h(SettingsCard, {...props, form})`，它会覆盖调用方
 * 传进来的 form。所以场景数据必须换到**这个共享 form** 上（每个场景渲染前改它的
 * snapshot），否则渲染出来永远是空配置（曾经就踩过：两个场景都显示「已自定义 0 项」）。
 */
let currentSnapshot = { status: 'ready', mode: 'host', writable: true, revision: 1, value: {}, base: {}, user: {} };
const sharedForm = {
  getSnapshot: () => currentSnapshot,
  subscribe: () => () => {},
  set: async () => true,
  unset: async () => true
};
const fakeCtx = {
  configForms: { get: () => sharedForm },
  slots: {
    inject: (name, fn) => fn(),
    register: (def, component) => { captured.component = component; return () => {}; }
  },
  effect: (fn) => fn()
};
mod.apply(fakeCtx);
const Card = captured.component;

/* ------------------------------------------------------------------ */
/* 2. 渲染树 → HTML 序列化（够用即可：本页只用到 div/span/button/        */
/*    input/select/option/label/p/code/section/style 这些元素）          */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img']);
const ATTR_MAP = { className: 'class', htmlFor: 'for' };
const SKIP_ATTR = new Set(['key', 'children', 'autoComplete', 'view', 'form']);

/** HTML 文本转义（预览页里没有用户输入，但保持规矩）。 */
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function attrText(name, value) {
  const attr = ATTR_MAP[name] || name;
  if (value === undefined || value === null || value === false) return '';
  if (typeof value === 'function' || typeof value === 'object') return '';
  if (value === true) return ` ${attr}`;
  return ` ${attr}="${esc(value).replace(/"/g, '&quot;')}"`;
}

function serialize(node) {
  if (node === null || node === undefined || node === false) return '';
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (!node.__el) return esc(String(node));

  const { type, props } = node;
  const children = props.children || [];

  // 卡片自带的 <style> 在这里跳过：预览页把 STYLE 统一注入一次（真实页面上
  // 插件卡片只注册一个，效果等价；两个场景各注入一遍会重复几百行 CSS）
  if (type === 'style') return '';

  const attrs = Object.keys(props)
    .filter((k) => !SKIP_ATTR.has(k))
    .map((k) => attrText(k, props[k]))
    .join('');

  if (typeof type === 'function') {
    // 理论上网卡不会走到这（约束①：不用自定义子组件）；真遇到就渲染它，别静默丢内容
    return serialize(type(props));
  }
  if (VOID_TAGS.has(type)) return `<${type}${attrs}>`;
  return `<${type}${attrs}>${serialize(children)}</${type}>`;
}

/** 用给定的「Host 生效值」渲染一次卡片（每次渲染前重置 hook 槽与共享快照）。 */
function renderCard(value, view = 'full') {
  hooks.length = 0;
  hookIndex = 0;
  currentSnapshot = { status: 'ready', mode: 'host', writable: true, revision: 1, value, base: {}, user: {} };
  const outer = Card({ view });
  return serialize(outer.type(outer.props));
}

/* ------------------------------------------------------------------ */
/* 3. 组装预览页（外壳模拟宿主页面的字体与留白；卡片本身完全来自渲染树）  */
/* ------------------------------------------------------------------ */

const STYLE = src.match(/const STYLE = `([\s\S]*?)`;/)?.[1] ?? '';

const scenes = [
  {
    title: '场景 A · 全新安装（未自定义任何项）',
    note: '「常用」组默认展开，其余 7 组收起。组头右侧的徽标只在有自定义项时出现，所以这里干干净净。',
    value: {}
  },
  {
    title: '场景 B · 已切到本地端点 + 开了缓存（有自定义项）',
    note: '组头出现「已自定义 N 项」徽标；即使整组收起，也能一眼看出哪组被动过。',
    value: {
      base_url: 'http://localhost:8000',
      provider: 'openai',
      model: 'qwen2.5-vl-7b-instruct',
      block_size: 800,
      out_dir: 'D:\\DSH-Files-v2\\图像识别输出',
      result_cache: true,
      api_concurrency: 2,
      debug: true
    }
  }
];

const sceneHtml = scenes.map((scene, i) => `
  <section class="pv-scene">
    <h2>${esc(scene.title)}</h2>
    <p class="pv-note">${esc(scene.note)}</p>
    <div class="pv-frame">${renderCard(scene.value)}</div>
  </section>
  ${i === 0 ? '' : ''}
`).join('');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>vision-exp-tile 设置页预览</title>
<style>
  /* ── 预览页外壳（模拟宿主页面的排版环境；卡片自身的样式来自 client.js 的 STYLE） ── */
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #f5f6f8; color: #1c1f23; }
  @media (prefers-color-scheme: dark) {
    body { background: #17191c; color: #e6e8ea; }
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .pv-lead { margin: 0 0 22px; opacity: .7; font-size: 13px; }
  .pv-scene { margin: 0 0 30px; }
  .pv-scene h2 { font-size: 14px; margin: 0 0 4px; }
  .pv-note { margin: 0 0 10px; font-size: 12px; opacity: .65; }
  /* 模拟宿主「插件」页里的卡片容器：限定宽度 + **可滚动**。
     滚动容器这一层必须模拟 —— 2026-10-02 那次「动作栏吸底与下方分组文字重叠」的
     真机问题，离线预览之所以没照出来，正因为当时这里是随内容自然撑高的。
     加了 max-height 之后，任何 position:sticky / 绝对定位的错位都会在预览里现形。 */
  .pv-frame { max-width: 720px; max-height: 540px; overflow: auto; padding: 16px 18px; border-radius: 12px;
    background: color-mix(in srgb, currentColor 4%, transparent);
    border: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
  ${STYLE}
</style>
</head>
<body>
  <h1>vision-exp-tile 设置页 · 离线预览</h1>
  <p class="pv-lead">
    渲染树由 client.js <b>真实执行</b>产出（scripts/client-preview.mjs），排版与插件页一致；
    灰框是<b>可滚动的</b>（模拟插件页的滚动区，用来照出吸底/定位类错位）。
    但<b>交互演示不了</b>（假 React 的 setState 是空操作）——折叠、搜索、改字段后的橙色高亮，
    需在真实插件页里操作才看得到。
  </p>
  ${sceneHtml}
</body>
</html>
`;

const outDir = join(ROOT, '_v1验证');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'client-preview.html');
writeFileSync(outPath, html, 'utf8');
console.log('已生成预览：' + outPath);
console.log('渲染树字节数：' + sceneHtml.length);
