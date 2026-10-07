import http from "node:http";
import { Service } from "./service";
import { ValidationError } from "./wilson";

function send(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": contentType });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new ValidationError("INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { status: "ok" });
      }
      // POST /datasets {name, requestId?}
      if (method === "POST" && parts.length === 1 && parts[0] === "datasets") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return send(res, 201, service.createDataset(body.name, body.requestId as string | undefined));
      }
      const datasetMatch = parts[0] === "datasets" ? Number(parts[1]) : NaN;
      // POST /datasets/:id/batches  {batches:[...]} 或单条 {batchKey,...}，可带 requestId
      if (method === "POST" && parts.length === 3 && parts[0] === "datasets" && parts[2] === "batches") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const items = Array.isArray(body.batches) ? body.batches : [body];
        return send(res, 201, service.addBatches(datasetMatch, items, body.requestId as string | undefined));
      }
      // POST /datasets/:id/batches/preview {batches:[...], confidence}
      if (method === "POST" && parts.length === 4 && parts[0] === "datasets" && parts[2] === "batches" && parts[3] === "preview") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const items = Array.isArray(body.batches) ? body.batches : [body];
        return send(res, 200, { preview: service.preview(items, body.confidence ?? 95) });
      }
      // GET /datasets/:id/batches
      if (method === "GET" && parts.length === 3 && parts[0] === "datasets" && parts[2] === "batches") {
        return send(res, 200, { batches: service.listBatches(datasetMatch) });
      }
      // POST /datasets/:id/analyses {confidence, requestId?}
      if (method === "POST" && parts.length === 3 && parts[0] === "datasets" && parts[2] === "analyses") {
        const body = (await readBody(req)) as Record<string, unknown>;
        return send(res, 201, service.analyze(datasetMatch, body.confidence, body.requestId as string | undefined));
      }
      // GET /analyses/:id
      if (method === "GET" && parts.length === 2 && parts[0] === "analyses") {
        return send(res, 200, service.getAnalysis(Number(parts[1])));
      }
      // GET /analyses/:id/export?format=json|csv
      if (method === "GET" && parts.length === 3 && parts[0] === "analyses" && parts[2] === "export") {
        const format = url.searchParams.get("format") ?? "json";
        if (format === "csv") {
          return send(res, 200, service.exportAnalysisCsv(Number(parts[1])), "text/csv; charset=utf-8");
        }
        if (format === "json") {
          return send(res, 200, service.getAnalysis(Number(parts[1])));
        }
        throw new ValidationError("INVALID_FORMAT", `不支持的导出格式: ${format}（支持 json、csv）`);
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `${method} ${url.pathname} 不存在` } });
    } catch (err) {
      if (err instanceof ValidationError) {
        send(res, 400, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
      }
    }
  });
}

// 默认端口 0 = 让操作系统分配空闲端口；可用 PORT 环境变量或 --port 指定。
export function startServer(service: Service, port: number): Promise<{ port: number; close: () => void }> {
  const server = createServer(service);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
