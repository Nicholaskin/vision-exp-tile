// tests/concurrency.test.js — v1.0.0 公共并发调度与算力预算
// 覆盖：mapLimit 并发上限/保序/边界、错误策略、runConcurrent 兼容导出、
//       tierOf 档位推断、resolveBudget 显式优先与上限保护。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapLimit, runConcurrent, cpuCount, tierOf, resolveBudget,
  setApiGate, apiGateStats, acquireApiSlot, releaseApiSlot
} from '../src/concurrency.js';

/** 造一个「可控释放」的异步任务：返回 {promise, release}，用于精确测并发窗口 */
function deferred() {
  let release;
  const promise = new Promise((res) => { release = res; });
  return { promise, release };
}

test('cpuCount：返回 ≥1 的整数', () => {
  const n = cpuCount();
  assert.ok(Number.isInteger(n) && n >= 1, `实际 ${n}`);
});

test('mapLimit：空数组直接返回空数组', async () => {
  const out = await mapLimit([], 3, async () => 1);
  assert.deepEqual(out, []);
});

test('mapLimit：并发不超过 limit，且结果严格保序', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  let running = 0;
  let peak = 0;
  const out = await mapLimit(items, 3, async (v) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return v * 10;
  });
  assert.ok(peak <= 3, `峰值并发 ${peak} 应 ≤3`);
  assert.ok(peak >= 2, `峰值并发 ${peak} 说明没真并发`);
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70], '结果下标必须与输入一致');
});

test('mapLimit：limit 非法（0/负/NaN）时退化为串行 1', async () => {
  for (const bad of [0, -3, NaN, undefined, 'x']) {
    let running = 0;
    let peak = 0;
    await mapLimit([1, 2, 3], bad, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
    });
    assert.equal(peak, 1, `limit=${String(bad)} 时应串行`);
  }
});

test('mapLimit：limit 大于任务数时不超过任务数', async () => {
  let peak = 0;
  let running = 0;
  await mapLimit([1, 2], 100, async () => {
    running += 1;
    peak = Math.max(peak, running);
    const d = deferred();
    setTimeout(() => { running -= 1; d.release(); }, 3);
    await d.promise;
  });
  assert.equal(peak, 2);
});

test('mapLimit：滑动窗口——完成一个立即补位（不是分批等待）', async () => {
  const order = [];
  // 第 1 个任务最快完成；若实现是「分批等全部完成」，第 4 个任务必须等前 3 个都结束
  await mapLimit([0, 1, 2, 3], 2, async (v) => {
    order.push(`start${v}`);
    await new Promise((r) => setTimeout(r, v === 0 ? 1 : 20));
    order.push(`end${v}`);
    return v;
  });
  assert.ok(order.indexOf('start3') < order.indexOf('end2'), `应为滑动窗口，实际顺序 ${order.join(',')}`);
});

test('mapLimit：默认 onError=throw 时错误向上抛', async () => {
  await assert.rejects(
    () => mapLimit([1, 2, 3], 2, async (v) => {
      if (v === 2) throw new Error('boom');
      return v;
    }),
    /boom/
  );
});

test('mapLimit：onError=collect 时错误进结果数组，其余项照常完成', async () => {
  const out = await mapLimit([1, 2, 3], 2, async (v) => {
    if (v === 2) throw new Error('boom');
    return v * 2;
  }, { onError: 'collect' });
  assert.equal(out.length, 3);
  assert.equal(out[0], 2);
  assert.equal(out[1] instanceof Error, true, '失败项应为 Error 实例');
  assert.match(out[1].message, /boom/, '失败项应携带原始错误信息（批量场景需回报给用户）');
  assert.equal(out[2], 6);
});

test('mapLimit：非 Error 抛出物在 collect 模式下被包成 Error', async () => {
  const out = await mapLimit([1], 1, async () => { throw 'plain-string'; }, { onError: 'collect' });
  assert.equal(out[0] instanceof Error, true);
  assert.match(out[0].message, /plain-string/);
});

test('runConcurrent：兼容旧导出，语义与 mapLimit 一致', async () => {
  const out = await runConcurrent([3, 1, 2], 2, async (v, i) => `${i}:${v}`);
  assert.deepEqual(out, ['0:3', '1:1', '2:2']);
});

