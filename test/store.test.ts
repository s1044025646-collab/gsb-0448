import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store";
import { buildAnalysis } from "../src/analysis";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wilson-test-"));
  return path.join(dir, "t.db");
}

test("合并去重：同 ref 修订只取当前版本，按计数相加重算", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("d1");
  store.upsertBatch(ds.id, "A", 1, 10, "m", "v1");
  store.upsertBatch(ds.id, "B", 9, 90, "m", "v1");
  const a = buildAnalysis(store.listBatches(ds.id), "m", 0.95);
  assert.equal(a.totals.k, 10);
  assert.equal(a.totals.n, 100);
  assert.equal(a.totals.failures, 90);
  assert.equal(a.included_batches.length, 2);
  assert.ok(Math.abs(a.merged_terms.p! - 0.1) < 1e-15);

  // 修订 A 为 2/10，新分析必须使用新计数；历史修订仍在。
  store.upsertBatch(ds.id, "A", 2, 10, "m", "v1");
  const revs = store.listRevisions(ds.id, "A");
  assert.equal(revs.length, 2);
  assert.equal(revs[0]!.k, 1);
  const a2 = buildAnalysis(store.listBatches(ds.id), "m", 0.95);
  assert.equal(a2.totals.k, 11);
  assert.equal(a2.totals.n, 100);
  store.close();
});

test("零样本批次被排除且不贡献分母", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("d2");
  store.upsertBatch(ds.id, "A", 0, 0, "m", "v1");
  store.upsertBatch(ds.id, "B", 3, 10, "m", "v1");
  const a = buildAnalysis(store.listBatches(ds.id), "m", 0.95);
  assert.equal(a.totals.n, 10);
  assert.equal(a.totals.k, 3);
  assert.deepEqual(a.excluded_zero_n_batches, [{ ref: "A", revision: 1 }]);
  assert.equal(a.included_batches.length, 1);
  store.close();
});

test("口径版本冲突拒绝合并", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("d3");
  store.upsertBatch(ds.id, "A", 1, 10, "m", "v1");
  store.upsertBatch(ds.id, "B", 2, 10, "m", "v2");
  assert.throws(() => buildAnalysis(store.listBatches(ds.id), "m", 0.95), (e: Error & { code?: string }) => e.code === "CALIBER_CONFLICT");
  store.close();
});

test("指标之间互不混淆", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("d4");
  store.upsertBatch(ds.id, "A", 1, 10, "m1", "v1");
  store.upsertBatch(ds.id, "B", 9, 10, "m2", "v1");
  const a = buildAnalysis(store.listBatches(ds.id), "m1", 0.95);
  assert.equal(a.included_batches.length, 1);
  assert.equal(a.totals.k, 1);
  store.close();
});

test("修订时改变指标/口径被拒绝", () => {
  const store = new Store(tmpDb());
  const ds = store.createDataset("d5");
  store.upsertBatch(ds.id, "A", 1, 10, "m", "v1");
  assert.throws(() => store.upsertBatch(ds.id, "A", 2, 10, "m", "v2"), (e: { code?: string }) => e.code === "CALIBER_CONFLICT");
  store.close();
});

test("重启后数据、修订与快照可读", () => {
  const dbPath = tmpDb();
  const s1 = new Store(dbPath);
  const ds = s1.createDataset("restart");
  s1.upsertBatch(ds.id, "A", 1, 10, "m", "v1");
  s1.upsertBatch(ds.id, "B", 9, 90, "m", "v1");
  const snap = { ...buildAnalysis(s1.listBatches(ds.id), "m", 0.95), generated_at: "t" };
  const analysisId = s1.insertAnalysis(ds.id, "m", "v1", 0.95, "req-1", snap);
  s1.close();

  const s2 = new Store(dbPath);
  const a = buildAnalysis(s2.listBatches(ds.id), "m", 0.95);
  assert.equal(a.totals.k, 10);
  const row = s2.getAnalysis(analysisId);
  assert.ok(row);
  const parsed = JSON.parse(row!.snapshot);
  assert.equal(parsed.totals.n, 100);
  // 同一 request_id 重复返回原结果（唯一约束）。
  assert.throws(
    () => s2.insertAnalysis(ds.id, "m", "v1", 0.95, "req-1", snap),
    (e: { code?: string }) => e.code === "IDEMPOTENCY_REPLAY"
  );
  const found = s2.getAnalysisByRequestId("req-1");
  assert.equal(found!.id, analysisId);
  s2.close();
});

test("输入顺序不影响合并数值与规范输出", () => {
  const s1 = new Store(tmpDb());
  const d1 = s1.createDataset("x");
  s1.upsertBatch(d1.id, "A", 1, 10, "m", "v1");
  s1.upsertBatch(d1.id, "B", 9, 90, "m", "v1");
  const r1 = buildAnalysis(s1.listBatches(d1.id), "m", 0.95);

  const s2 = new Store(tmpDb());
  const d2 = s2.createDataset("x");
  s2.upsertBatch(d2.id, "B", 9, 90, "m", "v1");
  s2.upsertBatch(d2.id, "A", 1, 10, "m", "v1");
  const r2 = buildAnalysis(s2.listBatches(d2.id), "m", 0.95);

  assert.deepEqual(JSON.parse(JSON.stringify(r1.included_batches)), JSON.parse(JSON.stringify(r2.included_batches)));
  assert.equal(r1.merged_terms.lower, r2.merged_terms.lower);
  assert.equal(r1.merged_terms.upper, r2.merged_terms.upper);
  s1.close();
  s2.close();
});
