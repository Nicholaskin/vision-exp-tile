/**
 * std-facet-smoke.mjs — 标准 Host Facet 冒烟测试（v0.5.0 生态化改造自测）
 *
 * 用法：node scripts/std-facet-smoke.mjs
 * 通过：exit 0 并输出摘要；失败：exit 1 并给出具体断言失败点。
 *
 * 覆盖点：
 *   1. dsh-plugin.json 能被 @dsh-std/manifest 的 parseManifest 解析（结构合法）；
 *   2. std-facet.js 默认导出为 FacetModule（activate 可调用）；
 *   3. activate 后发布恰好 3 个 tools.dsh/v1alpha1 Tool 资源，name 与
 *      dsh-plugin.json 声明一致（adapter 按 extension.metadata.name 匹配）；
 *   4. 每个 handler.resolve() 返回合法 ExecutableToolDefinition
 *      （name/description/parameters/output/execute 俱备）；
 *   5. vision_tile_split.execute 用隔离 DSH_HOME + 真实小图跑通，
 *      返回 { data, content }（标准结果形状）；
 *   6. scope.add 的清理函数全部可执行（卸载不抛）；
 *   7. src 业务模块零 @deepseek-ai/* import（标准装载链洁净）。
 *
 * ⚠ 冒烟把 process.env.DSH_HOME 指向临时目录：initFileSettings / 设备回写
 *   只写临时目录，绝不触碰真实 ~/.dsh。
 */

import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

/* ---------- 0. 隔离 DSH_HOME ---------- */
const home = mkdtempSync(join(tmpdir(), 'vision-tile-smoke-'));
process.env.DSH_HOME = home;

let failures = 0;
function check(label, cond, extra = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? '✔' : '✘'} ${label}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
  return ok;
}

/* ---------- 1. 构造 100×120 测试小图（纯色 PNG，pngjs 同步生成） ---------- */
const png = new PNG({ width: 100, height: 120 });
for (let i = 0; i < png.data.length; i += 4) {
  png.data[i] = 200; png.data[i + 1] = 160; png.data[i + 2] = 120; png.data[i + 3] = 255;
}
const imagePath = join(home, 'sample.png');
writeFileSync(imagePath, PNG.sync.write(png));

/* ---------- 2. stub ActivationContext（模拟 lifecycle 契约） ---------- */
const published = [];
const disposers = [];
const context = {
  identity: { component: 'vision.tile', facet: 'host' },
  plan: undefined,
  scope: {
    signal: new AbortController().signal,
    /** 收集清理函数（激活作用域卸载时逐个执行）。 */
    add(fn) { disposers.push(fn); return fn; },
  },
  protocols: { agreement: undefined, client: undefined, implement() {} },
  extensions: {
    /** 收集发布记录：reference / name / handler。 */
    publish(reference, name, handler) {
      published.push({ reference, name, handler });
      // 真实 adapter 返回注销函数；stub 返回空操作（disposers 已收集 handle）。
      return () => {};
    },
  },
};

/* ---------- 3. import 标准 facet 并激活 ---------- */
const moduleUrl = pathToFileURL(join(process.cwd(), 'std-facet.js')).href;
const facetModule = (await import(moduleUrl)).default;
check('std-facet.js 默认导出一个对象', facetModule && typeof facetModule === 'object');
check('FacetModule 含 activate 函数', typeof facetModule?.activate === 'function');

await facetModule.activate(context);

/* ---------- 4. 断言发布结果 ---------- */
check('恰好发布 3 个 Tool 资源', published.length === 3, `实际 ${published.length}`);
const names = published.map(p => p.name).sort();
check('工具名 = [split, recognize, region_crop]', JSON.stringify(names) === JSON.stringify(['vision_region_crop', 'vision_tile_recognize', 'vision_tile_split']), JSON.stringify(names));
check('协议引用 = tools.dsh/v1alpha1 + Tool', published.every(p => p.reference.apiVersion === 'tools.dsh/v1alpha1' && p.reference.kind === 'Tool'));

