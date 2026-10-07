// 纯 Node.js HTTP 后端，无第三方 Web 框架。
import * as http from "node:http";
import { URL } from "node:url";
import { Store } from "./store";
import { AppError, parseConfidence, requireString, validateBatchInput } from "./validation";
import { buildAnalysis, AnalysisSnapshot } from "./analysis";
import { toCSV, toJSON } from "./export";

interface ResponseOptions { status?: number; headers?: Record<string, string>; replay?: boolean }

function send(res: http.ServerResponse, status: number, body: unknown, opts: ResponseOptions = {}): void {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body instanceof Buffer || typeof body === "string") {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json; charset=utf-8";
    res.writeHead(status, headers);
    res.end(body);
  } else {
    headers["Content-Type"] = "application/json; charset=utf-8";
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }
}

export function createServer(store: Store): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof AppError) {
        send(res, err.code === "NOT_FOUND" ? 404 : err.code === "CALIBER_CONFLICT" ? 409 : err.code === "IDEMPOTENCY_REPLAY" ? 409 : 400, { error: err.code, message: err.message, details: err.details });
      } else {
        send(res, 500, { error: "INTERNAL_ERROR", message: (err as Error).message });
      }
    });
  });
  return server;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";


    const body = await readJson(req);
    const reqId = (req.headers["x-request-id"] as string | undefined) ?? (body && typeof body.request_id === "string" ? body.request_id : null);

    // GET 路由
    if (method === "GET") {
      let m = p.match(/^\/api\/datasets\/(\d+)\/batches$/);
      if (m) {
        const ds = requireDataset(Number(m[1]));
        return send(res, 200, { dataset: ds, batches: store.listBatches(ds.id) });
      }
      m = p.match(/^\/api\/datasets\/(\d+)\/analyses$/);
      if (m) {
        requireDataset(Number(m[1]));
        return send(res, 200, { analyses: store.listAnalyses(Number(m[1])) });
      }
      m = p.match(/^\/api\/analyses\/(\d+)\/export$/);
      if (m) {
        const a = store.getAnalysis(Number(m[1]));
        if (!a) throw new AppError("NOT_FOUND", "分析不存在");
        const snapshot = JSON.parse(a.snapshot) as AnalysisSnapshot;
        const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
        if (format === "csv") return send(res, 200, toCSV(snapshot), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="analysis-${a.id}.csv"` } });
        return send(res, 200, snapshot, { headers: { "Content-Disposition": `attachment; filename="analysis-${a.id}.json"` } });
      }
      m = p.match(/^\/api\/analyses\/(\d+)$/);
      if (m) {
        const a = store.getAnalysis(Number(m[1]));
        if (!a) throw new AppError("NOT_FOUND", "分析不存在");
        return send(res, 200, { analysis: { id: a.id, created_at: a.created_at, snapshot: JSON.parse(a.snapshot) } });
      }
      m = p.match(/^\/api\/datasets\/(\d+)$/);
      if (m) {
        const ds = store.getDataset(Number(m[1]));
        if (!ds) throw new AppError("NOT_FOUND", "数据集不存在");
        return send(res, 200, { dataset: ds });
      }
      if (p === "/health") return send(res, 200, { ok: true });
      throw new AppError("NOT_FOUND", "未知路由", { method, path: p });
    }

    if (method !== "POST") throw new AppError("VALIDATION_ERROR", "仅支持 GET/POST", { method });

    // POST /api/datasets
    if (p === "/api/datasets") {
      const name = requireString("name", body?.name);
      const ds = store.createDataset(name);
      return send(res, 201, { dataset: ds });
    }

    let m = p.match(/^\/api\/datasets\/(\d+)\/batches$/);
    if (m) {
      const datasetId = Number(m[1]);
      requireDataset(datasetId);
      const metric = requireString("metric", body?.metric);
      const caliberVersion = requireString("caliber_version", body?.caliber_version);

      if (reqId) {
        const existing = store.getAnalysisByRequestId(reqId);
        if (existing) return send(res, 200, { replayed: true, analysis_id: existing.id, snapshot: JSON.parse(existing.snapshot) }, { replay: true });
      }

      const list = normalizeBatchList(body);
      const refs = new Set<string>();
      for (const item of list) {
        if (refs.has(item.ref)) throw new AppError("DUPLICATE_BATCH_REF", `请求内批次标识重复：${item.ref}`, { ref: item.ref });
        refs.add(item.ref);
      }
      // 全量先校验（含跨请求口径冲突），再在一个事务内写入；失败不留半份数据。
      const results: Array<{ ref: string; revision: number; created: boolean }> = [];
      const writeTx = store.db.transaction(() => {
        for (const item of list) {
          try {
            const r = store.upsertBatch(datasetId, item.ref, item.k, item.n, metric, caliberVersion);
            results.push({ ref: item.ref, ...r });
          } catch (e) {
            if ((e as { code?: string }).code === "CALIBER_CONFLICT") {
              throw new AppError("CALIBER_CONFLICT", `批次 ${item.ref} 已存在但指标/口径版本不一致，拒绝混入`, { ref: item.ref });
            }
            throw e;
          }
        }
      });
      writeTx();
      return send(res, 201, { imported: results.length, batches: results });
    }

    // 预览校验：不写库
    m = p.match(/^\/api\/datasets\/(\d+)\/validate-preview$/);
    if (m) {
      const datasetId = Number(m[1]);
      requireDataset(datasetId);
      const metric = requireString("metric", body?.metric);
      const caliberVersion = requireString("caliber_version", body?.caliber_version);
      const list = normalizeBatchList(body);
      const refs = new Set<string>();
      const preview = list.map((item) => {
        if (refs.has(item.ref)) throw new AppError("DUPLICATE_BATCH_REF", `批次标识重复：${item.ref}`, { ref: item.ref });
        refs.add(item.ref);
        const existing = store.getBatch(datasetId, item.ref);
        let caliberWarning: string | null = null;
        if (existing && (existing.metric !== metric || existing.caliber_version !== caliberVersion)) {
          caliberWarning = `已存在批次 ${item.ref} 的指标/口径不同，正式提交会被拒绝`;
        }
        return { ...item, would_create_new_revision: Boolean(existing), caliber_warning: caliberWarning };
      });
      return send(res, 200, { valid: true, count: preview.length, preview });
    }

    // 冻结分析；request_id 重复则返回原快照
    m = p.match(/^\/api\/datasets\/(\d+)\/analyses$/);
    if (m) {
      const datasetId = Number(m[1]);
      requireDataset(datasetId);
      const metric = requireString("metric", body?.metric);
      const confidence = parseConfidence(body?.confidence);
      const requestId = reqId;
      if (requestId) {
        const existing = store.getAnalysisByRequestId(requestId);
        if (existing) {
          return send(res, 200, { replayed: true, analysis_id: existing.id, snapshot: JSON.parse(existing.snapshot) });
        }
      }
      const snapshotBase = buildAnalysis(store.listBatches(datasetId), metric, confidence);
      const snapshot: AnalysisSnapshot = { ...snapshotBase, generated_at: new Date().toISOString() };
      const id = store.insertAnalysis(datasetId, metric, snapshot.caliber_version, confidence, requestId, snapshot);
      return send(res, 201, { analysis_id: id, snapshot });
    }

    throw new AppError("NOT_FOUND", "未知路由", { method, path: p });
  }

  function requireDataset(id: number) {
    const ds = store.getDataset(id);
    if (!ds) throw new AppError("NOT_FOUND", "数据集不存在", { dataset_id: id });
    return ds;
  }
}

function normalizeBatchList(body: any): Array<{ ref: string; k: number; n: number }> {
  if (body && Array.isArray(body.batches)) {
    if (body.batch !== undefined) throw new AppError("VALIDATION_ERROR", "batch 与 batches 不能同时提供");
    return body.batches.map((x: unknown) => validateBatchInput(x));
  }
  if (body && typeof body.batch === "object" && body.batch !== null) {
    return [validateBatchInput(body.batch)];
  }
  throw new AppError("VALIDATION_ERROR", "必须提供 batch(单个) 或 batches(数组)");
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  if ((req.method ?? "GET") === "GET") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

export interface ListenResult { port: number; close: () => void }

export function listenFree(server: http.Server, preferredPort?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("无法获取监听端口"));
    });
  });
}

