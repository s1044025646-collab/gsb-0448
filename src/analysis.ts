// 合并分析服务：
//  - 按批次 ref 去重（使用当前版本计数），分别相加 k 与 n 后“重新”计算 Wilson 区间；
//  - 不平均各批比例，也不平均各批上下界；
//  - 同一指标名只允许单一口径版本，同名不同版本直接拒绝合并；
//  - n = 0 的批次列为“排除的零样本批次”，不贡献合并分母。
import { Confidence, wilsonTerms, WilsonTerms, ALGORITHM_VERSION } from "./wilson";
import { BatchRow } from "./store";
import { AppError } from "./validation";

export interface IncludedBatch {
  ref: string;
  revision: number;
  k: number;
  n: number;
  failures: number;
  p: number | null;
  interval: { lower: number | null; upper: number | null; status: string };
}

export interface AnalysisSnapshot {
  metric: string;
  caliber_version: string;
  confidence: Confidence;
  z: number;
  algorithm: string;
  generated_at: string;
  included_batches: IncludedBatch[];
  excluded_zero_n_batches: Array<{ ref: string; revision: number }>;
  totals: {
    k: number;
    n: number;
    failures: number;
    p: number | null;
  };
  merged_terms: WilsonTerms;
  caveat: string;
}

export function buildAnalysis(batches: BatchRow[], metric: string, confidence: Confidence): Omit<AnalysisSnapshot, "generated_at"> {
  const metricBatches = batches.filter((b) => b.metric === metric);
  if (metricBatches.length === 0) {
    throw new AppError("NOT_FOUND", `指标 ${metric} 下没有任何批次`, { metric });
  }

  const caliberVersions = new Set(metricBatches.map((b) => b.caliber_version));
  if (caliberVersions.size > 1) {
    throw new AppError(
      "CALIBER_CONFLICT",
      `指标 ${metric} 存在多个口径版本，拒绝合并：${[...caliberVersions].sort().join(", ")}`,
      { metric, caliber_versions: [...caliberVersions] }
    );
  }
  const caliberVersion = [...caliberVersions][0]!;

  // 按 ref 去重（listBatches 已是当前版本），顺序不影响结果：排序保证规范输出。
  const byRef = new Map<string, BatchRow>();
  for (const b of metricBatches) {
    if (byRef.has(b.ref)) {
      throw new AppError("DUPLICATE_BATCH_REF", `批次标识重复：${b.ref}`, { ref: b.ref });
    }
    byRef.set(b.ref, b);
  }
  const sorted = [...byRef.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const included: IncludedBatch[] = [];
  const excluded: Array<{ ref: string; revision: number }> = [];
  let totalK = 0;
  let totalN = 0;

  for (const b of sorted) {
    if (b.n === 0) {
      excluded.push({ ref: b.ref, revision: b.revision });
      continue;
    }
    if (!Number.isSafeInteger(totalK + b.k) || !Number.isSafeInteger(totalN + b.n)) {
      throw new AppError("VALIDATION_ERROR", "合并计数超出安全整数范围", { ref: b.ref });
    }
    totalK += b.k;
    totalN += b.n;
    const terms = wilsonTerms(b.k, b.n, confidence);
    included.push({
      ref: b.ref,
      revision: b.revision,
      k: b.k,
      n: b.n,
      failures: b.n - b.k,
      p: terms.p,
      interval: { lower: terms.lower, upper: terms.upper, status: terms.status },
    });
  }

  if (totalK > totalN) {
    throw new AppError("VALIDATION_ERROR", "合并后 k 大于 n，数据不合法");
  }

  const merged = wilsonTerms(totalK, totalN, confidence);

  return {
    metric,
    caliber_version: caliberVersion,
    confidence,
    z: merged.z,
    algorithm: ALGORITHM_VERSION,
    included_batches: included,
    excluded_zero_n_batches: excluded,
    totals: { k: totalK, n: totalN, failures: totalN - totalK, p: merged.p },
    merged_terms: merged,
    caveat:
      "合并假设各批次试验相互独立且口径一致；本服务不处理批次相关性，" +
      "Wilson 区间描述给定计数下比例的不确定性，不是对下一批成功率的保证。",
  };
}
