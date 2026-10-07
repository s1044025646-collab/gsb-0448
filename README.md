# Wilson 二项比例区间与计数合并核验后端（TypeScript + Node.js + SQLite）

本地运行的**纯后端**服务（HTTP API + CLI），用于导入多个批次的成功次数 `k` 与总次数 `n`，
计算每批与指定指标合并后的成功比例及 **Wilson score 双侧置信区间（无连续性修正）**，
并保留可核验的原始计数、批次修订历史与冻结分析快照。

- **不做**显著性检验、两组因果比较、分类器训练或任何真实医疗判断。
- 每个观测只有成功 / 失败两种结果；**试验口径一致性需使用者自行保证**。
- 不依赖 Docker、WSL、付费服务或任何外部在线 API。

## 适用前提（重要）

- 每个观测为伯努利结果（成功/失败），同一指标下各批次的成功定义、纳排规则等**口径必须一致**。
- 合并在「各批次相互独立、口径一致」时才按二项模型解释；本服务**不会也不能消除批次间相关性**，
  批次相关、聚类或分层数据请使用者另行评估。
- Wilson 区间刻画的是**给定计数下真实成功比例的不确定性**，**不是对下一批成功率的保证或预测区间**。

## 算法（自行实现，无连续性修正）

固定支持 90% / 95% / 99% 三种置信度，直接使用公开的标准正态分位数常数，**不实现逆正态求值器**：

| 置信度 | z |
| --- | --- |
| 90% | 1.6448536269514722 |
| 95% | 1.959963984540054 |
| 99% | 2.5758293035489004 |

对一批计数 `k / n`（`n > 0`）：

```
p = k / n
d = 1 + z^2 / n
c = (p + z^2 / (2n)) / d                    （中心）
h = z * sqrt( p(1-p)/n + z^2/(4n^2) ) / d   （半宽）
区间 = [c - h, c + h]
```

这**不是**普通正态近似 `p ± z*sqrt(p(1-p)/n)`，也不对各批区间取平均。
仅对接近 0/1 的结果吸收小于 `1e-12` 的浮点舍入误差，不做宽泛裁剪。
算法版本号记录为 `wilson-score-1.0`，报告中同时保存使用的 `z`。

### 无数据 `n = 0`

`p、d、中心、半宽、下界、上界` 全部返回 `null`，状态为 `no_data`；
**不会**返回 0、`[0,0]` 或 `NaN`。零样本批次可出现在清单中，但被列入「排除的零样本批次」，
不贡献合并分母。

### 固定基准（95%）

| 计数 | 区间（约） |
| --- | --- |
| 0/10  | `[0, 0.2775328]` |
| 10/10 | `[0.7224672, 1]`（与 0/10 关于 0.5 对称） |
| 5/10  | `[0.2365931, 0.7634069]` |
| 合并 (1/10)+(9/90) = 10/100 | `[0.0552291, 0.1743657]`（重新计算，非区间平均） |

测试中以上数值采用**独立硬编码预期值**、以容差 `1e-6` 比较，不由本项目核心函数生成预期。

## 输入规则（公开且一致）

- `k`、`n` 必须是 **number 类型的非负安全整数**（`Number.isSafeInteger`）。
- **数字字符串（如 `"10"`）一律拒绝**，不做隐式转换；布尔值、`null`、`NaN`、`Infinity`、小数、负数均拒绝。
- 必须满足 `k <= n`；单批 `n <= 10,000,000`；合并总和不得超过安全整数范围。
- 批次标识 `ref` 为非空字符串（自动去除首尾空白）。
- 每个批次绑定 `metric`（指标名）与 `caliber_version`（口径版本）；
  **同名指标的不同口径版本拒绝合并**（`CALIBER_CONFLICT`）；修订已存在批次时改变指标/口径同样被拒绝。
- 批量录入在单个事务内完成：**任一条失败则整批回滚，不留半份成功数据**；请求体内 `ref` 重复也直接失败。

## 修订与可核验性

- 批次永不物理改写：再次提交相同 `ref` 会生成 `revision + 1` 的新修订，历史保留在 `batch_revisions`。
- 分析创建时把完整结果（逐批计数、公式中间量、z、算法版本、排除清单）**冻结为 JSON 快照**存入 `analyses`。
- 之后修订某批次**不会影响历史报告**；需基于新计数重新创建分析。
- 幂等：写请求带 `X-Request-Id` 头或请求体 `request_id`，重复 ID 返回**原分析结果**（`replayed: true`），不重复计算/写入。
- 批次按 `ref` 去重后分别相加 `k`、`n` 再重算区间；**不平均比例，不平均上下界**；输入顺序不影响数值，输出按 `ref` 排序规范化。

