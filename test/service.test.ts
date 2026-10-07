import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db";
import { Service } from "../src/service";
import { ValidationError } from "../src/wilson";

function newService(): Service {
  return new Service(openDb(":memory:"));
}

function seed(s: Service): number {
  const ds = s.createDataset("d");
  s.addBatches(ds.id, [
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
    { batchKey: "B", metricName: "m", metricVersion: "v1", k: 9, n: 90 },
  ]);
  return ds.id;
}

test("合并按计数相加：1/10 + 9/90 = 10/100，而非平均区间", () => {
  const s = newService();
  const { report } = s.analyze(seed(s), 95);
  const m = report.metrics[0];
  assert.equal(m.totals.k, 10);
  assert.equal(m.totals.n, 100);
  assert.equal(m.totals.failures, 90);
  assert.ok(Math.abs(m.merged.proportion! - 0.1) < 1e-15);
  const avgOfBounds = (m.includedBatches[0].result.lower! + m.includedBatches[1].result.lower!) / 2;
  assert.ok(Math.abs(m.merged.lower! - avgOfBounds) > 1e-6, "合并下界不应等于两批下界平均");
});

test("输入批次顺序不影响合并数值", () => {
  const s1 = newService();
  const d1 = s1.createDataset("d");
  s1.addBatches(d1.id, [
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
    { batchKey: "B", metricName: "m", metricVersion: "v1", k: 9, n: 90 },
  ]);
  const s2 = newService();
  const d2 = s2.createDataset("d");
  s2.addBatches(d2.id, [
    { batchKey: "B", metricName: "m", metricVersion: "v1", k: 9, n: 90 },
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
  ]);
  const r1 = s1.analyze(d1.id, 95).report.metrics[0].merged;
  const r2 = s2.analyze(d2.id, 95).report.metrics[0].merged;
  assert.deepEqual(r1, r2);
});

test("零样本批次列出但不贡献分母", () => {
  const s = newService();
  const ds = s.createDataset("d");
  s.addBatches(ds.id, [
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 5, n: 10 },
    { batchKey: "E", metricName: "m", metricVersion: "v1", k: 0, n: 0 },
  ]);
  const m = s.analyze(ds.id, 95).report.metrics[0];
  assert.equal(m.totals.n, 10);
  assert.equal(m.excludedZeroBatches.length, 1);
  assert.equal(m.excludedZeroBatches[0].batchKey, "E");
});

test("同名指标不同口径版本拒绝合并", () => {
  const s = newService();
  const ds = s.createDataset("d");
  s.addBatches(ds.id, [
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
    { batchKey: "B", metricName: "m", metricVersion: "v2", k: 1, n: 10 },
  ]);
  assert.throws(() => s.analyze(ds.id, 95), (e) => (e as ValidationError).code === "METRIC_VERSION_CONFLICT");
});

test("批量失败整体回滚，不留半份数据", () => {
  const s = newService();
  const ds = s.createDataset("d");
  assert.throws(() =>
    s.addBatches(ds.id, [
      { batchKey: "ok", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
      { batchKey: "bad", metricName: "m", metricVersion: "v1", k: -1, n: 10 },
    ]),
  );
  assert.equal(s.listBatches(ds.id).length, 0);
});

test("重复 requestId 幂等返回原结果", () => {
  const s = newService();
  const a = s.createDataset("d", "req-1");
  const b = s.createDataset("d", "req-1");
  assert.equal(a.id, b.id);
  assert.equal(b.idempotent, true);
  s.addBatches(a.id, [{ batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 }], "req-b");
  const again = s.addBatches(a.id, [{ batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 }], "req-b");
  assert.equal(again.idempotent, true);
  assert.equal(s.listBatches(a.id).length, 1);
  const r1 = s.analyze(a.id, 95, "req-a");
  const r2 = s.analyze(a.id, 95, "req-a");
  assert.equal(r1.id, r2.id);
  assert.equal(r2.idempotent, true);
});

test("修订：修改批次产生新 revision，分析取最新，历史报告不变", () => {
  const s = newService();
  const ds = seed(s);
  const before = s.analyze(ds, 95);
  s.addBatches(ds, [{ batchKey: "A", metricName: "m", metricVersion: "v1", k: 4, n: 40 }]);
  const after = s.analyze(ds, 95);
  assert.equal(after.report.metrics[0].totals.k, 13); // 4 + 9
  assert.equal(after.report.metrics[0].totals.n, 130);
  const oldReport = s.getAnalysis(before.id).report;
  assert.equal(oldReport.metrics[0].totals.k, 10, "历史报告快照不可变");
});

test("切换置信度生成新报告", () => {
  const s = newService();
  const ds = seed(s);
  const r90 = s.analyze(ds, 90);
  const r99 = s.analyze(ds, 99);
  assert.notEqual(r90.id, r99.id);
  const w90 = r90.report.metrics[0].merged.upper! - r90.report.metrics[0].merged.lower!;
  const w99 = r99.report.metrics[0].merged.upper! - r99.report.metrics[0].merged.lower!;
  assert.ok(w99 > w90);
});

test("重启读取：落盘后重新打开数据仍在", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wilson-"));
  const file = path.join(dir, "t.db");
  const s1 = new Service(openDb(file));
  const ds = seed(s1);
  const a1 = s1.analyze(ds, 95);
  const s2 = new Service(openDb(file));
  const loaded = s2.getAnalysis(a1.id);
  assert.equal(loaded.report.metrics[0].totals.k, 10);
  assert.equal(s2.listBatches(ds).length, 2);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上 SQLite 句柄释放可能有延迟，临时目录由系统清理即可
  }
});

test("CSV 导出包含合并行与零样本行", () => {
  const s = newService();
  const ds = s.createDataset("d");
  s.addBatches(ds.id, [
    { batchKey: "A", metricName: "m", metricVersion: "v1", k: 1, n: 10 },
    { batchKey: "E", metricName: "m", metricVersion: "v1", k: 0, n: 0 },
  ]);
  const a = s.analyze(ds.id, 95);
  const csv = s.exportAnalysisCsv(a.id);
  assert.match(csv, /__merged__/);
  assert.match(csv, /no_data/);
});
