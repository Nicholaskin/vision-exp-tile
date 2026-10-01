/**
 * ocr-pool.js — 本地 OCR 常驻进程池（节点侧，配合 src/ocr-worker.py）
 *
 * 为什么需要进程池（针对"大规模识别特别卡"）：
 *   旧实现（ocr-local.js）对每张图都 spawn 一个全新 Python 进程，
 *   每次付出"进程启动 + 模型加载"成本：Paddle ≈2.25s 初始化 + 22.9s 大图推理；
 *   Rapid ≈0.55s 加载。几十页材料 = 几十次重复加载，CPU 与时间全线浪费。
 *
 * 本模块：
 *   - 维护 N 个常驻 Python 子进程（N = DSH_OCR_POOL，默认 min(4, 物理核数)）；
 *   - 请求协议：stdin 写入 {"id","engine","path"} 一行；stdout 逐行返回 JSON（id 配对）；
 *   - 忙闲调度：空闲 worker 分配请求；超时判死并重启；崩溃自动重建；
 *   - 惰性启动：首次请求才拉起 worker（不打扰空闲实例）；池全忙时按队列等待（有上限）；
 *   - 完全可控：DSH_OCR_POOL=0 或初始化失败时上层回退旧逻辑（无池）。
 *
 * 仅使用 Node 内置模块（node:child_process / node:readline / node:os），
 * 不引入任何第三方依赖，与"纯官方 DSH 能力"约束一致。
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, 'ocr-worker.py');

/** 读环境变量池大小（默认 4 = 常驻 4 路并行；0 = 显式禁用回退旧逻辑；1-8 合法） */
export function poolSizeFromEnv(env = process.env) {
  const raw = env.DSH_OCR_POOL;
  if (raw === undefined || raw === '') return 4; // 默认开启
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 4;
  if (n === 0) return 0; // 显式禁用
  return Math.min(8, Math.max(1, Math.floor(n)));
}

/**
 * 单个常驻工作进程封装：一行请求 → 一行结果（Promise 配对）。
 */
class WorkerSlot {
  constructor(pythonCmd, pool) {
    this.pythonCmd = pythonCmd;
    this.pool = pool;
    this.workerPath = pool.workerPath;
    this.state = 'idle'; // idle | busy | dead
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.restarts = 0;
    this._start();
  }

  _start() {
    // worker 参数模式按扩展名选择：.py → python -u；.ps1 → powershell -Command
    // （重要实测结论：WinRT 类型在 -File 模式下无法加载，-Command 模式正常）；其他 → node
    const low = this.workerPath.toLowerCase();
    let args;
    if (low.endsWith('.py')) args = ['-u', this.workerPath];
    else if (low.endsWith('.ps1')) args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', readFileSync(this.workerPath, 'utf8')];
    else args = [this.workerPath];
    this.proc = spawn(this.pythonCmd, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this._onLine(line));
    this.proc.on('error', (err) => this._onDead(`spawn error: ${err.message}`));
    this.proc.on('exit', (code) => this._onDead(`worker exit ${code}`));
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    this.state = 'idle';
    this.pool._ready(this);
    if (msg.ok) entry.resolve(msg);
    else entry.reject(new Error(`ocr-pool: ${msg.error || 'worker error'}`));
  }

