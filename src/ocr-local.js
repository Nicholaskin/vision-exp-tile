/**
 * ocr-local.js — 本地 OCR 引擎封装（全自动编排用）
 *
 * 设计原则：本插件**只使用纯官方 DSH 能力与开源/系统组件**，不依赖任何第三方 DSH 插件。
 *  - paddle：$HOME/paddle_venv（PaddleOCR，Apache-2.0，用户自行安装的可选环境）
 *  - rapid ：$HOME/rapid_venv（RapidOCR，Apache-2.0，用户自行安装的可选环境）
 *  - windows：Windows.Media.Ocr（WinRT，操作系统自带，零依赖兜底）
 * 引擎选择：paddle → rapid → windows（自动降级，全部不可用时由 pipeline 转交视觉 API）。
 * 每个引擎路径可用环境变量覆盖（DSH_PADDLE_PYTHON / DSH_RAPID_PYTHON / DSH_PADDLE_CACHE）。
 * 说明：OCR 的命令/脚本写法参考自开源项目 picturereader（MIT License），
 * 本实现为独立封装，运行时与 picturereader 插件互不依赖。
 *
 * 输出统一结构：{ engine, text, lines: [{text, x, y, width, height, score?}] }
 * lines 为像素框（相对传入 PNG 的尺寸），供模型理解版式。
 */

import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getOcrPool } from './ocr-pool.js';
import { autoPreprocess } from './preprocess.js';

/** 插件 src 目录（用于定位 worker 脚本） */
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 本地 OCR 结果缓存（内容哈希；同图重复识别直接命中，免重复计算/加载）   */
/* ------------------------------------------------------------------ */

/**
 * 缓存目录：$HOME/.vision-exp-tile-ocr-cache（env DSH_OCR_CACHE_DIR 覆盖）。
 * 开关：DSH_OCR_CACHE=0 禁用（默认启用）；TTL：DSH_OCR_CACHE_TTL_HOURS（默认 48 小时）。
 */
function ocrCacheDir() {
  return process.env.DSH_OCR_CACHE_DIR ?? join(homedir(), '.vision-exp-tile-ocr-cache');
}

/** 缓存是否启用（DSH_OCR_CACHE=0 → 禁用） */
export function ocrCacheEnabled() {
  return String(process.env.DSH_OCR_CACHE ?? '1').trim() !== '0';
}

/** 缓存 TTL（小时；任何有限数字均可——负数/0 视为立即过期，便于测试与应急） */
function ocrCacheTtlMs() {
  const h = Number(process.env.DSH_OCR_CACHE_TTL_HOURS ?? 48);
  const hours = Number.isFinite(h) ? h : 48;
  return hours * 3600 * 1000;
}

/** 内容哈希键（png 字节 sha256 前 32 hex） */
export function ocrCacheKey(pngBuffer) {
  return createHash('sha256').update(pngBuffer).digest('hex').slice(0, 32);
}

/**
 * 查询缓存：命中且未过期 → {engine,text,lines,cached:true}；否则 null。
 * 损坏/过期条目自动忽略（不抛错）。
 */
export async function ocrCacheGet(key) {
  if (!ocrCacheEnabled()) return null;
  try {
    const file = join(ocrCacheDir(), `${key}.json`);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.lines)) return null;
    if (Date.now() - (entry.ts ?? 0) > ocrCacheTtlMs()) return null;
    return { engine: entry.engine ?? 'rapid', text: entry.text ?? '', lines: entry.lines, cached: true };
  } catch {
    return null;
  }
}

