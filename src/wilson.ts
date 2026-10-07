// Wilson score 区间（无连续性修正）核心实现。
// 公式：
//   p = k / n
//   d = 1 + z^2 / n
//   c = (p + z^2 / (2n)) / d
//   h = z * sqrt(p(1-p)/n + z^2/(4n^2)) / d
//   区间 [c - h, c + h]
// 不使用正态近似 p ± z*SE，也不做逆正态求值。

export const ALGORITHM_VERSION = "wilson-score-1.0";

export const Z_TABLE = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
} as const;

export type Confidence = 0.9 | 0.95 | 0.99;
export type ConfidenceKey = "0.9" | "0.95" | "0.99";

export const MAX_BATCH_N = 10_000_000;

export function isValidConfidence(value: unknown): value is Confidence {
  return value === 0.9 || value === 0.95 || value === 0.99;
}

// 仅吸收极小浮点舍入误差（< 1e-12），不做宽泛裁剪。
const EPS = 1e-12;

function clampTiny(x: number): number {
  if (x >= -EPS && x < 0) return 0;
  if (x > 1 && x <= 1 + EPS) return 1;
  return x;
}

export interface WilsonTerms {
  k: number;
  n: number;
  p: number | null;
  z: number;
  confidence: Confidence;
  d: number | null;
  center: number | null;
  halfWidth: number | null;
  lower: number | null;
  upper: number | null;
  status: "ok" | "no_data";
  algorithm: string;
}

export function wilsonTerms(k: number, n: number, confidence: Confidence): WilsonTerms {
  const z = Z_TABLE[confidence as unknown as ConfidenceKey];
  if (n === 0) {
    return {
      k, n, p: null, z, confidence,
      d: null, center: null, halfWidth: null,
      lower: null, upper: null,
      status: "no_data",
      algorithm: ALGORITHM_VERSION,
    };
  }
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const varianceTerm = (p * (1 - p)) / n + z2 / (4 * n * n);
  const halfWidth = (z * Math.sqrt(varianceTerm)) / d;
  const lower = clampTiny(center - halfWidth);
  const upper = clampTiny(center + halfWidth);
  return {
    k, n, p, z, confidence,
    d, center, halfWidth,
    lower, upper,
    status: "ok",
    algorithm: ALGORITHM_VERSION,
  };
}

export function wilsonInterval(k: number, n: number, confidence: Confidence): [number | null, number | null] {
  const t = wilsonTerms(k, n, confidence);
  return [t.lower, t.upper];
}

// 显示用百分比四舍五入；保存/比较仍使用未舍入数值。
export function formatPercent(x: number | null, digits = 2): string {
  if (x === null) return "无数据";
  return `${(x * 100).toFixed(digits)}%`;
}
