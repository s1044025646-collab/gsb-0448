import { DatabaseSync } from "node:sqlite";
import {
  ALGORITHM_VERSION,
  Confidence,
  ValidationError,
  Z_VALUES,
  validateConfidence,
  validateCounts,
  wilsonInterval,
  WilsonResult,
} from "./wilson";

export interface BatchInput {
  batchKey: string;
  metricName: string;
  metricVersion: string;
  k: unknown;
  n: unknown;
}

interface BatchRow {
  id: number;
  dataset_id: number;
  batch_key: string;
  revision_no: number;
  metric_name: string;
  metric_version: string;
  k: number;
  n: number;
}

function validateBatchInput(raw: unknown, index: number): BatchInput & { k: number; n: number } {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("INVALID_BATCH", `第 ${index} 条批次不是对象`);
  }
  const b = raw as Record<string, unknown>;
  for (const field of ["batchKey", "metricName", "metricVersion"] as const) {
    if (typeof b[field] !== "string" || (b[field] as string).trim() === "") {
      throw new ValidationError(
        "INVALID_BATCH",
        `第 ${index} 条批次缺少非空字符串字段 ${field}`,
      );
    }
  }
  const { k, n } = validateCounts(b.k, b.n);
  return {
    batchKey: (b.batchKey as string).trim(),
    metricName: (b.metricName as string).trim(),
    metricVersion: (b.metricVersion as string).trim(),
    k,
    n,
  };
}

export class Service {
  constructor(private db: DatabaseSync) {}

  private getDataset(id: number): void {
    const row = this.db.prepare("SELECT id FROM datasets WHERE id = ?").get(id);
    if (!row) throw new ValidationError("DATASET_NOT_FOUND", `数据集 ${id} 不存在`);
  }

  createDataset(name: unknown, requestId?: string): { id: number; name: string; idempotent: boolean } {
    if (typeof name !== "string" || name.trim() === "") {
      throw new ValidationError("INVALID_NAME", "数据集名称必须是非空字符串");
    }
    if (requestId) {
      const existing = this.db
        .prepare("SELECT id, name FROM datasets WHERE request_id = ?")
        .get(requestId) as { id: number; name: string } | undefined;
      if (existing) return { id: existing.id, name: existing.name, idempotent: true };
    }
    const info = this.db
      .prepare("INSERT INTO datasets (name, request_id) VALUES (?, ?)")
      .run(name.trim(), requestId ?? null);
    return { id: Number(info.lastInsertRowid), name: name.trim(), idempotent: false };
  }

  // 逐条或批量录入。整个批量是一个事务：任一条失败则全部回滚，不留半份数据。
  addBatches(datasetId: number, items: unknown[], requestId?: string) {
    this.getDataset(datasetId);
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError("EMPTY_BATCH_LIST", "批次列表必须是非空数组");
    }
    if (requestId) {
      const rows = this.db
        .prepare("SELECT batch_key, revision_no FROM batches WHERE request_id LIKE ?")
        .all(`${requestId}%`) as { batch_key: string; revision_no: number }[];
      if (rows.length > 0) {
        return {
          idempotent: true,
          inserted: rows.map((r) => ({ batchKey: r.batch_key, revisionNo: r.revision_no })),
        };
      }
    }
    const validated = items.map((it, i) => validateBatchInput(it, i));
    const keys = validated.map((v) => v.batchKey);
    if (new Set(keys).size !== keys.length) {
      throw new ValidationError("DUPLICATE_BATCH_KEY", "同一请求内 batchKey 重复", { keys });
    }
    const inserted: { batchKey: string; revisionNo: number }[] = [];
    this.db.exec("BEGIN");
    try {
      const findRev = this.db.prepare(
        "SELECT MAX(revision_no) AS max_rev FROM batches WHERE dataset_id = ? AND batch_key = ?",
      );
      const insert = this.db.prepare(
        `INSERT INTO batches (dataset_id, batch_key, revision_no, metric_name, metric_version, k, n, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      validated.forEach((v, i) => {
        const row = findRev.get(datasetId, v.batchKey) as { max_rev: number | null };
        const rev = (row.max_rev ?? 0) + 1;
        insert.run(
          datasetId,
          v.batchKey,
          rev,
          v.metricName,
          v.metricVersion,
          v.k,
          v.n,
          requestId ? `${requestId}#${i}` : null,
        );
        inserted.push({ batchKey: v.batchKey, revisionNo: rev });
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { idempotent: false, inserted };
  }

