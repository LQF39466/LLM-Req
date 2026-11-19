[English](README.en.md) · [Agent Guide](AGENT.md)

# 本地 LLM 批量请求服务（LLM Jobs）

一个跑在你自己电脑上的 **LLM 批量任务管家**——专门拯救那些在 429 限流里反复横跳、动不动崩溃、每次重跑都得从第 1 行含泪重来的批处理脚本。

只需要 **Node.js 24+**，无需 Redis 或外部数据库。每条进度实时保存（默认 `data/jobs.sqlite`），服务会自动试探最佳并发、分类处理报错，并附带一个本地网页控制台（`http://127.0.0.1:3210`）。

> **能力边界与安全**：仅用于单轮/多轮文本或图片生成，以及 OpenCode System One 决策任务——**不跑** Agent 循环、自动工具调用、生图或厂商异步 Batch API。只监听 `127.0.0.1`，密钥仅读本地环境变量，**切勿暴露公网**。

---

## 核心特性

- **耐摔耐重启**：每完成一条立刻落盘；`Ctrl+C` 或意外重启后自动接着跑（手动暂停的任务保持暂停）。
- **多平台同一套写法**：内置 `openai`、`anthropic`、`google`、`deepseek`、`mimo`、`bailian`、`opencode`，也可在 `.env` 配自定义或本地服务（`LLM_LOCAL_BASE_URL`），统一支持 `thinking` 开关与可选 `logprobs`。
- **大批量与横向对比**：单 Job 支持最多 **10 万条、1000 批次（`batches`）**；支持多轮 `messages`、图片（Base64 或 HTTPS）、System One 决策（`jev-1.13` / `gemini-decision-1`）及流式 JSONL 上传。
- **防手抖重复扣费**：可选 `submissionKey`（Python 里为 `submission_key`）。提交断网不确定是否成功时，拿同一个 key 再发一次会直接返回原 Job ID，绝不重跑两遍。
- **本地控制台收尾**：网页端可看总览、「需要关注」清单、各平台实时并发/冷却状态、Token 与厂商**实际返回**的费用（不瞎估算），支持单条或跨页批量改配、重试、跳过、标记拒答和导出 JSONL。（*提交任务请走 Python 或 HTTP，网页只负责盯和修。*）

---

## 快速上手

### 1. 启动服务

```sh
npm ci
cp .env.example .env
# 填上你要用到的平台密钥，不用的留空
npm start
```

浏览器打开 `http://127.0.0.1:3210`；退出按 `Ctrl+C`。一个数据库文件同一时间只能由一个进程独占，多开请另设 `PORT` 和 `DB_PATH`。

### 2. 提交任务（推荐 Python 客户端）

零第三方依赖，直接复用 [examples/python_client.py](examples/python_client.py)（完整脚本见 [examples/submit_job.py](examples/submit_job.py)）：

```python
from python_client import LLMJobs

client = LLMJobs("http://127.0.0.1:3210")
job_id = client.submit(
    name="批量摘要",
    submission_key="dataset-2026-001",
    config={"provider": "deepseek", "model": "deepseek-flash", "maxOutputTokens": 2048, "thinking": "off"},
    queries=["用一句话解释 SQLite WAL。", "什么是指数退避？"],
)

status = client.wait(job_id)  # 等到完成、暂停或需要人工干预时返回
for item in client.results(job_id):
    print(item["query_id"], item["state"], item["result"])
```

- **自定义 ID 与透传字段**：`queries` 元素可写 `{"id": "row-1", "prompt": "...", "metadata": {...}}`；需要多轮或图片时改用 `messages`（图片放 `data:image/...;base64,...` 或 HTTPS 地址，System One 仅支持文本 `prompt`）。
- **多模型对比**：改用 `batches`，为每组模型配独立 `id` 和 `config`，格式见 [examples/job.json](examples/job.json) 和 [examples/openai-job.json](examples/openai-job.json)。
- **大数据集流式上传**：往 `submit()` 传 generator，或直接 `client.submit_file("job.jsonl")`（格式见 [examples/job.jsonl](examples/job.jsonl)），不撑爆内存。
- **`submission_key` 原则**：怀疑超时丢包用**原 key** 确认，改了数据或参数务必换**新 key**。
- **直接 `curl`**：

