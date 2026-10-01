/**
 * scripts/self-check.mjs — 交互式自检入口（v0.4.1）
 *
 * 目的（用户建议②）：测试前先问用户是否进行测试（一般推荐运行，因为要根据实战
 * 测试看插件是否好用）。同时自动识别设备（建议③）并把慢机推荐注入测试环境，
 * 实现「慢机测试自适应」——降低较差机型 OCR 池超时导致的偶发测试失败。
 *
 * 流程：
 *   1. 设备探测（probeDevice）+ 档位判定（classifyTier），打印设备画像与将生效的推荐；
 *   2. 交互询问（仅 process.stdin.isTTY 时）："是否运行全量测试？（Y 全量 / T 跳过
 *      时序敏感断言 / N 跳过；一般推荐运行）"；支持参数 --yes / --skip-timing / --no
 *      用于无人值守（CI/管道），未给参数且非交互则默认 --yes；
 *   3. 以子进程跑 node --test（用 package.json 的显式文件列表），注入
 *      DSH_OCR_POOL_TIMEOUT / VISION_TEST_TIMEOUT_FACTOR / VISION_TEST_SKIP_TIMING
 *      （档位推荐 × 用户模式），汇总退出码并给出改善建议；
 *   4. 结果：通过/失败摘要 + 建议（如：慢机仍超时 → 设置页调高 ocr_pool_timeout_ms
 *      或开启 test_skip_timing）。
 *
 * 仅使用 Node 内置模块（node:fs / node:child_process / node:readline），无第三方依赖。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { probeDevice, classifyTier, applyTierRecommendations, deviceProfileText } from '../src/device.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* ------------------------------------------------------------------ */
/* 参数解析                                                             */
/* ------------------------------------------------------------------ */

