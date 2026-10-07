#!/usr/bin/env node
// CLI：内置演示与简单的单区间计算。
// 演示同时显示原始计数、比例、区间与置信度，不只输出一个百分数。
import { Confidence, wilsonTerms, formatPercent, ALGORITHM_VERSION } from "./wilson";
import { parseConfidence } from "./validation";

function printRow(label: string, k: number, n: number, conf: Confidence): void {
  const t = wilsonTerms(k, n, conf);
  if (t.status === "no_data") {
    console.log(`${label}: k=${k}, n=${n} -> 无数据（比例与区间均为 null，状态 no_data）`);
    return;
  }
  console.log(
    `${label}: ${k}/${n}  成功率 ${formatPercent(t.p, 4)} (原始 p=${t.p})`
  );
  console.log(
    `    ${(conf * 100).toFixed(0)}% Wilson [${t.lower}, ${t.upper}]  百分比 [${formatPercent(t.lower, 4)}, ${formatPercent(t.upper, 4)}]  中心=${t.center} 半宽=${t.halfWidth}  d=${t.d}`
  );
}

export function runDemo(): void {
  console.log("=== Wilson 二项比例合并核验演示 ===");
  console.log(`算法: ${ALGORITHM_VERSION}（无连续性修正）`);
  console.log("z 常数: 90%=1.6448536269514722, 95%=1.959963984540054, 99%=2.5758293035489004\n");

  console.log("--- 单批区间（95%）---");
  printRow("批次 A", 1, 10, 0.95);
  printRow("批次 B", 9, 90, 0.95);

  console.log("\n--- 合并：按计数相加后重新计算（不是平均比例/平均区间）---");
  printRow("A+B 合并 (1+9)/(10+90)", 10, 100, 0.95);

  console.log("\n--- 零成功 / 全成功 / 无数据（95%）---");
  printRow("0/10", 0, 10, 0.95);
  printRow("10/10", 10, 10, 0.95);
  printRow("0/0", 0, 0, 0.95);

  console.log("\n--- 5/10（95%）---");
  printRow("5/10", 5, 10, 0.95);

  console.log("\n--- 提高置信度：区间不收窄 ---");
  printRow("5/10 @90%", 5, 10, 0.9);
  printRow("5/10 @95%", 5, 10, 0.95);
  printRow("5/10 @99%", 5, 10, 0.99);

  console.log("\n说明：Wilson 区间描述给定计数下比例的不确定性，不是下一批成功率的保证；");
  console.log("合并仅在各批次相互独立、指标与口径一致时适用，不消除试验相关性。");
}

function main(argv: string[]): void {
  const cmd = argv[0] ?? "help";
  if (cmd === "demo") return runDemo();
  if (cmd === "interval") {
    const k = Number(argv[1]);
    const n = Number(argv[2]);
    const conf = parseConfidence(argv[3] ?? 0.95);
    if (!Number.isSafeInteger(k) || !Number.isSafeInteger(n) || k < 0 || n < 0 || k > n) {
      console.error("用法: interval <k> <n> [0.9|0.95|0.99]；要求非负整数且 k<=n");
      process.exit(2);
    }
    printRow(`${k}/${n}`, k, n, conf);
    return;
  }
  console.log("用法:");
  console.log("  wilson-cli demo                     运行内置演示");
  console.log("  wilson-cli interval <k> <n> [conf]  计算单个 Wilson 区间");
}

if (require.main === module) {
  main(process.argv.slice(2));
}
