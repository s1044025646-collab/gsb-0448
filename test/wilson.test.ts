import test from "node:test";
import assert from "node:assert/strict";
import { wilsonInterval, validateCounts, ValidationError, CONFIDENCES } from "../src/wilson";

const TOL = 1e-7;

// 独立固定基准（不依赖本项目核心函数生成的预期值）
test("固定基准: 0/10、10/10、5/10 在 95% 下的区间", () => {
  const zero = wilsonInterval(0, 10, 95);
  assert.ok(Math.abs(zero.lower! - 0) < TOL);
  assert.ok(Math.abs(zero.upper! - 0.2775328) < TOL);
  const full = wilsonInterval(10, 10, 95);
  assert.ok(Math.abs(full.lower! - (1 - 0.2775328)) < TOL);
  assert.ok(Math.abs(full.upper! - 1) < TOL);
  const half = wilsonInterval(5, 10, 95);
  assert.ok(Math.abs(half.lower! - 0.2365931) < TOL);
  assert.ok(Math.abs(half.upper! - 0.7634069) < TOL);
});

test("n=0 返回 no_data，比例与区间均为 null", () => {
  const r = wilsonInterval(0, 0, 95);
  assert.equal(r.status, "no_data");
  assert.equal(r.proportion, null);
  assert.equal(r.lower, null);
  assert.equal(r.upper, null);
});

test("三种置信度：置信度越高区间越宽（不收窄）", () => {
  const widths = CONFIDENCES.map((c) => {
    const r = wilsonInterval(5, 10, c);
    return r.upper! - r.lower!;
  });
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2]);
});

test("成功/失败互换后区间为 [1-U, 1-L]", () => {
  for (const c of CONFIDENCES) {
    const a = wilsonInterval(3, 10, c);
    const b = wilsonInterval(7, 10, c);
    assert.ok(Math.abs(a.lower! - (1 - b.upper!)) < 1e-12);
    assert.ok(Math.abs(a.upper! - (1 - b.lower!)) < 1e-12);
  }
});

test("比例落在区间内，且边界在 [0,1]，全部有限", () => {
  for (const c of CONFIDENCES) {
    for (let n = 1; n <= 60; n++) {
      for (let k = 0; k <= n; k++) {
        const r = wilsonInterval(k, n, c);
        for (const v of [r.proportion, r.lower, r.upper, r.center, r.halfWidth]) {
          assert.ok(Number.isFinite(v), `k=${k} n=${n} c=${c} 出现非有限值`);
        }
        assert.ok(r.lower! >= 0 && r.upper! <= 1, `k=${k} n=${n} 越界`);
        assert.ok(r.lower! <= r.proportion! && r.proportion! <= r.upper!, `k=${k} n=${n} 比例不在区间内`);
      }
    }
  }
});

test("非法输入：负数、小数、字符串、k>n、n 超限、非法置信度", () => {
  assert.throws(() => validateCounts(-1, 10), (e) => e instanceof ValidationError && e.code === "NEGATIVE_COUNT");
  assert.throws(() => validateCounts(1.5, 10), (e) => (e as ValidationError).code === "INVALID_INTEGER");
  assert.throws(() => validateCounts("1", 10), (e) => (e as ValidationError).code === "INVALID_INTEGER");
  assert.throws(() => validateCounts(11, 10), (e) => (e as ValidationError).code === "K_GT_N");
  assert.throws(() => validateCounts(0, 10_000_001), (e) => (e as ValidationError).code === "N_TOO_LARGE");
  assert.throws(() => wilsonInterval(1, 10, 80), (e) => (e as ValidationError).code === "INVALID_CONFIDENCE");
});

test("中间量与公式一致", () => {
  const r = wilsonInterval(1, 10, 95);
  const z = 1.959963984540054;
  assert.equal(r.z, z);
  assert.ok(Math.abs(r.denominator! - (1 + (z * z) / 10)) < 1e-15);
  assert.ok(Math.abs(r.center! - (0.1 + (z * z) / 20) / r.denominator!) < 1e-15);
});
