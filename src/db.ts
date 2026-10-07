import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_DATA_DIR = path.join(process.cwd(), "data");

export function openDb(dbPath?: string): DatabaseSync {
  const file = dbPath ?? path.join(DEFAULT_DATA_DIR, "wilson.db");
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      batch_key TEXT NOT NULL,
      revision_no INTEGER NOT NULL,
      metric_name TEXT NOT NULL,
      metric_version TEXT NOT NULL,
      k INTEGER NOT NULL,
      n INTEGER NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (dataset_id, batch_key, revision_no)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      confidence INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      request_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}
