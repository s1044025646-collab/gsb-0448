// 报告导出：JSON（完整快照）与 CSV（含批次行与合并行）。
import { AnalysisSnapshot } from "./analysis";

export function toJSON(snapshot: AnalysisSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

function csvCell(v: unknown): string {
  const s = v === null ? "" : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV(snapshot: AnalysisSnapshot): string {
  const header = [
    "row_type", "ref", "revision", "metric", "caliber_version",
    "confidence", "z", "k", "n", "failures", "p",
    "center", "half_width", "lower", "upper", "status", "algorithm",
  ];
  const rows: string[] = [header.join(",")];

  const push = (
    rowType: string,
    ref: string,
    revision: number | "",
    k: number,
    n: number,
    failures: number,
    p: number | null,
    center: number | null,
    halfWidth: number | null,
    lower: number | null,
    upper: number | null,
    status: string,
  ): void => {
    rows.push(
      [
        rowType, ref, revision, snapshot.metric, snapshot.caliber_version,
        snapshot.confidence, snapshot.z, k, n, failures,
        p, center, halfWidth, lower, upper, status, snapshot.algorithm,
      ].map(csvCell).join(",")
    );
  };

  for (const b of snapshot.included_batches) {
    push("batch", b.ref, b.revision, b.k, b.n, b.failures, b.p, null, null, b.interval.lower, b.interval.upper, b.interval.status);
  }
  for (const e of snapshot.excluded_zero_n_batches) {
    push("excluded_zero_n", e.ref, e.revision, 0, 0, 0, null, null, null, null, null, "no_data");
  }
  const m = snapshot.merged_terms;
  push(
    "merged", "(merged)", "",
    snapshot.totals.k, snapshot.totals.n, snapshot.totals.failures,
    snapshot.totals.p, m.center, m.halfWidth, m.lower, m.upper, m.status
  );
  return rows.join("\r\n") + "\r\n";
}
