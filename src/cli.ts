import { openDb } from "./db";
import { Service } from "./service";
import { startServer } from "./server";
import { WilsonResult } from "./wilson";

function fmtPct(x: number | null): string {
  return x === null ? "  null " : (x * 100).toFixed(4).padStart(7) + "%";
}

function printRow(label: string, k: number, n: number, r: WilsonResult): void {
  console.log(
    `${label.padEnd(14)} k=${String(k).padStart(3)} n=${String(n).padStart(3)}  比例=${fmtPct(r.proportion)}  区间=[${fmtPct(r.lower)}, ${fmtPct(r.upper)}]  置信度=${r.confidence}%  z=${r.z}  状态=${r.status}`,
  );
}

function runDemo(): void {
  const service = new Service(openDb(":memory:"));
  const ds = service.createDataset("演示数据集");
  service.addBatches(ds.id, [
    { batchKey: "A", metricName: "转化率", metricVersion: "v1", k: 1, n: 10 },
    { batchKey: "B", metricName: "转化率", metricVersion: "v1", k: 9, n: 90 },
    { batchKey: "C-zero", metricName: "全失败", metricVersion: "v1", k: 0, n: 10 },
    { batchKey: "D-full", metricName: "全成功", metricVersion: "v1", k: 10, n: 10 },
    { batchKey: "E-empty", metricName: "无数据", metricVersion: "v1", k: 0, n: 0 },
  ]);

  console.log("== 单批 Wilson 区间（95%）==");
  const p = service.preview(
    [
      { batchKey: "A", metricName: "转化率", metricVersion: "v1", k: 1, n: 10 },
      { batchKey: "B", metricName: "转化率", metricVersion: "v1", k: 9, n: 90 },
      { batchKey: "half", metricName: "x", metricVersion: "v1", k: 5, n: 10 },
      { batchKey: "C-zero", metricName: "全失败", metricVersion: "v1", k: 0, n: 10 },
      { batchKey: "D-full", metricName: "全成功", metricVersion: "v1", k: 10, n: 10 },
      { batchKey: "E-empty", metricName: "无数据", metricVersion: "v1", k: 0, n: 0 },
    ],
    95,
  );
  for (const row of p) printRow(row.batchKey, row.k, row.n, row.result);

  console.log("\n== 合并分析（95%，按计数相加后重算，不平均区间）==");
  const { report } = service.analyze(ds.id, 95);
  for (const m of report.metrics) {
    console.log(`\n指标: ${m.metricName} (口径 ${m.metricVersion})`);
    for (const b of m.includedBatches) printRow(`  ${b.batchKey}`, b.k, b.n, b.result);
    for (const b of m.excludedZeroBatches) {
      console.log(`  ${b.batchKey.padEnd(14)} k=${b.k} n=${b.n}  零样本批次，不贡献合并分母`);
    }
    printRow("  合并", m.totals.k, m.totals.n, m.merged);
    console.log(
      `  公式中间量: p=${m.merged.proportion}, z^2=${m.merged.zSquared}, d=${m.merged.denominator}, c=${m.merged.center}, h=${m.merged.halfWidth}`,
    );
  }
  console.log("\n注意：1/10 与 9/90 合并为 10/100 后重算区间，而不是把两份区间取平均。");
  console.log("区间不是下一批成功率的保证；合并前提是各批独立且口径一致。");
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const argValue = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case "serve": {
      const port = Number(argValue("--port") ?? process.env.PORT ?? 0);
      const dbPath = argValue("--db");
      const service = new Service(openDb(dbPath));
      const { port: actual } = await startServer(service, port);
      console.log(`服务已启动: http://127.0.0.1:${actual} （Ctrl+C 停止）`);
      break;
    }
    case "demo":
      runDemo();
      break;
    case "export": {
      const id = Number(argValue("--analysis"));
      const format = argValue("--format") ?? "json";
      const service = new Service(openDb(argValue("--db")));
      if (format === "csv") console.log(service.exportAnalysisCsv(id));
      else console.log(JSON.stringify(service.getAnalysis(id), null, 2));
      break;
    }
    default:
      console.log(`用法:
  node dist/src/cli.js serve [--port 8080] [--db 路径]   启动 API 服务（默认自动选空闲端口）
  node dist/src/cli.js demo                              运行内置演示
  node dist/src/cli.js export --analysis <id> [--format csv|json] [--db 路径]`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
