import * as path from "node:path";
import { Store } from "./store";
import { createServer, listenFree } from "./server";

export function defaultDbPath(): string {
  return process.env.WILSON_DB_PATH ?? path.join(process.cwd(), "data", "wilson.db");
}

if (require.main === module) {
  const argPort = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const preferredPort = argPort ? Number(argPort) : envPort;
  const store = new Store(defaultDbPath());
  const server = createServer(store);
  listenFree(server, Number.isFinite(preferredPort) ? preferredPort : undefined)
    .then((port) => {
      console.log(`Wilson 二项比例汇总服务已启动`);
      console.log(`监听: http://127.0.0.1:${port}`);
      console.log(`数据库: ${defaultDbPath()}`);
      console.log(`可配置端口: --port=8080 或环境变量 PORT；默认选择空闲端口`);
    })
    .catch((err: Error) => {
      console.error("启动失败:", err.message);
      process.exit(1);
    });
}