## 环境要求

- Windows 本地；Node.js >= 20（开发使用 v25）；npm。
- SQLite 通过 `better-sqlite3`（随 `npm install` 获取预编译二进制）提供，无需单独安装。
- 数据默认存于项目内 `data/wilson.db`，可用环境变量 `WILSON_DB_PATH` 覆盖。

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 编译并运行 node:test（23 个测试）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # CLI 内置演示（原计数、比例、区间、置信度、公式项）
npx tsx src/cli.ts interval 0 10 0.95   # 直接算单个区间
```

启动后控制台打印实际监听地址。指定端口：

```powershell
node dist/main.js --port=8080
$env:PORT=8080; node dist/main.js
```

## HTTP API

所有请求/响应为 JSON。错误统一为 `{ "error": <错误码>, "message": ..., "details": ... }`。

### 错误码

| HTTP | error | 含义 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `VALIDATION_ERROR` | 计数/字段不合法（负数、小数、字符串、k>n、超范围等） |
| 400 | `DUPLICATE_BATCH_REF` | 请求内批次标识重复 |
| 409 | `CALIBER_CONFLICT` | 同名指标存在不同口径版本，拒绝合并/修订 |
| 404 | `NOT_FOUND` | 数据集/分析/路由不存在 |
| 500 | `INTERNAL_ERROR` | 内部错误 |

幂等命中（重复 `request_id`）返回 **200** 且带 `replayed: true` 与原始分析 ID，不重复写入。

### 端点

- `GET  /health`
- `POST /api/datasets` — `{ "name": "..." }`
- `GET  /api/datasets/:id`
- `POST /api/datasets/:id/batches` — 单条 `{ metric, caliber_version, batch: {ref,k,n} }`
  或批量 `{ metric, caliber_version, batches: [...] }`；可带 `request_id`
- `POST /api/datasets/:id/validate-preview` — 只校验/预览（标注是否会产生新修订、口径预警），**不写库**
- `GET  /api/datasets/:id/batches`
- `POST /api/datasets/:id/analyses` — `{ metric, confidence: 0.9|0.95|0.99 }`，冻结快照；可带 `request_id`
- `GET  /api/datasets/:id/analyses` — 分析清单
- `GET  /api/analyses/:id` — 完整冻结快照（含 `merged_terms` 公式项）
- `GET  /api/analyses/:id/export?format=json|csv` — 导出（CSV 含 batch / excluded_zero_n / merged 行）

### PowerShell 调用示例

```powershell
$ds = Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body '{"name":"demo"}' http://127.0.0.1:8080/api/datasets
$id = $ds.dataset.id
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body (@{
  metric = 'accuracy'; caliber_version = 'v1'
  batches = @(
    @{ ref = 'A'; k = 1; n = 10 },
    @{ ref = 'B'; k = 9; n = 90 },
    @{ ref = 'EMPTY'; k = 0; n = 0 }
  )
} | ConvertTo-Json) "http://127.0.0.1:8080/api/datasets/$id/batches"
Invoke-RestMethod -Method Post -ContentType 'application/json' `
  -Body '{"metric":"accuracy","confidence":0.95}' `
  "http://127.0.0.1:8080/api/datasets/$id/analyses"
```

分析快照关键字段：`included_batches`（含每批 ref/revision/k/n/failures/p/区间）、
`excluded_zero_n_batches`、`totals`（总成功/总失败/比例）、
`merged_terms`（`p,z,d,center,halfWidth,lower,upper,status` 等公式中间量）、
`algorithm`、`caveat`。

## CLI 演示

`npm run demo` 同时打印**原始计数、未舍入比例、区间上下界、置信度、z、中心、半宽与 d**，
百分比仅用于展示（四舍五入），保存与比较一律使用未舍入数值。演示覆盖：
1/10 与 9/90 合并为 10/100、0/10、10/10、0/0、5/10，以及 90%/95%/99% 区间对比。

## 数据库表

- `datasets`：数据集
- `batches`：每个 `(dataset_id, ref)` 的当前修订
- `batch_revisions`：批次全部历史修订（不可变）
- `analyses`：冻结分析（完整 JSON 快照、置信度、口径、幂等 request_id）
- `request_log`：幂等请求日志（预留）

## 限制与边界

- 仅做后端，无界面、无鉴权，仅监听 `127.0.0.1`。
- 不处理批次相关性 / 过度离散 / 分层效应；不做多重比较与显著性检验。
- 百分比展示的四舍五入仅用于阅读，不参与任何计算或比较。