```sh
curl --fail-with-body http://127.0.0.1:3210/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"config":{"provider":"deepseek","model":"deepseek-flash"},"queries":["用一句话解释 SQLite WAL。","什么是指数退避？"]}'
```

### 3. 常用配置

```json
{
  "provider": "bailian",
  "model": "qwen-plus",
  "maxOutputTokens": 4096,
  "temperature": 0.7,
  "thinking": "off"
}
```

- **内置 `provider`**：`openai`、`anthropic`、`google`、`deepseek`、`mimo`、`bailian`、`opencode`。连本地/兼容服务（如 vLLM、Ollama）只需在 `.env` 加 `LLM_LOCAL_BASE_URL=http://127.0.0.1:8000/v1`（有鉴权再配 `LLM_LOCAL_API_KEY`），配置里写 `"provider": "local"`，并发独立计数。
- **`thinking`**：`"off"` 关闭思考，或设为 `minimal / low / medium / high / xhigh / max`；省略则用平台默认。遇到不支持的档位会在预检直接拦截，绝不偷偷降级。
- **`stream: false`**：仅返回整包 JSON 的非流式模型使用（默认流式）。
- **`logprobs: true`**：可选配 `topLogprobs`，在支持的 OpenAI / Chat / Responses 模型上采集逐 Token 概率。
- **`protocol`**：一般不用填，仅用于覆盖默认协议（如 OpenAI 改用 `"chat"`，或覆盖 OpenCode 自动路由）。
- **`questions`**：专用于 OpenCode System One 决策模型（`jev-1.13` / `gemini-decision-1`），配在 `config` 中，待判文本放 `query.prompt`。
- **`timeout`**：默认连接 60 秒、流空闲 5 分钟、总时限 30 分钟，可按批次覆盖 `{"connectMs", "idleMs", "totalMs"}`。
- **`extraBody` / `providerOptions`**：透传厂商原生字段的逃生舱。

### 4. 获取结果

Python 用 `client.wait(job_id)` + `client.results(job_id)`；或在网页控制台等状态变为 `completed` 后点击 **导出 JSONL** 获取最终快照（每行含原始输入、最终状态、生成结果、用量/费用及完整尝试历史）。

---

## 并发与重试机制

把下面三步装进脑子，你就知道它在后台「是真卡了，还是在礼貌地踩刹车」。

1. **先发 1 条探路（预检）**
   每组独立配置会先抽 **1 条真实请求**试跑（会正常计费）。成功则直接复用结果、不再重跑，随后放开并发；若遇到 Key 错、模型错或不支持的参数，整个 Job 立刻停在 `preflight_blocked`，省得十万条一起排队送死。

2. **自适应并发（慢起步、撞限流缩窗、稳住再回血）**
   - **隔离范围**：`opencode` **按模型**独立限流，其余平台**按 Provider** 共享限流；多任务公平轮询调度，学习到的状态跨重启保留。
   - **提速**：新通道从 **4 并发**试探，窗口跑满且无错就翻倍（4 → 8 → 16 → 32 → 默认上限 `PROBE_MAX_CONCURRENCY=64`，全局上限 `GLOBAL_CONCURRENCY=128`）。
   - **刹车**：同一波并发撞上 429 只算一次降速——上限缩为当前观测并发的 **70%**（最低 1），并进入冷却（遵守 `Retry-After`，默认 **60 秒**）；连续撞限流会拉大发车间隔。
   - **回血**：冷却后需**连续成功至少 10 次且稳定满 60 秒**，先将发车间隔减半回落，间隔恢复后再以每次 **+1** 慢慢加回并发。

3. **错误分类与重试规则**