  _onDead(reason) {
    if (this.state === 'dead') return;
    this.state = 'dead';
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`ocr-pool: ${reason}`));
    }
    this.pending.clear();
    // 清理子进程句柄：杀死残留进程并关闭 readline，避免管道泄漏挂住测试进程
    try { this.rl?.close(); } catch { /* 忽略 */ }
    try { this.proc?.kill(); } catch { /* 已退出 */ }
    this.pool._workerDead(this, reason);
  }

  /**
   * 提交一次识别请求。
   * @param {object} req - {engine, path}
   * @param {number} timeoutMs
   * @returns {Promise<object>} 如 {ok:true, lines, elapsed_ms}
   */
  request(req, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const payload = JSON.stringify({ id, engine: req.engine, path: req.path });
      this.state = 'busy';
      this.pool._busy(this);
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this._onDead(`timed out after ${timeoutMs}ms`);
        reject(new Error(`ocr-pool: request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload + '\n', 'utf8');
    });
  }

  /** 优雅终止（进程池关闭时调用） */
  dispose() {
    this.state = 'dead';
    try { this.proc.kill(); } catch { /* 已退出 */ }
  }
}

/**
 * 进程池主类：
 *  - 容量 = poolSize（0 = 禁用：不启动任何 worker）
 *  - 维护 idle 队列；请求进来取一个 idle worker；全忙入队（最多 min(池容量*2, 32)）
 *  - worker 崩溃/超时 → 自动重启（每个 worker 最多连续重启 3 次，防死循环）
 */
export class OcrPool {
  constructor({ size = 0, pythonCmd, workerPath, timeoutMs = 120_000 } = {}) {
    this.size = size;
    this.pythonCmd = pythonCmd;
    this.workerPath = workerPath ?? WORKER; // 测试可注入假 worker
    this.timeoutMs = timeoutMs;
    this.slots = [];
    this.idle = [];
    this.waiting = []; // 等待队列 [{req, resolve, reject}]
    this.started = false;
  }

  _busy(slot) { /* 状态由 slot.state 管理，无需额外动作 */ }

  _ready(slot) {
    // worker 空闲：优先服务等待队列
    if (this.waiting.length > 0 && slot.state === 'idle') {
      const next = this.waiting.shift();
      this._dispatch(slot, next);
    } else if (!this.idle.includes(slot)) {
      this.idle.push(slot);
    }
  }

  _workerDead(slot, reason) {
    this.idle = this.idle.filter((s) => s !== slot);
    if (slot.restarts < 3) {
      slot.restarts += 1;
      // 重建并补入池
      const fresh = new WorkerSlot(this.pythonCmd, this);
      fresh.restarts = slot.restarts;
      this.slots = this.slots.map((s) => (s === slot ? fresh : s));
      this.idle.push(fresh);
    } else {
      this.slots = this.slots.filter((s) => s !== slot);
      // 本 slot 挂了：把等待队列中后续请求转交其他 worker 或直接失败
      while (this.waiting.length > 0) {
        const next = this.waiting.shift();
        next.reject(new Error(`ocr-pool: worker unavailable: ${reason}`));
      }
    }
  }

  _dispatch(slot, entry) {
    const { req, resolve, reject } = entry;
    slot
      .request(req, this.timeoutMs)
      .then(resolve, reject);
  }

  /** 惰性启动（首次请求时） */
  _ensureStarted() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.size; i++) {
      const slot = new WorkerSlot(this.pythonCmd, this);
      this.slots.push(slot);
      this.idle.push(slot);
    }
  }

  /**
   * 对外主入口：执行一次 OCR。
   * @param {object} req - {engine: 'paddle'|'rapid', path: string}
   * @returns {Promise<{lines: Array, elapsed_ms: number}>}
   */
  async execute(req) {
    if (this.size <= 0) throw new Error('ocr-pool disabled');
    this._ensureStarted();
    // 找一个空闲 worker；直接调度（dispatch 内部会做 idle 队列归还）
    const slot = this.idle.shift();
    if (slot) {
      return new Promise((resolve, reject) => {
        this._dispatch(slot, { req, resolve, reject });
      });
    }
    if (this.waiting.length >= Math.max(16, this.size * 2)) {
      throw new Error('ocr-pool: queue overflow');
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ req, resolve, reject });
    });
  }

  /** 池尺寸信息（诊断用） */
  stats() {
    return { size: this.size, slots: this.slots.length, idle: this.idle.length, waiting: this.waiting.length };
  }

  /** 同步清场（进程 exit 兜底；不等待，直接 kill 全部 worker） */
  killAllSync() {
    for (const s of this.slots) s.dispose();
    this.slots = [];
    this.idle = [];
    this.waiting = [];
    this.started = false;
  }

  /** 关闭全部 worker（进程退出兜底；日常不调用） */
  async disposeAll() {
    for (const s of this.slots) s.dispose();
    this.slots = [];
    this.idle = [];
    this.waiting = [];
  }
}

/** 全局池注册表（按 pythonCmd 区分：paddle_venv / rapid_venv 各一个池） */
const poolRegistry = new Map();

/* 进程退出兜底：同步 kill 所有常驻 worker，避免子进程/管道泄漏导致宿主进程无法退出 */
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pool of poolRegistry.values()) pool.killAllSync();
  });
}

/**
 * 获取（或惰性创建）指定解释器的 OCR 进程池。
 * @param {string} pythonCmd - 解释器可执行路径（paddle_venv/rapid_venv 各一池；Windows OCR 用 'powershell.exe'）
 * @param {number} [factor] - 池大小覆盖（默认读 DSH_OCR_POOL；默认 4 = 开启，0 = 禁用）
 * @param {string} [workerPath] - worker 脚本路径（默认 src/ocr-worker.py；Windows OCR 用 ocr-win-worker.ps1）
 * @returns {OcrPool|null} 禁用时返回 null（上游回退旧逻辑）
 */
export function getOcrPool(pythonCmd, factor, workerPath, timeoutMs) {
  const size = factor ?? poolSizeFromEnv();
  if (size <= 0) return null;
  installExitHook();
  // 缓存键：解释器 + worker 脚本（解释器相同时不同 worker 分池）
  const key = workerPath ? `${pythonCmd}::${workerPath}` : pythonCmd;
  let pool = poolRegistry.get(key);
  if (!pool) {
    // v0.4.0：timeoutMs 第 4 参，供 GPU 池按场景放宽冷启动（默认 120s 不变）
    const opts = { size, pythonCmd, workerPath };
    if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
    pool = new OcrPool(opts);
    poolRegistry.set(key, pool);
  }
  return pool;
}

/** 单例池全局大小探针（供测试） */
export function _resetPoolForTest() {
  poolRegistry.clear();
}
