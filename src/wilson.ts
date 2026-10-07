// Wilson score 区间核心实现（无连续性修正）。
// 算法版本号随公式或 z 常数变更而递增，结果快照中记录以便核验。
export const ALGORITHM_VERSION = "wilson-score@1.0.0";

export const Z_VALUES = {
  90: 1.6448536269514722,
  95: 1.959963984540054,
  99: 2.5758293035489004,
} as const;

export type Confidence = 90 | 95 | 99;
export const CONFIDENCES: Confidence[] = [90, 95, 99];

export const MAX_BATCH_N = 10_000_000;

export class ValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateConfidence(c: unknown): Confidence {
  if (c === 90 || c === 95 || c === 99) return c;
  throw new ValidationError(
    "INVALID_CONFIDENCE",
    `置信度只支持 90、95、99，收到: ${JSON.stringify(c)}`,
  );
}

// k、n 必须是非负安全整数，k<=n，单批 n<=10,000,000。
// 数字字符串、小数、负数一律拒绝，规则对单条与批量一致。
export function validateCounts(k: unknown, n: unknown): { k: number; n: number } {
  for (const [name, v] of [["k", k], ["n", n]] as const) {
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      throw new ValidationError(
        "INVALID_INTEGER",
        `${name} 必须是非负安全整数（不接受字符串、小数），收到: ${JSON.stringify(v)}`,
      );
    }
    if (v < 0) {
      throw new ValidationError("NEGATIVE_COUNT", `${name} 不能为负数，收到: ${v}`);
    }
  }
  const kk = k as number;
  const nn = n as number;
  if (kk > nn) {
    throw new ValidationError("K_GT_N", `成功次数 k=${kk} 不能大于总次数 n=${nn}`);
  }
  if (nn > MAX_BATCH_N) {
    throw new ValidationError(
      "N_TOO_LARGE",
      `单批 n 上限为 ${MAX_BATCH_N}，收到: ${nn}`,
    );
  }
  return { k: kk, n: nn };
}

export interface WilsonResult {
  status: "ok" | "no_data";
  k: number;
  n: number;
  confidence: Confidence;
  z: number;
  proportion: number | null;
  lower: number | null;
  upper: number | null;
  // 公式中间量，便于核验
  zSquared: number;
  denominator: number | null; // d = 1 + z^2/n
  center: number | null; // c
  halfWidth: number | null; // h
  algorithmVersion: string;
}

// 仅允许吸收极小浮点舍入误差（|err| <= 1e-12），不做宽泛裁剪。
const ROUNDING_EPS = 1e-12;

export function wilsonInterval(kRaw: unknown, nRaw: unknown, confRaw: unknown): WilsonResult {
  const { k, n } = validateCounts(kRaw, nRaw);
  const confidence = validateConfidence(confRaw);
  const z = Z_VALUES[confidence];
  const zSquared = z * z;
  const base: WilsonResult = {
    status: "ok",
    k,
    n,
    confidence,
    z,
    proportion: null,
    lower: null,
    upper: null,
    zSquared,
    denominator: null,
    center: null,
    halfWidth: null,
    algorithmVersion: ALGORITHM_VERSION,
  };
  if (n === 0) {
    // 无数据：比例与区间均为 null，绝不返回 0、[0,0] 或 NaN。
    base.status = "no_data";
    return base;
  }
  const p = k / n;
  const d = 1 + zSquared / n;
  const center = (p + zSquared / (2 * n)) / d;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / d;
  let lower = center - halfWidth;
  let upper = center + halfWidth;
  // 数学上精确的边界：k=0 时下界为 0，k=n 时上界为 1。
  if (k === 0) lower = 0;
  if (k === n) upper = 1;
  // 吸收 |err|<=1e-12 的浮点舍入，保证 p 落在区间内、边界落在 [0,1]。
  if (lower > p && lower - p <= ROUNDING_EPS) lower = p;
  if (upper < p && p - upper <= ROUNDING_EPS) upper = p;
  if (lower < 0) {
    if (lower < -ROUNDING_EPS) {
      throw new ValidationError("INTERNAL_RANGE", `内部错误：下界 ${lower} 显著小于 0`);
    }
    lower = 0;
  }
  if (upper > 1) {
    if (upper > 1 + ROUNDING_EPS) {
      throw new ValidationError("INTERNAL_RANGE", `内部错误：上界 ${upper} 显著大于 1`);
    }
    upper = 1;
  }
  base.proportion = p;
  base.lower = lower;
  base.upper = upper;
  base.denominator = d;
  base.center = center;
  base.halfWidth = halfWidth;
  return base;
}
