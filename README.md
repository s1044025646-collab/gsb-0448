# Wilson 区间与计数合并核验后端

本地可运行的二项比例 Wilson score 区间计算与多批次计数合并服务。仅提供 HTTP API 与 CLI，无前端。技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`）+ SQLite，不依赖 Docker、WSL 或任何外部在线服务。

## 适用前提与限制（重要）

- 每个观测只有成功/失败两种结果；**用户需自行保证各批次试验口径一致**。
- 合并的前提是各批次**相互独立**且口径相同。本服务只做计数相加与区间重算，**不消除、也不检测试验间的相关性**。
- 不做显著性检验、不做两组因果比较、不做分类器训练、不做任何真实医疗判断。
- 置信区间是对总体比例的一种区间估计，**不是下一批成功率的保证**。

## 算法

无连续性修正的 Wilson score 区间（算法版本 `wilson-score@1.0.0`，记录在每份报告快照中）：

```
p = k/n,  d = 1 + z²/n
c = (p + z²/(2n)) / d
h = z · sqrt(p(1-p)/n + z²/(4n²)) / d
区间 = [c - h, c + h]
```

固定支持三种置信度，z 取公开常数（不另写逆正态求值器）：

| 置信度 | z |
|---|---|
| 90% | 1.6448536269514722 |
| 95% | 1.959963984540054 |
| 99% | 2.5758293035489004 |

边界处理：`k=0` 时下界精确为 0，`k=n` 时上界精确为 1；仅吸收 误差绝对值 ≤ 1e-12 的浮点舍入，不做宽泛裁剪。显示百分比可四舍五入，存储与比较一律使用未舍入的数值。

## 计数与校验规则

- `k`、`n` 必须是非负安全整数；**数字字符串、小数、负数一律拒绝**（单条与批量规则一致）。
- 必须 `k ≤ n`；单批 `n ≤ 10,000,000`；合并总和超出安全整数范围时报错。
- `n = 0` 表示无数据：比例与区间均为 `null`，状态 `no_data`。零样本批次会列在报告中，但**不贡献合并分母**。
- 批量录入是单事务：任一条失败整体回滚，不留半份数据。

错误码：`INVALID_INTEGER`、`NEGATIVE_COUNT`、`K_GT_N`、`N_TOO_LARGE`、`INVALID_CONFIDENCE`、`INVALID_BATCH`、`DUPLICATE_BATCH_KEY`、`EMPTY_BATCH_LIST`、`METRIC_VERSION_CONFLICT`、`NO_BATCHES`、`SUM_OVERFLOW`、`DATASET_NOT_FOUND`、`ANALYSIS_NOT_FOUND`、`INVALID_JSON`、`INVALID_FORMAT`、`NOT_FOUND`。

## 合并与不可变性

- 合并按批次 ID（`batchKey`）去重，取最新修订，分别相加 `k` 与 `n` 后**重新计算区间**；不平均比例，也不平均各批上下界。输入批次顺序不影响数值与输出（输出按 `batchKey` 排序）。
- 每个批次绑定 `metricName` + `metricVersion`；同名指标出现不同版本时**明确拒绝合并**（`METRIC_VERSION_CONFLICT`）。
- 修改某批计数 = 插入新修订（`revision_no` 递增），历史批次行不改写；新分析自动选择最新修订。
- 分析报告冻结为快照存入 SQLite，不可改写；切换置信度生成新报告。
- 创建数据集、录入批次、冻结分析均接受 `requestId`：重复请求 ID 幂等返回首次结果。

## 构建、测试、启动、演示

```bat
npm install
npm run build      :: 编译 TypeScript 到 dist/
npm test           :: 构建并运行全部测试
npm start          :: 启动 API 服务（默认自动选择空闲端口）
npm run demo       :: 内置演示（1/10、9/90、5/10、0/10、10/10、0/0）
```

CLI 直接用法：

```bat
node dist/src/cli.js serve [--port 8080] [--db 数据文件路径]
node dist/src/cli.js demo
node dist/src/cli.js export --analysis <id> [--format csv|json] [--db 路径]
```

端口优先级：`--port` > 环境变量 `PORT` > `0`（操作系统分配空闲端口，启动后打印实际端口）。数据默认保存在项目内 `data/wilson.db`。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/datasets` | 创建数据集 `{name, requestId?}` |
| POST | `/datasets/:id/batches` | 录入批次：单条对象或 `{batches:[...], requestId?}` |
| POST | `/datasets/:id/batches/preview` | 预览校验（不写库）`{batches:[...], confidence}` |
| GET | `/datasets/:id/batches` | 列出最新修订的批次 |
| POST | `/datasets/:id/analyses` | 冻结分析 `{confidence, requestId?}` |
| GET | `/analyses/:id` | 查看报告（含公式中间量 p、z²、d、c、h） |
| GET | `/analyses/:id/export?format=json 或 csv` | 导出报告 |

批次对象字段：`{batchKey, metricName, metricVersion, k, n}`。

示例：

```bat
curl -X POST http://127.0.0.1:端口/datasets -H "content-type: application/json" -d "{\"name\":\"demo\"}"
curl -X POST http://127.0.0.1:端口/datasets/1/batches -H "content-type: application/json" -d "{\"batches\":[{\"batchKey\":\"A\",\"metricName\":\"m\",\"metricVersion\":\"v1\",\"k\":1,\"n\":10},{\"batchKey\":\"B\",\"metricName\":\"m\",\"metricVersion\":\"v1\",\"k\":9,\"n\":90}]}"
curl -X POST http://127.0.0.1:端口/datasets/1/analyses -H "content-type: application/json" -d "{\"confidence\":95}"
```

## 演示要点

- `1/10` 与 `9/90` 合并为 `10/100` 后重算区间（95% 下约 `[0.0552, 0.1744]`），而不是把两份区间取平均。
- `0/10`（95%）区间约 `[0, 0.2775328]`；`10/10` 与它关于 0.5 对称，约 `[0.7224672, 1]`；`5/10` 约 `[0.2365931, 0.7634069]`。
- `0/0` 返回 `null` 与 `no_data`，绝不返回 0、`[0,0]` 或 NaN。

## 测试

`npm test` 覆盖：三种置信度、无数据、全成功/全失败、合并去重与顺序无关、口径冲突、非法批次（负数/小数/字符串/k大于n/超限）、批量回滚、幂等 requestId、修订与历史快照不变、重启后读取、CSV 导出；并对小范围全部 `(k,n)` 枚举检查有限性、边界与“比例落在区间内”，以及成功/失败互换对称性 `[1-U, 1-L]`。固定基准值独立给出，用容差比较，不依赖本项目核心函数生成。

## 已知限制

- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 无鉴权，仅监听 `127.0.0.1`，供本机使用。
- 单批 `n` 上限一千万；超大规模数据请分批。
