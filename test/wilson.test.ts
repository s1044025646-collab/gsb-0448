import { test } from "node:test";
import * as assert from "node:assert/strict";
import { wilsonInterval, wilsonTerms, Z_TABLE, MAX_BATCH_N } from "../src/wilson";
import { parseConfidence, validateBatchInput, AppError } from "../src/validation";

const TOL = 1e-6;

// 独立硬编码固定基准（不使用本项目函数推导预期值）。
test("95% 固定基准：0/10、10/10、5/10", () => {
  let [l, u] = wilsonInterval(0, 10, 0.95);
  assert.ok(Math.abs(l! - 0) < TOL, `0/10 lower=${l}`);
  assert.ok(Math.abs(u! - 0.2775328) < TOL, `0/10 upper=${u}`);

  [l, u] = wilsonInterval(10, 10, 0.95);
  assert.ok(Math.abs(l! - 0.7224672) < TOL, `10/10 lower=${l}`);
  assert.ok(Math.abs(u! - 1) < TOL, `10/10 upper=${u}`);

  [l, u] = wilsonInterval(5, 10, 0.95);
  assert.ok(Math.abs(l! - 0.2365931) < TOL, `5/10 lower=${l}`);
  assert.ok(Math.abs(u! - 0.7634069) < TOL, `5/10 upper=${u}`);
});

test("1/10 与 9/90 合并为 10/100，且不等于平均区间", () => {
  const a = wilsonTerms(1, 10, 0.95);
  const b = wilsonTerms(9, 90, 0.95);
  const m = wilsonTerms(10, 100, 0.95);
  const avgLower = (a.lower! + b.lower!) / 2;
  const avgUpper = (a.upper! + b.upper!) / 2;
  assert.ok(Math.abs(m.lower! - avgLower) > 1e-9 || Math.abs(m.upper! - avgUpper) > 1e-9);
  assert.ok(Math.abs(m.p! - 0.1) < 1e-15);
});

test("n=0 返回 null 与 no_data 状态", () => {
  const t = wilsonTerms(0, 0, 0.95);
  assert.equal(t.status, "no_data");
  assert.equal(t.p, null);
  assert.equal(t.lower, null);
  assert.equal(t.upper, null);
  const [l, u] = wilsonInterval(0, 0, 0.99);
  assert.equal(l, null);
  assert.equal(u, null);
});

test("三种置信度使用公开 z 常数", () => {
  assert.equal(Z_TABLE[0.9], 1.6448536269514722);
  assert.equal(Z_TABLE[0.95], 1.959963984540054);
  assert.equal(Z_TABLE[0.99], 2.5758293035489004);
});

test("成功失败互换：区间为 [1-U, 1-L]", () => {
  for (const n of [1, 2, 3, 7, 10, 100]) {
    for (const conf of [0.9, 0.95, 0.99] as const) {
      for (let k = 0; k <= n; k++) {
        const t = wilsonTerms(k, n, conf);
        const s = wilsonTerms(n - k, n, conf);
        assert.ok(Math.abs(s.lower! - (1 - t.upper!)) < 1e-12);
        assert.ok(Math.abs(s.upper! - (1 - t.lower!)) < 1e-12);
      }
    }
  }
});

test("提高置信度区间不收窄，且比例落在区间内", () => {
  for (let n = 1; n <= 40; n++) {
    for (let k = 0; k <= n; k++) {
      const t90 = wilsonTerms(k, n, 0.9);
      const t95 = wilsonTerms(k, n, 0.95);
      const t99 = wilsonTerms(k, n, 0.99);
      assert.ok(t95.lower! <= t90.lower! + 1e-12);
      assert.ok(t95.upper! >= t90.upper! - 1e-12);
      assert.ok(t99.lower! <= t95.lower! + 1e-12);
      assert.ok(t99.upper! >= t95.upper! - 1e-12);
      for (const t of [t90, t95, t99]) {
        assert.ok(t.lower! <= t.p! + 1e-12 && t.p! <= t.upper! + 1e-12);
        assert.ok(t.lower! >= -1e-12 && t.upper! <= 1 + 1e-12);
      }
    }
  }
});

test("小范围枚举全部有限且边界合法", () => {
  for (let n = 1; n <= 60; n++) {
    for (let k = 0; k <= n; k++) {
      const t = wilsonTerms(k, n, 0.95);
      for (const v of [t.lower, t.upper, t.center, t.halfWidth, t.d]) {
        assert.ok(Number.isFinite(v!), `非有限值 n=${n} k=${k}`);
      }
      assert.ok(t.lower! >= 0 - 1e-12 && t.lower! <= 1 + 1e-12);
      assert.ok(t.upper! >= 0 - 1e-12 && t.upper! <= 1 + 1e-12);
      assert.ok(t.lower! <= t.upper!);
    }
  }
});

test("大样本上限常量", () => {
  assert.equal(MAX_BATCH_N, 10_000_000);
});

test("校验：负数、小数、数字字符串、k>n 一律拒绝", () => {
  assert.throws(() => validateBatchInput({ ref: "x", k: -1, n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: 1.5, n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: "1", n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: "10", n: "10" }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: 11, n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: true, n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "", k: 1, n: 10 }), AppError);
  assert.throws(() => validateBatchInput({ ref: "x", k: NaN, n: 10 }), AppError);
  const ok = validateBatchInput({ ref: " b1 ", k: 0, n: 0 });
  assert.deepEqual(ok, { ref: "b1", k: 0, n: 0 });
});

test("置信度解析仅接受三种", () => {
  assert.equal(parseConfidence(0.9), 0.9);
  assert.equal(parseConfidence("0.95"), 0.95);
  assert.throws(() => parseConfidence(0.8), AppError);
  assert.throws(() => parseConfidence("95%"), AppError);
});
