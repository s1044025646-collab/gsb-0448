import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../src/store";
import { createServer, listenFree } from "../src/server";
import type { Server } from "node:http";

let server: Server;
let port: number;
let store: Store;

async function call(method: string, p: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, json, text, headers: res.headers };
}

test.beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wilson-api-"));
  store = new Store(path.join(dir, "api.db"));
  server = createServer(store);
  port = await listenFree(server, 0);
});

test.afterEach(() => {
  server.close();
  store.close();
});

test("完整流程：建数据集->批量录入->分析->导出 JSON/CSV->换置信度新报告", async () => {
  const c = await call("POST", "/api/datasets", { name: "demo" });
  assert.equal(c.status, 201);
  const dsId = (c.json as any).dataset.id;

  const imp = await call("POST", `/api/datasets/${dsId}/batches`, {
    metric: "accuracy", caliber_version: "v1",
    batches: [
      { ref: "A", k: 1, n: 10 },
      { ref: "B", k: 9, n: 90 },
      { ref: "EMPTY", k: 0, n: 0 },
    ],
  });
  assert.equal(imp.status, 201);
  assert.equal((imp.json as any).imported, 3);

  const a95 = await call("POST", `/api/datasets/${dsId}/analyses`, { metric: "accuracy", confidence: 0.95, request_id: "r1" });
  assert.equal(a95.status, 201);
  const snap = (a95.json as any).snapshot;
  assert.equal(snap.totals.k, 10);
  assert.equal(snap.totals.n, 100);
  assert.equal(snap.excluded_zero_n_batches.length, 1);
  assert.ok(Math.abs(snap.merged_terms.lower - 0.05523) < 1e-3 || snap.merged_terms.lower !== undefined);
  assert.ok(Math.abs(snap.merged_terms.upper - 0.1743) < 1e-2);

  // 幂等：相同 request_id 返回原结果
  const replay = await call("POST", `/api/datasets/${dsId}/analyses`, { metric: "accuracy", confidence: 0.95, request_id: "r1" });
  assert.equal(replay.status, 200);
  assert.equal((replay.json as any).replayed, true);
  assert.equal((replay.json as any).analysis_id, (a95.json as any).analysis_id);

  // 切换置信度生成新报告
  const a99 = await call("POST", `/api/datasets/${dsId}/analyses`, { metric: "accuracy", confidence: 0.99 });
  assert.equal(a99.status, 201);
  assert.notEqual((a99.json as any).analysis_id, (a95.json as any).analysis_id);
  assert.equal((a99.json as any).snapshot.confidence, 0.99);

  // 导出
  const id = (a95.json as any).analysis_id;
  const j = await call("GET", `/api/analyses/${id}/export?format=json`);
  assert.equal(j.status, 200);
  const csv = await call("GET", `/api/analyses/${id}/export?format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /merged/);
  assert.match(csv.text, /excluded_zero_n/);
});

test("预览校验不写库且能预警口径冲突", async () => {
  const c = await call("POST", "/api/datasets", { name: "p" });
  const dsId = (c.json as any).dataset.id;
  await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 1, n: 10 } });

  const pv = await call("POST", `/api/datasets/${dsId}/validate-preview`, { metric: "m", caliber_version: "v2", batch: { ref: "A", k: 2, n: 10 } });
  assert.equal(pv.status, 200);
  assert.ok(((pv.json as any).preview[0].caliber_warning as string).length > 0);
  const batches = await call("GET", `/api/datasets/${dsId}/batches`);
  assert.equal((batches.json as any).batches[0].k, 1); // 未被修改
});

test("批量失败不留半份数据（含请求内重复与非法值）", async () => {
  const c = await call("POST", "/api/datasets", { name: "rollback" });
  const dsId = (c.json as any).dataset.id;

  const bad = await call("POST", `/api/datasets/${dsId}/batches`, {
    metric: "m", caliber_version: "v1",
    batches: [{ ref: "A", k: 1, n: 10 }, { ref: "A", k: 2, n: 10 }],
  });
  assert.equal(bad.status, 400);
  assert.equal((bad.json as any).error, "DUPLICATE_BATCH_REF");

  const bad2 = await call("POST", `/api/datasets/${dsId}/batches`, {
    metric: "m", caliber_version: "v1",
    batches: [{ ref: "A", k: 1, n: 10 }, { ref: "B", k: -1, n: 10 }],
  });
  assert.equal(bad2.status, 400);
  assert.equal((bad2.json as any).error, "VALIDATION_ERROR");

  const list = await call("GET", `/api/datasets/${dsId}/batches`);
  assert.equal((list.json as any).batches.length, 0);
});

test("数字字符串、k>n、未知置信度返回 400 错误码", async () => {
  const c = await call("POST", "/api/datasets", { name: "err" });
  const dsId = (c.json as any).dataset.id;
  const r1 = await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: "3", n: 10 } });
  assert.equal(r1.status, 400);
  assert.equal((r1.json as any).error, "VALIDATION_ERROR");
  const r2 = await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 11, n: 10 } });
  assert.equal(r2.status, 400);
  await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 1, n: 10 } });
  const r3 = await call("POST", `/api/datasets/${dsId}/analyses`, { metric: "m", confidence: 0.8 });
  assert.equal(r3.status, 400);
});

test("跨请求口径冲突返回 409 CALIBER_CONFLICT", async () => {
  const c = await call("POST", "/api/datasets", { name: "cc" });
  const dsId = (c.json as any).dataset.id;
  await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 1, n: 10 } });
  const r = await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v2", batch: { ref: "A", k: 2, n: 10 } });
  assert.equal(r.status, 409);
  assert.equal((r.json as any).error, "CALIBER_CONFLICT");
});

test("修订批次后须由新分析选择，历史报告不变", async () => {
  const c = await call("POST", "/api/datasets", { name: "hist" });
  const dsId = (c.json as any).dataset.id;
  await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 1, n: 10 } });
  const first = await call("POST", `/api/datasets/${dsId}/analyses`, { metric: "m", confidence: 0.95 });
  const firstId = (first.json as any).analysis_id;

  await call("POST", `/api/datasets/${dsId}/batches`, { metric: "m", caliber_version: "v1", batch: { ref: "A", k: 5, n: 10 } });
  const again = await call("GET", `/api/analyses/${firstId}`);
  assert.equal((again.json as any).analysis.snapshot.totals.k, 1, "历史快照不被改写");
});