/* ---------- 4b. dsh-plugin.json 经 @dsh-std/manifest 正式校验 ---------- */
{
  const { parseManifest } = await import('@dsh-std/manifest');
  const manifestPath = join(process.cwd(), 'dsh-plugin.json');
  try {
    const parsed = parseManifest(readFileSync(manifestPath, 'utf8'), { source: manifestPath });
    check('dsh-plugin.json 通过 parseManifest', true);
    check('manifest id/name/版本齐全', parsed.id === 'vision.tile' && parsed.name === 'vision-exp-tile' && /^\d+\.\d+\.\d+/.test(parsed.version), JSON.stringify({ id: parsed.id, name: parsed.name, version: parsed.version }));
    // 与 contributes["x-tools"] 的一致性（dsh-plugin.json 声明 vs 冒烟发布）
    const declared = parsed.contributes?.['x-tools'] ?? [];
    const declSet = new Set(declared.map(d => d.name));
    check('manifest 声明 3 个工具且与发布名一致', declared.length === 3 && published.every(p => declSet.has(p.name)), JSON.stringify(declared.map(d => d.name)));
  } catch (error) {
    check('dsh-plugin.json 通过 parseManifest', false, String(error));
  }
}

/* ---------- 5. 断言 ExecutableToolDefinition 形状 ---------- */
let defs = null;
try {
  defs = published.map(p => p.handler.resolve());
  check('每个 handler.resolve() 返回定义', defs.every(Boolean));
  check('定义含 name/description/parameters/output/execute', defs.every(d =>
    typeof d.name === 'string' && typeof d.description === 'string'
    && d.parameters && typeof d.parameters === 'object'
    && d.output && typeof d.output === 'object'
    && typeof d.execute === 'function'));
} catch (error) {
  check('handler.resolve() 不抛错', false, String(error));
}

/* ---------- 6. 真实执行 vision_tile_split（纯切图路径，不联网） ---------- */
const splitDef = defs.find(d => d.name === 'vision_tile_split');
if (splitDef) {
  try {
    const splitCtx = {
      signal: new AbortController().signal,
      // 相对路径委托 readWorkspaceFile 路径：直接给绝对路径，走 node:fs 直读。
    };
    const result = await splitDef.execute({ file_path: imagePath }, splitCtx);
    check('split.execute 返回 { data, content }', result && typeof result === 'object' && 'data' in result && Array.isArray(result.content));
    check('content 为文本块', result.content.every(c => c && c.type === 'text' && typeof c.text === 'string'));
    check('data 含尺寸与原图路径（splits=false 因小图 <800 不切块）', result.data
      && result.data.width === 100 && result.data.height === 120
      && typeof result.data.path === 'string' && result.data.path.length > 0, JSON.stringify(result.data).slice(0, 120));
  } catch (error) {
    check('split.execute 真实执行通过', false, String(error));
  }
}

/* ---------- 7. 清理函数可执行 ---------- */
try {
  for (const d of disposers) d();
  check('scope.add 清理全部执行不抛', true);
} catch (error) {
  check('scope.add 清理全部执行不抛', false, String(error));
}

/* ---------- 8. src 业务链路零宿主 @deepseek-ai/* import ---------- */
const chain = ['src/index.js', 'src/runtime.js', 'src/settings-file.js', 'src/host-io.js', 'src/peer-config.js', 'src/device.js', 'src/config.js'];
let bad = [];
for (const rel of chain) {
  const src = readFileSync(join(process.cwd(), rel), 'utf8');
  for (const m of src.matchAll(/^import .*?from '([^']+)'/gm)) {
    if (String(m[1]).startsWith('@deepseek-ai/')) bad.push(`${rel} -> ${m[1]}`);
  }
}
check('运行时链路无 @deepseek-ai/* import', bad.length === 0, bad.join('; '));

/* ---------- 收尾 ---------- */
rmSync(home, { recursive: true, force: true });
console.log('\n' + (failures === 0 ? 'PASS：std-facet 冒烟全部通过' : `FAIL：${failures} 项断言失败`));
process.exit(failures === 0 ? 0 : 1);
