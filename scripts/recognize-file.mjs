#!/usr/bin/env node
/**
 * recognize-file.mjs — 命令行入口：对任意本地图片运行 vision_tile_recognize（真实调用 API）
 *
 * 用法：
 *   node scripts/recognize-file.mjs <图片路径> [问题描述] [rotate角度]
 * 示例：
 *   node scripts/recognize-file.mjs "D:\lfn\DeepseekCLI Files\图像识别输入\L海关题干-已转正.jpg" "完整识别题干内容" 0
 *
 * 说明：key 从环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml 读取；
 *       识别结果打印到控制台（不代为统计/不显示 token 与费用，实际以官方账单为准）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

// ---- 参数 ----
const filePath = process.argv[2];
const question = process.argv[3] ?? '';
const rotate = Number(process.argv[4] ?? 0);
const strategy = process.argv[5] ?? 'smart'; // smart=pipeline=full
const ocrEngine = process.argv[6] ?? 'rapid'; // pipeline 模式 OCR 引擎（默认 rapid 实测快）
if (!filePath) {
  console.error('用法：node scripts/recognize-file.mjs <图片路径> [问题] [rotate] [strategy] [ocr_engine]');
  process.exit(2);
}
const abs = resolve(process.cwd(), filePath);
if (!existsSync(abs)) {
  console.error(`文件不存在：${abs}`);
  process.exit(2);
}

// ---- API key ----
async function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const cred = join(homedir(), '.dsh', '.credentials.yaml');
  if (existsSync(cred)) {
    const text = await readFile(cred, 'utf-8');
    const m = text.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)["']?/);
    if (m) return m[1];
  }
  throw new Error('未找到 API key（环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml）');
}
const apiKey = await resolveApiKey();
process.env.DEEPSEEK_API_KEY = apiKey; // 插件从 process.env 读取

// ---- 模拟 ctx 与加载插件 ----
const tools = [];
const fsShim = {
  async resolve(path, opts) {
    const cwd = opts?.cwd ?? process.cwd();
    const a = resolve(cwd, path);
    return { displayPath: a, targetKey: a };
  },
  processPath: (t) => t.displayPath,
  fileUrl: (t) => `file://${t.displayPath.replace(/\\/g, '/')}`,
  async stat() { return { type: 'file', version: 1 }; },
  async readBytes(t) { return readFileSync(fsShim.processPath(t)); }
};
const ctx = {
  tools: { register: (t) => tools.push(t) },
  fs: fsShim,
  emit: () => {},
  effect: (fn) => fn(),
  logger: { warn: () => {}, info: () => {} }
};
const plugin = await import('../src/index.js');
plugin.apply(ctx, {});
const recognizeTool = tools.find((t) => t.name === 'vision_tile_recognize');
if (!recognizeTool) throw new Error('未注册 vision_tile_recognize');

// ---- 执行识别 ----
console.log(`识别：${abs}（strategy=${strategy} rotate=${rotate} ocr=${ocrEngine}）...`);
const exec = { signal: undefined, agent: { session: { header: { cwd: process.cwd() } } } };
const t0 = Date.now();
const result = await recognizeTool.execute({ file_path: abs, question, rotate, strategy, ocr_engine: ocrEngine, max_tokens: 8192 }, exec);
console.log(`完成（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
console.log(`模式=${result.mode} 请求数=${result.stages?.length ?? '-'} 图像计数=${result.imageCount ?? '-'}`);
console.log('────────────────────────────────────────');
console.log(result.answer ?? result.summary ?? '(无内容)');
if (result.outputDir) console.log(`\n明细目录：${result.outputDir}`);