| 情况 | 自动动作 | 计入「最多 3 次」上限？ |
| --- | --- | --- |
| **429 限流** | 冷却 60 秒（或 `Retry-After`）后自动重试 | **不计入**（连续免费重试满 **20 次**后挂起） |
| **确定未发出**（DNS / 拒绝连接 / 连接超时） | 暂停该通道 **5 分钟**后自动重试 | **不计入**（同样满 **20 次**后挂起） |
| **临时故障**（5xx / 网关偶发错误） | 几秒级指数退避；连续 3 次暂停该通道 **60 秒** | **计入**（含预检最多 **3 次**有效尝试） |
| **发出后中断**（读超时 / 断流 / 进程关闭或崩溃） | 等 **5 分钟**后**最多自动补发 1 次**；第 2 次中断直接挂起 | **计入**（且中断最多只容忍 1 次自动重试） |
| **内容审核拦截** | 直接标记 **`succeeded`**（附 `contentFiltered: true` 与部分文本），不重试、不卡任务 | —（消费结果时注意检查标记） |
| **硬伤**（缺 Key / 鉴权失败 / 欠费 / 参数或模型错 / 超长截断 / 空文本 / 未知错误） | **立即挂起（`held`）**，不瞎重试烧钱 | 缺 Key 不耗次数，其余立即挂起 |

> **实话实说**：每条结果写稳落盘前绝不标成功，正常报错也会保留已收到的部分文本；但若模型刚算完回传时断网、或写库瞬间断电，上游又没法查询旧结果，那次谨慎的重发仍**可能**多扣一次费。控制台账单只累加 API **实际返回**的金额与 Token，绝不凭空估算。

---

## 什么时候需要你干预

**不用管**：正常跑批中、处于 60 秒 / 5 分钟冷却期、偶发 5xx 退避重试、内容审核拦截、或者重启服务后自动续跑。

**需要上网页（`http://127.0.0.1:3210`）动手**：当 `client.wait()` 返回或总览出现 **「需要关注」** 时：

- **`preflight_blocked`（探路失败）**：缺 Key 时补好 `.env` 直接点 **「恢复派发」**（热加载密钥，**无需重启**）；模型或参数写错则在网页改配后重试。
- **`needs_attention`（跑完留有挂起项）**：筛选「挂起」看诊断即可——
  - 缺 Key → 改完 `.env` 点 **「恢复派发」**或**「重试」**（地址、并发等非密钥环境变量仍需重启）；
  - 欠费 → 充值后选中或选「当前筛选全部（跨页）」点 **「批量重试」**；
  - 输出被截断（`maxOutputTokens` 太小）或参数不兼容 → 点 **「批量改配并重试…」**（改配后会先预检，重试可能新计费）；
  - 单条顽疾 / 耗尽 3 次 → 点开看输入与尝试时间线，可选 **「保存并重试」**、**「跳过」**（清零后自动完成），或 **「标记拒答并算作成功」**（写入 `manualRefusal: true` 与 `"I cannot answer."`，不调 API）。
- **不想等冷却**：确认网络或额度恢复后点 **「恢复派发」**，立刻解除冷却并保留已探测到的并发上限。
- **红色存储警报 / 启动锁冲突**：磁盘满时服务会自动停派发，腾空间后重启；若崩溃残留数据库锁，确认无旧进程后删掉 `data/` 下的 `.lock` / `.lock.reclaim` 再启。
- **日常操作提醒**：**暂停**会让在途请求自然收尾；**删除**运行中任务需先暂停并等在途清零；**备份**请先 `Ctrl+C` 停服再拷贝整个 `data/` 目录（内含完整输入输出，请妥善保管）。

---

## 参考

- 环境变量与并发调优：[.env.example](.env.example)
- Python 客户端与示例：[examples/python_client.py](examples/python_client.py)、[examples/submit_job.py](examples/submit_job.py)、[examples/job.json](examples/job.json)、[examples/job.jsonl](examples/job.jsonl)、[examples/openai-job.json](examples/openai-job.json)
- AI Agent 提交与监听规范：[AGENT.md](AGENT.md)
- 本地自测（全模拟接口，不花钱）：`npm test`
