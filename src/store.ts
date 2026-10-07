// SQLite 持久化层。
// datasets:        数据集
// batches:         批次的当前版本（同一 ref 通过 revision 递增修订；不物理改写历史）
// batch_revisions: 每次录入/修订的不可变历史
// analyses:        冻结分析（含完整 JSON 快照）
// request_log:     幂等请求 ID -> 首次响应
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export interface DatasetRow { id: number; name: string; created_at: string; }
export interface BatchRevisionRow {
  id: number;
  dataset_id: number;
  ref: string;
  revision: number;
  k: number;
  n: number;
  metric: string;
  caliber_version: string;
  created_at: string;
}
export interface BatchRow extends BatchRevisionRow {}
export interface AnalysisRow {
  id: number;
  dataset_id: number;
  metric: string;
  caliber_version: string;
  confidence: number;
  request_id: string | null;
  snapshot: string;
  created_at: string;
}

export class Store {
  db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS batch_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        ref TEXT NOT NULL,
        revision INTEGER NOT NULL,
        k INTEGER NOT NULL,
        n INTEGER NOT NULL,
        metric TEXT NOT NULL,
        caliber_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS batches (
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        ref TEXT NOT NULL,
        revision INTEGER NOT NULL,
        k INTEGER NOT NULL,
        n INTEGER NOT NULL,
        metric TEXT NOT NULL,
        caliber_version TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (dataset_id, ref)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id INTEGER NOT NULL REFERENCES datasets(id),
        metric TEXT NOT NULL,
        caliber_version TEXT NOT NULL,
        confidence REAL NOT NULL,
        request_id TEXT UNIQUE,
        snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS request_log (
        request_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  createDataset(name: string): DatasetRow {
    const info = this.db.prepare("INSERT INTO datasets(name) VALUES (?)").run(name);
    return this.getDataset(Number(info.lastInsertRowid))!;
  }

  getDataset(id: number): DatasetRow | undefined {
    return this.db.prepare("SELECT id, name, created_at FROM datasets WHERE id = ?").get(id) as DatasetRow | undefined;
  }

  getBatch(datasetId: number, ref: string): BatchRow | undefined {
    return this.db.prepare("SELECT * FROM batches WHERE dataset_id = ? AND ref = ?").get(datasetId, ref) as BatchRow | undefined;
  }

  listBatches(datasetId: number): BatchRow[] {
    return this.db.prepare("SELECT * FROM batches WHERE dataset_id = ? ORDER BY ref COLLATE BINARY").all(datasetId) as BatchRow[];
  }

  listRevisions(datasetId: number, ref: string): BatchRevisionRow[] {
    return this.db.prepare(
      "SELECT * FROM batch_revisions WHERE dataset_id = ? AND ref = ? ORDER BY revision"
    ).all(datasetId, ref) as BatchRevisionRow[];
  }

  // 单条录入：ref 已存在则创建新修订（指标名/口径沿用，计数可改）。
  upsertBatch(datasetId: number, ref: string, k: number, n: number, metric: string, caliberVersion: string): { revision: number; created: boolean } {
    const existing = this.getBatch(datasetId, ref);
    if (existing && (existing.metric !== metric || existing.caliber_version !== caliberVersion)) {
      throw Object.assign(new Error("caliber-conflict"), { code: "CALIBER_CONFLICT" });
    }
    const revision = existing ? existing.revision + 1 : 1;
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO batch_revisions(dataset_id, ref, revision, k, n, metric, caliber_version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(datasetId, ref, revision, k, n, metric, caliberVersion);
      this.db.prepare(`
        INSERT INTO batches(dataset_id, ref, revision, k, n, metric, caliber_version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(dataset_id, ref) DO UPDATE SET
          revision = excluded.revision,
          k = excluded.k, n = excluded.n,
          metric = excluded.metric, caliber_version = excluded.caliber_version,
          updated_at = datetime('now')
      `).run(datasetId, ref, revision, k, n, metric, caliberVersion);
    });
    tx();
    return { revision, created: !existing };
  }

  insertAnalysis(datasetId: number, metric: string, caliberVersion: string, confidence: number, requestId: string | null, snapshot: unknown): number {
    const json = JSON.stringify(snapshot);
    try {
      const info = this.db.prepare(`
        INSERT INTO analyses(dataset_id, metric, caliber_version, confidence, request_id, snapshot)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(datasetId, metric, caliberVersion, confidence, requestId, json);
      return Number(info.lastInsertRowid);
    } catch (e) {
      if ((e as Error & { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" && requestId) {
        throw Object.assign(new Error("idempotency-replay"), { code: "IDEMPOTENCY_REPLAY" });
      }
      throw e;
    }
  }

  getAnalysis(id: number): AnalysisRow | undefined {
    return this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as AnalysisRow | undefined;
  }

  getAnalysisByRequestId(requestId: string): AnalysisRow | undefined {
    return this.db.prepare("SELECT * FROM analyses WHERE request_id = ?").get(requestId) as AnalysisRow | undefined;
  }

  listAnalyses(datasetId: number): Array<Omit<AnalysisRow, "snapshot">> {
    return this.db.prepare(
      "SELECT id, dataset_id, metric, caliber_version, confidence, request_id, created_at FROM analyses WHERE dataset_id = ? ORDER BY id"
    ).all(datasetId) as Array<Omit<AnalysisRow, "snapshot">>;
  }
}