test('tierOf：按逻辑核数分档（12/4 为界）', () => {
  assert.equal(tierOf(16), 'fast');
  assert.equal(tierOf(12), 'fast');
  assert.equal(tierOf(11), 'normal');
  assert.equal(tierOf(4), 'normal');
  assert.equal(tierOf(2), 'slow');
  assert.equal(tierOf(0), 'normal', '非法核数按保守 4 核处理');
});

test('resolveBudget：无显式配置时按档位基线，且带上限保护', () => {
  const fast = resolveBudget({ performanceTier: 'fast', cores: 16 });
  assert.deepEqual([fast.api, fast.image, fast.ocr], [3, 2, 4]);
  assert.equal(fast.source, 'tier');
  const slow = resolveBudget({ performanceTier: 'slow', cores: 2 });
  assert.deepEqual([slow.api, slow.image, slow.ocr], [1, 1, 1]);
});

test('resolveBudget：auto 档按核数推断', () => {
  assert.equal(resolveBudget({ performanceTier: 'auto', cores: 16 }).tier, 'fast');
  assert.equal(resolveBudget({ performanceTier: 'auto', cores: 8 }).tier, 'normal');
  assert.equal(resolveBudget({ performanceTier: 'auto', cores: 2 }).tier, 'slow');
});

test('resolveBudget：显式值优先于档位基线', () => {
  const b = resolveBudget({ performanceTier: 'slow', cores: 2, apiConcurrency: 4, imageConcurrency: 3, ocrPool: 6 });
  assert.deepEqual([b.api, b.image, b.ocr], [4, 3, 6]);
  assert.equal(b.source, 'explicit');
});

test('resolveBudget：显式值也受上限保护（防呆配置打爆）', () => {
  const b = resolveBudget({ performanceTier: 'fast', cores: 16, apiConcurrency: 99, imageConcurrency: 99, ocrPool: 99 });
  assert.deepEqual([b.api, b.image, b.ocr], [4, 4, 8]);
});

test('resolveBudget：部分显式时为 mixed，未给项回落档位基线', () => {
  const b = resolveBudget({ performanceTier: 'fast', cores: 16, apiConcurrency: 1 });
  assert.equal(b.api, 1);
  assert.equal(b.image, 2, '未给项应回落 fast 基线');
  assert.equal(b.source, 'mixed');
});

/* ------------------------------------------------------------------ */
/* 全局 API 闸门（v1.0.0：防「图级并发 × 图内并发」叠乘打爆端点）        */
/* ------------------------------------------------------------------ */

test('闸门：limit=2 时同时在飞不超过 2，且 FIFO 补位', async () => {
  setApiGate(2);
  let active = 0;
  let peak = 0;
  const order = [];
  await Promise.all([1, 2, 3, 4, 5].map(async (i) => {
    await acquireApiSlot();
    active += 1;
    peak = Math.max(peak, active);
    order.push(`in${i}`);
    await new Promise((r) => setTimeout(r, i === 1 ? 1 : 10));
    order.push(`out${i}`);
    active -= 1;
    releaseApiSlot();
  }));
  assert.equal(peak, 2, `峰值并发应为 2，实际 ${peak}`);
  assert.deepEqual(order.slice(0, 4), ['in1', 'in2', 'out1', 'in3'], '应为 FIFO 补位');
  assert.deepEqual(apiGateStats(), { limit: 2, active: 0, waiting: 0 }, '结束后额度必须全部归还');
});

test('闸门：limit=0 表示不限制（等价旧行为）', async () => {
  setApiGate(0);
  let peak = 0;
  let active = 0;
  await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async () => {
    await acquireApiSlot();
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    releaseApiSlot();
  }));
  assert.equal(peak, 8, '不限制时应全部并发');
  setApiGate(6); // 还原默认
});

test('闸门：异常路径也必须归还额度（否则后续请求永久排队）', async () => {
  setApiGate(1);
  await assert.rejects(async () => {
    await acquireApiSlot();
    try {
      throw new Error('boom');
    } finally {
      releaseApiSlot();
    }
  }, /boom/);
  // 额度已归还 → 下一次申请能立刻拿到（若泄漏，这里会永久挂起，测试超时失败）
  await acquireApiSlot();
  releaseApiSlot();
  assert.equal(apiGateStats().active, 0);
  setApiGate(6);
});
