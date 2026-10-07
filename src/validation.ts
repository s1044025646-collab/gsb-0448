// 统一的参数校验与错误码。
// 规则公开且一致：
//  - k、n 必须是 number 类型的非负安全整数；数字字符串一律拒绝（不做隐式转换）；
//  - 布尔值、null、NaN、Infinity、小数、负数均拒绝；
//  - 必须 k <= n；单批 n <= 1000 万。

import { MAX_BATCH_N, isValidConfidence } from "./wilson";

export type ErrorCode =
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "DUPLICATE_BATCH_REF"
  | "CALIBER_CONFLICT"
  | "NOT_FOUND"
  | "IDEMPOTENCY_REPLAY"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isNonNegSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// 数字字符串不被接受：保持类型严格，避免 "10" 与 10 混用。
export function validateCount(name: string, v: unknown): number {
  if (typeof v === "string") {
    throw new AppError("VALIDATION_ERROR", `${name} 必须是数字类型，不接受数字字符串`, { field: name, received: v });
  }
  if (!isNonNegSafeInt(v)) {
    throw new AppError("VALIDATION_ERROR", `${name} 必须是非负安全整数`, { field: name, received: String(v) });
  }
  return v;
}

export interface BatchInput {
  ref: string;
  k: number;
  n: number;
}

export function validateBatchInput(raw: unknown): BatchInput {
  if (typeof raw !== "object" || raw === null) {
    throw new AppError("VALIDATION_ERROR", "批次必须是对象", { received: String(raw) });
  }
  const obj = raw as Record<string, unknown>;
  const ref = obj.ref;
  if (typeof ref !== "string" || ref.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "批次标识 ref 必须是非空字符串", { field: "ref" });
  }
  const k = validateCount("k", obj.k);
  const n = validateCount("n", obj.n);
  if (n > MAX_BATCH_N) {
    throw new AppError("VALIDATION_ERROR", `单批 n 不得超过 ${MAX_BATCH_N}`, { field: "n", n });
  }
  if (k > n) {
    throw new AppError("VALIDATION_ERROR", "k 必须小于等于 n", { field: "k", k, n });
  }
  return { ref: ref.trim(), k, n };
}

export function requireString(field: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new AppError("VALIDATION_ERROR", `${field} 必须是非空字符串`, { field });
  }
  return v.trim();
}

export function parseConfidence(v: unknown): 0.9 | 0.95 | 0.99 {
  if (typeof v === "string") {
    if (v === "0.9" || v === "0.90") return 0.9;
    if (v === "0.95") return 0.95;
    if (v === "0.99") return 0.99;
  }
  if (!isValidConfidence(v)) {
    throw new AppError("VALIDATION_ERROR", "置信度仅支持 0.9 / 0.95 / 0.99", { received: String(v) });
  }
  return v;
}
