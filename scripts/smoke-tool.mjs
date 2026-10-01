#!/usr/bin/env node
/**
 * smoke-tool.mjs — 端到端冒烟测试（不启动 DSH，模拟 Cordis 上下文）
 *
 * 验证链路：
 *   加载插件 apply(ctx) → 注册工具 → 用真实测试图执行 vision_tile_split
 *   → 校验切块数量/坐标/磁盘文件/输出文本结构
 *   → 再执行 vision_tile_recognize（无 API key → 校验报错信息友好）
 *
 * 运行：node scripts/smoke-tool.mjs
 */

import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------- 1. 模拟 ctx（tools 注册收集 + fs 本地实现） ----------
/** 收集注册的工具 */
const tools = [];
/** 简易 filesystem 影子实现（覆盖插件用到的 resolve/stat/readBytes/processPath） */
const fsShim = {
  async resolve(path, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    const abs = resolve(cwd, path);
    return { displayPath: abs, targetKey: abs }; // FsTarget：displayPath 供展示，processPath 由 fs 服务解析
  },
  processPath: (target) => target.displayPath,
  fileUrl: (target) => `file://${target.displayPath.replace(/\\/g, '/')}`,
  async stat(target) {
    try {
      return { type: 'file', version: 1 };
    } catch {
      return undefined;
    }
  },
  async readBytes(target, _signal, _maxBytes) {
    return readFileSync(fsShim.processPath(target));
  }
};
const ctx = {
  tools: { register: (t) => tools.push(t) },
  fs: fsShim,
  emit: () => {},
  // Cordis 的 ctx.effect 注册"立即执行 + 生命周期托管"的贡献；mock 里直接执行一次即可
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {} }
};

// ---------- 2. 加载插件（与 DSH 相同入口） ----------
const plugin = await import('../src/index.js');
plugin.apply(ctx, {}); // 使用默认配置
console.log(`[1] 插件加载 OK：${plugin.name}，注册工具：${tools.map((t) => t.name).join(', ')}`);
if (tools.length !== 4) throw new Error(`预期 4 个工具，实际 ${tools.length}`);
const splitTool = tools.find((t) => t.name === 'vision_tile_split');
const recognizeTool = tools.find((t) => t.name === 'vision_tile_recognize');
const regionTool = tools.find((t) => t.name === 'vision_region_crop');
const batchTool = tools.find((t) => t.name === 'vision_batch_recognize');
if (!splitTool || !recognizeTool || !regionTool || !batchTool) throw new Error('缺少预期工具');

// ---------- 3. 真实测试图切分（3200×2000 夹具 → 4×3 = 12 块） ----------
const fixture = resolve(process.cwd(), 'tests/fixtures/test-3200x2000.png');
if (!existsSync(fixture)) throw new Error(`夹具不存在：${fixture}`);
const outDir = mkdtempSync(join(tmpdir(), 'vision-smoke-'));
const exec = { signal: undefined, agent: { session: { header: { cwd: process.cwd() } } } };
const result = await splitTool.execute({ file_path: fixture, out_dir: outDir }, exec);
console.log(`[2] vision_tile_split 执行 OK：${result.width}×${result.height} → ${result.rows}×${result.cols}，共 ${result.tiles.length} 块，引擎=${result.engine}`);
if (result.splits !== true) throw new Error('预期切分，得到 splits=false');
if (result.tiles.length !== 12) throw new Error(`预期 12 块，实际 ${result.tiles.length}`);
// 校验坐标：第 0 块与第 11 块（行优先）
const t0 = result.tiles[0];
const t11 = result.tiles[11];
if (t0.x !== 0 || t0.y !== 0 || t0.w !== 800 || t0.h !== 800) throw new Error(`首块坐标错误：${JSON.stringify(t0)}`);
if (t11.x !== 2400 || t11.y !== 1600 || t11.w !== 800 || t11.h !== 400) throw new Error(`末块坐标错误：${JSON.stringify(t11)}`);
// 校验磁盘文件
const files = readdirSync(result.outDir);
if (!files.includes('test-3200x2000_overview.png')) throw new Error(`缺少 overview：${files.join(', ')}`);
console.log(`[3] 块文件校验 OK：${result.outDir} 下 ${files.length} 个文件（含 overview）`);

// ---------- 4. render 输出（模型可见文本）要包含坐标清单与聚合逻辑 ----------
const rendered = splitTool.output.render({ file_path: fixture }, result);
const text = rendered[0].text;
for (const keyword of ['坐标清单', '聚合逻辑', '禁止编造', '行优先', 'r0c0', '2400,1600']) {
  if (!text.includes(keyword)) throw new Error(`render 输出缺少关键内容「${keyword}」`);
}
console.log('[4] render 文本校验 OK：坐标清单 + 分块聚合逻辑完整');

// ---------- 5. recognize 无 API key 时应给出友好报错 ----------
try {
  await recognizeTool.execute({ file_path: fixture, out_dir: outDir }, exec);
  throw new Error('未配置 API key 时不应成功');
} catch (error) {
  if (!String(error.message).includes('API key')) throw error;
  console.log(`[5] vision_tile_recognize 无 key 校验 OK：${error.message.slice(0, 60)}...`);
}

console.log('\n✅ 冒烟测试全部通过：插件注册 → 真实切图(12块) → 坐标/文件/渲染/报错 全链路正常');