  // 预览校验：只验证并返回将计算的每批区间，不写库。
  preview(items: unknown[], confidenceRaw: unknown) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new ValidationError("EMPTY_BATCH_LIST", "批次列表必须是非空数组");
    }
    const confidence = validateConfidence(confidenceRaw);
    return items.map((it, i) => {
      const v = validateBatchInput(it, i);
      return { ...v, result: wilsonInterval(v.k, v.n, confidence) };
    });
  }

  private latestBatches(datasetId: number): BatchRow[] {
    return this.db
      .prepare(
        `SELECT b.* FROM batches b
         JOIN (SELECT batch_key, MAX(revision_no) AS mr FROM batches WHERE dataset_id = ? GROUP BY batch_key) t
           ON t.batch_key = b.batch_key AND t.mr = b.revision_no
         WHERE b.dataset_id = ?
         ORDER BY b.batch_key ASC`,
      )
      .all(datasetId, datasetId) as unknown as BatchRow[];
  }

  // 冻结分析：按 batch_key 去重（取最新修订），按指标分组求和计数后重算区间。
  analyze(datasetId: number, confidenceRaw: unknown, requestId?: string) {
    this.getDataset(datasetId);
    const confidence = validateConfidence(confidenceRaw);
    if (requestId) {
      const existing = this.db
        .prepare("SELECT id, snapshot_json FROM analyses WHERE request_id = ?")
        .get(requestId) as { id: number; snapshot_json: string } | undefined;
      if (existing) {
        return { id: existing.id, idempotent: true, report: JSON.parse(existing.snapshot_json) };
      }
    }
    const batches = this.latestBatches(datasetId);
    if (batches.length === 0) {
      throw new ValidationError("NO_BATCHES", `数据集 ${datasetId} 没有任何批次`);
    }
    // 同名指标不同口径版本：明确拒绝合并。
    const versionsByMetric = new Map<string, Set<string>>();
    for (const b of batches) {
      if (!versionsByMetric.has(b.metric_name)) versionsByMetric.set(b.metric_name, new Set());
      versionsByMetric.get(b.metric_name)!.add(b.metric_version);
    }
    for (const [name, versions] of versionsByMetric) {
      if (versions.size > 1) {
        throw new ValidationError(
          "METRIC_VERSION_CONFLICT",
          `指标 "${name}" 存在多个口径版本，拒绝合并`,
          { metric: name, versions: [...versions].sort() },
        );
      }
    }
    const byMetric = new Map<string, BatchRow[]>();
    for (const b of batches) {
      if (!byMetric.has(b.metric_name)) byMetric.set(b.metric_name, []);
      byMetric.get(b.metric_name)!.push(b);
    }
    const metrics = [...byMetric.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, rows]) => {
        const included = rows.filter((r) => r.n > 0);
        const excludedZero = rows.filter((r) => r.n === 0);
        let totalK = 0;
        let totalN = 0;
        for (const r of included) {
          totalK += r.k;
          totalN += r.n;
          if (!Number.isSafeInteger(totalK) || !Number.isSafeInteger(totalN)) {
            throw new ValidationError("SUM_OVERFLOW", "合并计数超出安全整数范围");
          }
        }
        const merged: WilsonResult = wilsonInterval(totalK, totalN, confidence);
        return {
          metricName: name,
          metricVersion: rows[0].metric_version,
          includedBatches: included.map((r) => ({
            batchKey: r.batch_key,
            revisionNo: r.revision_no,
            k: r.k,
            n: r.n,
            result: wilsonInterval(r.k, r.n, confidence),
          })),
          excludedZeroBatches: excludedZero.map((r) => ({
            batchKey: r.batch_key,
            revisionNo: r.revision_no,
            k: r.k,
            n: r.n,
            status: "no_data",
          })),
          totals: {
            k: totalK,
            n: totalN,
            successes: totalK,
            failures: totalN - totalK,
          },
          merged,
        };
      });
    const report = {
      datasetId,
      confidence,
      z: Z_VALUES[confidence],
      algorithmVersion: ALGORITHM_VERSION,
      metrics,
      note: "Wilson score 区间（无连续性修正）。区间不是下一批成功率的保证；合并不消除试验间相关性，前提是各批独立且口径一致。",
    };
    const info = this.db
      .prepare(
        "INSERT INTO analyses (dataset_id, confidence, algorithm_version, snapshot_json, request_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(datasetId, confidence, ALGORITHM_VERSION, JSON.stringify(report), requestId ?? null);
    return { id: Number(info.lastInsertRowid), idempotent: false, report };
  }

  getAnalysis(id: number) {
    const row = this.db
      .prepare("SELECT id, dataset_id, confidence, algorithm_version, snapshot_json, created_at FROM analyses WHERE id = ?")
      .get(id) as
      | { id: number; dataset_id: number; confidence: Confidence; algorithm_version: string; snapshot_json: string; created_at: string }
      | undefined;
    if (!row) throw new ValidationError("ANALYSIS_NOT_FOUND", `分析 ${id} 不存在`);
    return {
      id: row.id,
      datasetId: row.dataset_id,
      confidence: row.confidence,
      algorithmVersion: row.algorithm_version,
      createdAt: row.created_at,
      report: JSON.parse(row.snapshot_json),
    };
  }

  listBatches(datasetId: number) {
    this.getDataset(datasetId);
    return this.latestBatches(datasetId);
  }

  exportAnalysisCsv(id: number): string {
    const { report } = this.getAnalysis(id);
    const lines = [
      "metric_name,metric_version,batch_key,revision_no,k,n,proportion,lower,upper,confidence,status",
    ];
    for (const m of report.metrics) {
      for (const b of m.includedBatches) {
        const r = b.result;
        lines.push(
          [m.metricName, m.metricVersion, b.batchKey, b.revisionNo, b.k, b.n, r.proportion, r.lower, r.upper, r.confidence, r.status].join(","),
        );
      }
      for (const b of m.excludedZeroBatches) {
        lines.push([m.metricName, m.metricVersion, b.batchKey, b.revisionNo, b.k, b.n, "", "", "", report.confidence, "no_data"].join(","));
      }
      const r = m.merged;
      lines.push(
        [m.metricName, m.metricVersion, "__merged__", "", m.totals.k, m.totals.n, r.proportion ?? "", r.lower ?? "", r.upper ?? "", r.confidence, r.status].join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }
}