// 支持：--yes（全量）/ --skip-timing（跳过时序断言）/ --no（跳过测试）/ --help。
// 未指定且非交互终端时，默认按全量（--yes，推荐）运行。
function parseArgs(argv) {
  const args = { mode: null, help: false };
  for (const a of argv) {
    if (a === '--yes' || a === '-y') args.mode = 'yes';
    else if (a === '--skip-timing' || a === '-t') args.mode = 'skip-timing';
    else if (a === '--no' || a === '-n') args.mode = 'no';
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/** 从 package.json 的 scripts.test 提取 node --test 的显式文件列表（保持与 npm test 一致）。 */
function testFilesFromPackage() {
  const pkgPath = join(ROOT, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('未找到 package.json（应在插件根目录运行此脚本）');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const script = String(pkg.scripts?.test ?? '');
  const m = script.match(/node --test\s+([\s\S]+)/);
  if (!m || !m[1]) throw new Error('package.json 的 scripts.test 不是 "node --test <files>" 格式');
  return m[1].trim().split(/\s+/).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 设备画像与推荐                                                       */
/* ------------------------------------------------------------------ */

// 探测设备（含 GPU，≤1.5s）并判定档位。
const probe = await probeDevice();
const tier = classifyTier(probe);
const rec = applyTierRecommendations(tier);

// 打印设备画像 + 将生效的推荐。
console.log('=== vision-exp-tile 自检 ===');
console.log('设备画像：' + deviceProfileText(probe));
console.log('性能档位：' + tier);
console.log('将生效推荐：' + JSON.stringify(rec) + '（slow 档自动放宽 OCR 池超时/降并发/关 GPU/测试倍率×4；其余保持默认）');
console.log('');

/* ------------------------------------------------------------------ */
/* 交互确认（仅 TTY；否则按参数/默认）                                  */
/* ------------------------------------------------------------------ */

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node scripts/self-check.mjs [--yes|--skip-timing|--no]');
  console.log('  --yes          运行全量测试（推荐；按设备档位注入超时/倍率）');
  console.log('  --skip-timing  运行测试但跳过时序敏感断言（VISION_TEST_SKIP_TIMING=1）');
  console.log('  --no           跳过测试（仅设备画像+推荐）');
  process.exit(0);
}

let mode = args.mode;
if (!mode && process.stdin.isTTY) {
  // 交互询问：Y 全量 / T 跳过时序断言 / N 跳过（一般推荐运行，因为要看插件是否好用）。
  const answer = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('是否运行全量测试？（Y 全量 / T 跳过时序敏感断言 / N 跳过；一般推荐运行，因为要根据实测确认插件可用性）：', (line) => {
      rl.close();
      resolve(String(line).trim().toUpperCase());
    });
  });
  if (answer === 'Y' || answer === '') mode = 'yes';
  else if (answer === 'T' || answer === 'Y') mode = answer === 'T' ? 'skip-timing' : 'yes';
  else if (answer === 'N') mode = 'no';
  else mode = 'yes'; // 其它输入按推荐全量
} else if (!mode) {
  // 非交互且未指定参数 → 默认全量（推荐）。
  mode = 'yes';
  console.log('未检测到交互终端且未指定 --yes/--no/--skip-timing，默认按全量运行（--yes）。');
}

if (mode === 'no') {
  console.log('已选择跳过测试。设备画像与推荐见上方。');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 注入测试环境变量（档位推荐 × 用户模式）                              */
/* ------------------------------------------------------------------ */

// DSH_OCR_POOL_TIMEOUT：运行时 OCR 池单请求超时（该值在测试进程内也会被 ocr-local
//   等模块读取；单元测试的池超时则用 suite-env 的倍率放大）。
const poolTimeout = rec.ocrPoolTimeoutMs ?? 120000;

// VISION_TEST_TIMEOUT_FACTOR：测试超时判定倍率（slow=4，其余=1）。
const factor = rec.testTimeoutFactor ?? 1;

// VISION_TEST_SKIP_TIMING：用户声明跳过时序敏感断言时置 1。
const skipTimingEnv = mode === 'skip-timing' ? '1' : (process.env.VISION_TEST_SKIP_TIMING ?? '');

// 组装给子进程的 env（不覆盖用户已显式设置的值——如已在外部设了倍率）。
const childEnv = {
  ...process.env,
  ...(process.env.DSH_OCR_POOL_TIMEOUT ? {} : { DSH_OCR_POOL_TIMEOUT: String(poolTimeout) }),
  ...(process.env.VISION_TEST_TIMEOUT_FACTOR ? {} : { VISION_TEST_TIMEOUT_FACTOR: String(factor) }),
  ...(skipTimingEnv ? { VISION_TEST_SKIP_TIMING: skipTimingEnv } : {})
};
if (skipTimingEnv) {
  console.log('本次将跳过时序敏感断言（VISION_TEST_SKIP_TIMING=1）。');
}

/* ------------------------------------------------------------------ */
/* 运行 node --test                                                    */
/* ------------------------------------------------------------------ */

const files = testFilesFromPackage();
console.log('运行测试（' + files.length + ' 个文件）：' + files.join(' '));
console.log('注入：DSH_OCR_POOL_TIMEOUT=' + childEnv.DSH_OCR_POOL_TIMEOUT + ' VISION_TEST_TIMEOUT_FACTOR=' + childEnv.VISION_TEST_TIMEOUT_FACTOR + (childEnv.VISION_TEST_SKIP_TIMING ? ' VISION_TEST_SKIP_TIMING=' + childEnv.VISION_TEST_SKIP_TIMING : ''));
console.log('');

// 用 stdio:'inherit' 让测试输出直接流向终端；从 close 事件取退出码。
const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', ...files], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit'
  });
  child.on('error', (err) => {
    console.error('启动测试进程失败：' + err.message);
    resolve(1);
  });
  child.on('close', (code) => resolve(code ?? 1));
});

/* ------------------------------------------------------------------ */
/* 结果汇总与建议                                                       */
/* ------------------------------------------------------------------ */

console.log('');
if (exitCode === 0) {
  console.log('✅ 测试全部通过（按设备档位注入超时/倍率后仍全绿）。');
} else {
  console.log('❌ 测试未通过（退出码 ' + exitCode + '）。改进建议：');
  console.log('   1) 若为 OCR 池/时序类超时：在设置页「图像识别→高级」把 ocr_pool_timeout_ms 调大');
  console.log('      （或本机性能差时直接设 performance_tier=slow），或开启 test_skip_timing 声明跳过时序断言；');
  console.log('   2) 若与设备无关的断言失败：请对照测试输出定位具体用例；');
  console.log('   3) 可重跑：node scripts/self-check.mjs --skip-timing（跳过时序敏感断言）。');
}
process.exit(exitCode);