/** 写入缓存（竞态无害；失败静默） */
export async function ocrCacheSet(key, entry) {
  if (!ocrCacheEnabled()) return;
  try {
    const dir = ocrCacheDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.json`), JSON.stringify({
      engine: entry.engine, text: entry.text, lines: entry.lines, ts: Date.now()
    }), 'utf8');
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/**
 * 常驻 OCR 进程池（性能优化：消除每次 spawn + 模型加载成本）。
 * 注意：paddle 与 rapid 分别位于两个 venv（解释器不同），故按引擎取对应 python，
 * getOcrPool 以 pythonCmd 为键 → 自动形成"每个引擎一个池"的两个常驻池。
 * 默认 DSH_OCR_POOL=4（每池 4 路常驻并行，可按核数调 1-8；0=禁用回退旧逻辑）。
 * pool 为 null 时 ocrText 走原有"每张一进程"逻辑（兜底）。
 */
function ocrPool(engineUsed) {
  try {
    if (engineUsed === 'windows') {
      // Windows OCR 常驻池：powershell.exe + ocr-win-worker.ps1（免 Python 形态核心）
      const worker = join(__dirnameLocal, 'ocr-win-worker.ps1');
      return getOcrPool('powershell.exe', undefined, worker);
    }
    // v0.4.0：gpu 走独立 GPU venv 池；paddle 走 paddle venv；其余 rapid 走 CPU venv
    let py;
    if (engineUsed === 'paddle') py = paddlePython();
    else if (engineUsed === 'gpu') py = gpuPython();
    else py = rapidPython();
    if (!py) return null; // venv 缺失 → 上层走单进程兜底
    return getOcrPool(py, undefined, undefined, ocrPoolTimeoutMs());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 引擎路径探测                                                         */
/* ------------------------------------------------------------------ */

/** venv Python 可执行文件（Windows 在 Scripts/，类 Unix 在 bin/） */
function venvPython(venvDir) {
  const base = join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin');
  return join(base, process.platform === 'win32' ? 'python.exe' : 'python3');
}

/** 测试可注入的 venv 根目录（覆盖 homedir 推断，便于单测用临时目录 mock 路径存在性）。 */
let _venvHomeOverride = null;
/** @private 单测用：设置 venv 根目录覆盖。 */
export function _setVenvHomeForTest(h) { _venvHomeOverride = h; }
/** @private 单测用：清除 venv 根目录覆盖。 */
export function _clearVenvHomeForTest() { _venvHomeOverride = null; }
/** venv 根目录（缺省 = homedir）；可被 _setVenvHomeForTest 覆盖。 */
function venvHome() { return _venvHomeOverride ?? homedir(); }

/**
 * 解析 venv python 路径（纯函数，可选注入 exists 以便单测 mock）。
 * 优先级：显式 env > 默认 venv（存在）> 默认 venv（兜底失败安全）。
 * v0.5.0 起**取消 picturereader venv 复用**：原先的 "peer venv 候选" 分支已移除
 * —— 实证 own 与 peer 路径完全相同（都是 $HOME/<venv 名>），该分支恒为死逻辑。
 * @param {object} o - { env, own, exists? }
 * @param {string} [o.env] - 用户显式 env（最高优先）。
 * @param {string} o.own - 本插件默认路径。
 * @param {(p:string)=>boolean} [o.exists] - 存在性判断（默认 existsSync）。
 * @returns {string} 选定的 python 路径。
 */
export function resolveVenvPython({ env, own, exists = existsSync }) {
  if (env) return env;
  if (exists(own)) return own;
  return own; // 不可用 → 本插件默认（引擎会失败安全回退 Windows OCR 等）
}

/**
 * PaddleOCR venv Python（可移植默认：$HOME/<venv 名>；环境变量 DSH_PADDLE_PYTHON 覆盖）。
 * 例如 Windows 默认 C:\Users\你\paddle_venv\Scripts\python.exe；Linux/macOS 默认 ~/paddle_venv/bin/python3。
 */
export function paddlePython() {
  const own = venvPython(join(venvHome(), 'paddle_venv'));
  return resolveVenvPython({ env: process.env.DSH_PADDLE_PYTHON, own });
}

/** RapidOCR venv Python（同 paddlePython 的可移植约定；DSH_RAPID_PYTHON 覆盖） */
export function rapidPython() {
  const own = venvPython(join(venvHome(), 'rapid_venv'));
  return resolveVenvPython({ env: process.env.DSH_RAPID_PYTHON, own });
}

/**
 * RapidOCR GPU venv Python（v0.4.0：独立 GPU venv，DSH_OCR_GPU_PYTHON 覆盖）。
 * 默认 ~/rapid_gpu_venv；venv 缺失（解释器不存在）即返回 null，上层据此回退 rapid(CPU)。
 */
export function gpuPython() {
  // 用 venvHome()（可被测试覆盖的根目录）而非 homedir()，保持与 rapid/paddle 一致；本插件 GPU venv 专用。
  const p = process.env.DSH_OCR_GPU_PYTHON ?? venvPython(join(venvHome(), 'rapid_gpu_venv'));
  return existsSync(p) ? p : null;
}

/** PaddleX 模型缓存目录（环境变量覆盖 > $HOME/.paddlex-cache） */
export function paddleCacheHome() {
  return process.env.DSH_PADDLE_CACHE ?? join(homedir(), '.paddlex-cache');
}

/** 引擎可用性缓存（进程级，避免每次调用重复 spawn 探测；60s 过期重探） */
const availableCache = new Map();
const AVAILABLE_TTL_MS = 60_000;

/** v0.4.0：GPU 运行时失败标记——一旦 GPU 池请求报错即置位，auto/gpu 探测随后跳过 GPU，
 *  避免每张图都重试失败的 GPU，与 worker 内 _gpu_ok=False 互补（Node 侧进程级记忆）。 */
let gpuRuntimeFailed = false;
export function gpuRuntimeFailedFlag() { return gpuRuntimeFailed; }
export function setGpuRuntimeFailed(v = true) { gpuRuntimeFailed = v; }

/** 测试可注入的引擎可用性探测覆盖（默认 null=用真实 engineAvailable；测试可 mock 探测/venv 存在性）。 */
let _engineAvailableOverride = null;
export function _setEngineAvailableOverride(fn) { _engineAvailableOverride = typeof fn === 'function' ? fn : null; }

/**
 * OCR 池单请求超时（毫秒）。
 * v0.4.1：由设置项 ocr_pool_timeout_ms → 环境变量 DSH_OCR_POOL_TIMEOUT 配置，默认 120s；
 * 兼容 v0.4.0 的旧变量 DSH_OCR_GPU_POOL_TIMEOUT（作为回退，避免老配置失效）。
 * 说明：该值同时作为「非池单进程兜底」与 pipeline 传给 ocrFn 的超时默认来源，
 * 以支持较差机型在设置页/安装脚本放宽超时，避免 OCR 池偶发超时判死。
 */
export function ocrPoolTimeoutMs() {
  const raw = Number(process.env.DSH_OCR_POOL_TIMEOUT);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const legacy = Number(process.env.DSH_OCR_GPU_POOL_TIMEOUT);
  if (Number.isFinite(legacy) && legacy > 0) return legacy;
  return 120_000;
}

/** v0.4.0 旧内部名：沿用同一逻辑（别名保留，避免改动调用处；v0.4.1 已并入统一设置项）。 */
function gpuPoolTimeoutMs() { return ocrPoolTimeoutMs(); }

/**
 * v0.4.0：纯函数——按 DSH_OCR_GPU_PROVIDER 与 onnxruntime 实际可用 provider 列表解析最终 EP。
 * 与 src/ocr-worker.py 的 _resolve_gpu_provider 采用同一套决策表（Node 侧测试镜像）。
 *   取值：cuda/dml/openvino/off/auto；auto=优先 cuda→dml→openvino→cpu；
 *   显式 EP 不在 available 中则回退 cpu；off=强制 cpu。
 * @param {string} [envProvider] - DSH_OCR_GPU_PROVIDER 值
 * @param {string[]} [availableProviders] - onnxruntime get_available_providers()
 * @returns {'cuda'|'dml'|'openvino'|'cpu'}
 */
export function resolveGpuProvider(envProvider, availableProviders) {
  const raw = String(envProvider ?? 'auto').trim().toLowerCase();
  const avail = new Set(availableProviders ?? []);
  const map = { cuda: 'CUDAExecutionProvider', dml: 'DmlExecutionProvider', openvino: 'OpenVINOExecutionProvider' };
  if (raw === 'off') return 'cpu';
  if (raw in map) return avail.has(map[raw]) ? raw : 'cpu';
  if (avail.has('CUDAExecutionProvider')) return 'cuda';
  if (avail.has('DmlExecutionProvider')) return 'dml';
  if (avail.has('OpenVINOExecutionProvider')) return 'openvino';
  return 'cpu';
}

/** 探测某引擎环境是否可用（Paddle 会额外等待模型 import ~2s；结果缓存 60s）。
 *  附带检查：常驻池的 python worker 脚本存在（"无 Python"形态的包剔除了 ocr-worker.py，
 *  此时 paddle/rapid 视为不可用 → 自动降级 Windows OCR）。 */
export async function engineAvailable(engine) {
  // Windows OCR（WinRT）仅在 Windows 平台可用；非 Windows 必须依赖 paddle/rapid
  if (engine === 'windows') return process.platform === 'win32';
  const cached = availableCache.get(engine);
  if (cached && Date.now() - cached.at < AVAILABLE_TTL_MS) return cached.ok;
  // v0.4.0：gpu 引擎挂到独立 GPU venv（gpuPython）；其余同现逻辑
  const python = engine === 'paddle' ? paddlePython() : (engine === 'gpu' ? gpuPython() : rapidPython());
  if (!python || !existsSync(python)) { availableCache.set(engine, { at: Date.now(), ok: false }); return false; }
  // 池模式要求 python worker 脚本存在（无 Python 形态：缺失 → 引擎判定不可用）
  if (!existsSync(join(__dirnameLocal, 'ocr-worker.py'))) { availableCache.set(engine, { at: Date.now(), ok: false }); return false; }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      availableCache.set(engine, { at: Date.now(), ok });
      resolve(ok);
    };
    try {
      const child = spawn(python, ['-c', engine === 'paddle' ? 'import paddleocr' : 'import rapidocr_onnxruntime'], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: 'ignore'
      });
      timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, 30_000);
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
    } catch {
      done(false);
    }
  });
}

/**
 * 按序解析可用引擎。
 * 性能优化：默认 **rapid 优先**（实测 rapid 热 0.21s/张 vs paddle 热 5.7s/张，快约 27 倍；
 * 且 paddle 的 PP-OCRv6_medium_rec 在 CPU+PIR 下重模型慢）。
 * 可用 DSH_OCR_ENGINE=paddle 显式切回 paddle 优先（兼容原行为）。
 * 外部指定 preferred 时尊重指定顺序（fallback 链不变）。
 */
export async function resolveEngine(preferred) {
  const raw = String(process.env.DSH_OCR_ENGINE ?? '').trim();
  // 引擎可用性探测（测试可经 _setEngineAvailableOverride mock 探测/venv 存在性）
  const probe = (eng) => (_engineAvailableOverride ? _engineAvailableOverride(eng) : engineAvailable(eng));
  // v0.4.0：gpu / auto 引擎先探测 GPU（沿用 60s 探测缓存）。
  //   默认（DSH_OCR_ENGINE 未设置/空）不探测 GPU，保持现状 → 向后兼容。
  if (raw === 'gpu' || raw === 'auto') {
    const gpuOk = !gpuRuntimeFailed && (await probe('gpu'));
    if (gpuOk) return 'gpu';
    if (raw === 'gpu') {
      // gpu 强制但 venv 缺失/上次失败 → 回退 rapid(CPU)
      if (await probe('rapid')) return 'rapid';
      return 'windows';
    }
    // auto：探测失败 → 落到下方默认顺序（rapid 优先，兼容现状）
  }
  const first = raw === 'paddle' || raw === 'rapid' ? raw : (preferred ?? 'rapid');
  const order = first === 'paddle' ? ['paddle', 'rapid', 'windows'] : ['rapid', 'paddle', 'windows'];
  for (const eng of order) {
    if (await probe(eng)) return eng;
  }
  return 'windows'; // 兜底
}

/* ------------------------------------------------------------------ */
/* 各引擎执行                                                           */
/* ------------------------------------------------------------------ */

/**
 * Windows 中文字体 OCR（WinRT Windows.Media.Ocr），零依赖。
 * 命令编写参考自开源项目 picturereader（MIT）的 buildOcrCommand；输出 base64 JSON（含像素框）。
 */
function runWindowsOcr(pngPath, timeoutMs = 30_000) {
  const esc = (s) => String(s).replaceAll("'", "''");
  const command = [
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    '$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]',
    '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
    '$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'Function Await($WinRtTask, $ResultType) { $asTask = $asTaskGeneric.MakeGenericMethod($ResultType); $netTask = $asTask.Invoke($null, @($WinRtTask)); $netTask.Wait(-1) | Out-Null; $netTask.Result }',
    `$path = '${esc(pngPath)}'`,
    '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])',
    '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
    '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
    '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
    '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
    "if ($engine -eq $null) { Write-Error 'no OCR engine for the requested language'; exit 2 }",
    '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
    '$lines = @()',
    'foreach ($line in $result.Lines) {',
    '  $words = @()',
    '  foreach ($w in $line.Words) { $words += [PSCustomObject]@{ Text = $w.Text; X = [int]$w.BoundingRect.X; Y = [int]$w.BoundingRect.Y; W = [int]$w.BoundingRect.Width; H = [int]$w.BoundingRect.Height } }',
    '  $lines += [PSCustomObject]@{ Text = $line.Text; X = [int]$line.BoundingRect.X; Y = [int]$line.BoundingRect.Y; W = [int]$line.BoundingRect.Width; H = [int]$line.BoundingRect.Height; Words = $words }',
    '}',
    '$json = [PSCustomObject]@{ Width = $decoder.PixelWidth; Height = $decoder.PixelHeight; Lines = $lines } | ConvertTo-Json -Depth 5',
    '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))'
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: Windows OCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start Windows OCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ocr-local: Windows OCR failed (exit ${code}): ${stderr.trim().slice(0, 300)}`)); return; }
      try {
        const parsed = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
        const lines = (parsed.Lines ?? []).map((l) => ({
          text: l.Text,
          x: Math.round(l.X),
          y: Math.round(l.Y),
          width: Math.round(l.W),
          height: Math.round(l.H)
        }));
        resolve({ width: parsed.Width, height: parsed.Height, lines });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse Windows OCR result: ${e.message}`));
      }
    });
  });
}

/**
 * PaddleOCR（paddle_venv，PaddleX 接口）。模型加载约 2s。
 * 脚本编写参考自开源项目 picturereader（MIT）的 runPaddleOcr；输出 base64 JSON（含像素框与置信度）。
 */
function runPaddleOcr(pngPath, timeoutMs = 120_000) {
  const escaped = String(pngPath).replaceAll("'", "''");
  const script = [
    'import base64, json',
    'from paddleocr import PaddleOCR',
    "ocr = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, enable_mkldnn=False)",
    `result = ocr.predict(r'${escaped}')`,
    'lines = []',
    'for res in result:',
    "    texts = res.get('rec_texts') or []",
    "    scores = res.get('rec_scores') or []",
    "    polys = res.get('rec_polys') or []",
    '    for i, t in enumerate(texts):',
    '        if i < len(polys):',
    '            pts = [[int(float(v)) for v in pt] for pt in polys[i]]',
    '            xs = [pt[0] for pt in pts]; ys = [pt[1] for pt in pts]',
    '            box = {"x": min(xs), "y": min(ys), "w": max(xs)-min(xs), "h": max(ys)-min(ys)}',
    '        else:',
    '            box = {"x": 0, "y": 0, "w": 0, "h": 0}',
    "        score = round(float(scores[i]), 3) if i < len(scores) else 0.0",
    "        lines.append({'text': t, 'score': score, **box})",
    "sys.stdout.write(base64.b64encode(json.dumps({'lines': lines}, ensure_ascii=False).encode('utf-8')).decode('ascii'))",
    'import sys'
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(paddlePython(), ['-c', script], {
      env: { ...process.env, PADDLE_PDX_CACHE_HOME: paddleCacheHome(), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: PaddleOCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start PaddleOCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => /error|traceback/i.test(l)).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`ocr-local: PaddleOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
        resolve({ lines: (parsed.lines ?? []).map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.w, height: l.h, score: l.score })) });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse PaddleOCR result: ${e.message}`));
      }
    });
  });
}

/**
 * RapidOCR（rapid_venv，bundled ONNX 模型，无需网络下载）。
 * 脚本编写参考自开源项目 picturereader（MIT）的 runRapidOcr：进程参数传 PNG 路径，stdout JSON。
 */
function runRapidOcr(pngPath, timeoutMs = 90_000, python = rapidPython()) {
  const script = [
    'import json, sys',
    'from rapidocr_onnxruntime import RapidOCR',
    '_engine = RapidOCR()',
    '_result, _elapse = _engine(sys.argv[1])',
    '_out = []',
    'for _it in (_result or []):',
    '    _pts = [[float(c) for c in _p] for _p in _it[0]]',
    '    _xs = [_p[0] for _p in _pts]; _ys = [_p[1] for _p in _pts]',
    "    _out.append({'text': _it[1], 'score': float(_it[2]), 'x': int(min(_xs)), 'y': int(min(_ys)), 'width': int(max(_xs)-min(_xs)), 'height': int(max(_ys)-min(_ys))})",
    "print(json.dumps({'lines': _out}, ensure_ascii=False), flush=True)"
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', script, String(pngPath)], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ocr-local: RapidOCR timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`ocr-local: cannot start RapidOCR: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => /error|traceback/i.test(l)).slice(-3).join(' | ') || stderr.trim().slice(-200);
        reject(new Error(`ocr-local: RapidOCR failed (exit ${code}): ${tail}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ lines: (parsed.lines ?? []).map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.width, height: l.height, score: l.score })) });
      } catch (e) {
        reject(new Error(`ocr-local: cannot parse RapidOCR result: ${e.message}`));
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * 对一块 PNG 执行 OCR。
 * 流程：临时 PNG 落盘 → 目标引擎（自动降级）→ 解析文本行 → 清理临时文件。
 * @param {Buffer} pngBuffer - 待识别区域的 PNG 字节
 * @param {object} opts - {engine('paddle'|'rapid'|'windows'|'auto'), timeoutMs}
 * @returns {Promise<{engine:string, text:string, lines:Array}>}
 */
export async function ocrText(pngBuffer, { engine = 'auto', timeoutMs, preprocess = 'auto' } = {}) {
  // —— 本地 OCR 结果缓存：同图重复识别直接命中（默认 48h；DSH_OCR_CACHE=0 禁用）——
  const cacheKey = ocrCacheKey(pngBuffer);
  const cached = await ocrCacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  // —— v0.2.0 前处理：深底白字/低对比自动反色二值化、手写/小字放大（DSH_OCR_PREPROC=0 关闭）
  //    preprocess='auto-enlarge-off'（分流：非手写区）→ 只增强不放大（省 60% 耗时）
  let preApplied = [];
  let isDark = false;
  let workBuffer = pngBuffer;
  if (preprocess !== 'off' && String(process.env.DSH_OCR_PREPROC ?? '1') !== '0') {
    try {
      const enlarge = preprocess === 'auto-enlarge-off' ? 'off' : 'auto';
      const proc = await autoPreprocess(pngBuffer, { enlarge });
      workBuffer = proc.buffer;
      preApplied = proc.applied ?? [];
      isDark = Boolean(proc.isDark);
      if (preApplied.length > 0) {
        // 只有真实发生处理时才替换工作字节（applied=[] 时保持原 buffer，避免无谓重编码）
        workBuffer = proc.buffer;
      }
    } catch {
      /* 前处理失败 → 原图继续 */
    }
  }

  // 默认走 resolveEngine()（rapid 优先，见 resolveEngine 注释）；显式指定则尊重
  const engineUsed = engine === 'auto' ? await resolveEngine() : engine;
  const tmpPath = join(tmpdir(), `vision-tile-ocr-${randomBytes(6).toString('hex')}.png`);
  await writeFile(tmpPath, workBuffer);
  try {
    let result;
    // —— 性能优化：paddle/rapid/windows 均优先走常驻进程池（引擎常驻；多核并行）——
    const pool = ocrPool(engineUsed);
    if (pool) {
      try {
        const resp = await pool.execute({ engine: engineUsed, path: tmpPath });
        const lines = (resp.lines ?? []).map((l) => ({
          text: l.text, x: l.x, y: l.y, width: l.width, height: l.height, score: l.score
        }));
        const entry = {
          engine: engineUsed, text: lines.map((l) => l.text).join('\n'), lines, pooled: true,
          preprocess: preApplied, isDark,
          provider: resp.provider, gpu_device: resp.gpu_device
        };
        await ocrCacheSet(cacheKey, entry);
        return entry;
      } catch (poolErr) {
        // 池失败（worker 超时/崩溃）→ 回退旧实现（每张一进程），绝不因池而丢失识别
        if (engineUsed === 'gpu') setGpuRuntimeFailed(); // GPU 池失败 → 标记，后续不再尝试 GPU
        if (engineUsed === 'paddle') result = await runPaddleOcr(tmpPath, timeoutMs);
        else if (engineUsed === 'rapid' || engineUsed === 'gpu') result = await runRapidOcr(tmpPath, timeoutMs, ((engineUsed === 'gpu' ? gpuPython() : rapidPython()) ?? rapidPython()));
        else result = await runWindowsOcr(tmpPath, timeoutMs);
        const lines = result.lines ?? [];
        const entry = {
          engine: engineUsed, text: lines.map((l) => l.text).join('\n'), lines, pooled: false,
          note: String(poolErr.message || poolErr).slice(0, 200),
          preprocess: preApplied, isDark
        };
        await ocrCacheSet(cacheKey, entry);
        return entry;
      }
    }
    // —— 旧路径/Windows 引擎 ——
    if (engineUsed === 'paddle') result = await runPaddleOcr(tmpPath, timeoutMs);
    else if (engineUsed === 'rapid' || engineUsed === 'gpu') result = await runRapidOcr(tmpPath, timeoutMs, ((engineUsed === 'gpu' ? gpuPython() : rapidPython()) ?? rapidPython()));
    else result = await runWindowsOcr(tmpPath, timeoutMs);
    // 统一输出：[按行拼接文本 + 行像素框]
    const lines = result.lines ?? [];
    const entry = {
      engine: engineUsed,
      text: lines.map((l) => l.text).join('\n'),
      lines,
      preprocess: preApplied,
      isDark
    };
    await ocrCacheSet(cacheKey, entry);
    return entry;
  } catch (error) {
    // 目标引擎失败 → windows 兜底（若目标已失败且不是 windows）
    if (engineUsed !== 'windows') {
      try {
        const fallback = await runWindowsOcr(tmpPath, 30_000);
        return { engine: 'windows', text: fallback.lines.map((l) => l.text).join('\n'), lines: fallback.lines, degraded: true, reason: error.message };
      } catch {
        throw error;
      }
    }
    // Windows OCR 引擎缺失（例如系统仅安装英文 OCR 语言包）→ 给出友好指引
    if (engineUsed === 'windows' && /no OCR engine for the requested language/i.test(String(error.message))) {
      throw new Error('ocr-local: Windows OCR 未找到中文 OCR 引擎——请在「设置→语言→Windows 更新/可选功能→语言→OCR」安装 中文(简体) 语言包（本机已安装，重登录后生效）；或设置 DSH_OCR_ENGINE=rapid 使用 venv 引擎');
    }
    throw error;
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}
