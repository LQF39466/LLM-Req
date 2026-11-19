# 本地 LLM 批量请求服务

Node.js 24 + AI SDK 6 + SQLite。纯 JavaScript，无构建步骤、Redis 或外部数据库。支持 OpenAI 官方 API、DeepSeek、Xiaomi MiMo、阿里百炼和 OpenCode 当前按量推理接口。

## 启动

```sh
npm ci
cp .env.example .env
# 编辑 .env，填写所需平台密钥；不使用的平台可留空
npm start
```

打开 http://127.0.0.1:3210。只监听本机，拒绝跨站 Origin 和非本地 Host。密钥仅从服务端环境变量读取。不要将服务通过反向代理暴露公网。

Node 24 内置 SQLite；启动前获取数据库独占进程锁，同一数据库不能被不同端口的两个服务同时调度。退出用 Ctrl+C。默认数据路径 `data/jobs.sqlite`，可用 `DB_PATH` 修改。

## 提交 Job

小任务可以使用 `examples/job.json`，大任务推荐 JSONL（`examples/job.jsonl`）。示例中的模型 ID 请按实际账号权限调整。提交会立即产生真实预检请求和费用。

```sh
curl --fail-with-body http://127.0.0.1:3210/api/jobs \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @examples/job.jsonl
```

前端不提供 Job 提交功能，只展示状态、导出与处置错误。推荐通过下述 Python 客户端提交。一个 Job 最多 100000 条、1000 批次；JSON 上传上限 16MiB，JSONL 上限 512MiB，单行上限 2M 字符。流式分批导入，全部校验提交之前不会执行。失败或中断的导入会清理；进程崩溃留下的导入在启动恢复时清理。

JSON 格式：每个 `batches[]` 包含 `id`、`config` 和 `queries`。
JSONL 格式：首行为 `{ name, submissionKey, batches: [{ id, config }] }`，后续每行 `{ id, batch, prompt }` 或 `{ id, batch, messages }`。可带 `metadata`。

`query.id` 在 Job 内唯一，不按 prompt 内容去重。可选 `submissionKey` 在数据库内唯一；重复提交会被拒绝并返回原 Job ID，防止客户端响应丢失后意外再次执行。修改内容后要使用新提交键。

### 图片输入

在 `query.messages` 的用户消息里放入 `text` 和 `image` 内容块。将以下代码生成的 `query` 放进 JSON Job 的 `batches[].queries`，或加上 `batch` 后作为 JSONL 的一行提交。

```python
from base64 import b64encode
from pathlib import Path

image = b64encode(Path("photo.png").read_bytes()).decode("ascii")
query = {
    "id": "photo-1",
    "messages": [{
        "role": "user",
        "content": [
            {"type": "text", "text": "这张图里有什么？"},
            {"type": "image", "image": f"data:image/png;base64,{image}"},
        ],
    }],
}
```

同一条用户消息可以放多张图片。也可以把 `image` 的值设为可访问的 HTTPS 图片地址，具体由适配器决定是转发地址还是下载图片。请选择支持视觉输入的模型。System One 只接受文本 `query.prompt`。内嵌图片的 Base64 文本计入上述上传限制。

## Python 调用

无需第三方 Python 依赖，见 `examples/python_client.py` 和 `examples/submit_job.py`：

```python
from python_client import LLMJobs

client = LLMJobs("http://127.0.0.1:3210")
job_id = client.submit(
    name="批量摘要",
    submission_key="dataset-2026-001",
    batches=[{
        "id": "main",
        "config": {
            "provider": "deepseek",
            "model": "deepseek-flash",
            "maxOutputTokens": 2048,
            "thinking": "off",
        },
    }],
    queries=(
        {"id": str(i), "batch": "main", "prompt": query}
        for i, query in enumerate(your_queries)
    ),
)
print(job_id)
print(client.status(job_id))
# 返回 completed、needs_attention、preflight_blocked 或 paused 时停止等待
print(client.wait(job_id)["state"])
for result in client.results(job_id):
    print(result["query_id"], result["state"], result["result"])
```

`submit()` 使用 chunked HTTP + JSONL 逐条发送 generator，不将全部 queries 物化为列表。batches 只传配置，不再内嵌 queries。接口导入完成并持久化后返回 Job ID。若提交响应丢失，请使用相同 submission_key，服务会拒绝重复执行并返回原 Job ID。

如果服务在读取首行配置时提前拒绝导入，客户端会尽量读取并显示实际 HTTP 错误，避免只显示后续上传引发的 `Broken pipe`。统一关闭思考应写 `"thinking": "off"`，`none` 是映射后的 OpenAI 原生值，不能直接用于统一字段。

也可从已有 JSONL 文件流式提交：`client.submit_file("job.jsonl")`。Python 客户端的网络错误不会自动重新提交，避免重复 Job；后台 LLM 重试与此独立。

## 统一配置

```json
{
  "provider": "bailian",
  "model": "qwen-plus",
  "maxOutputTokens": 4096,
  "temperature": 0.7,
  "topP": 0.9,
  "thinking": "off",
  "timeout": { "connectMs": 60000, "idleMs": 300000, "totalMs": 1800000 }
}
```

公共参数：`temperature`、`topP`、`topK`、`maxOutputTokens`、`presencePenalty`、`frequencyPenalty`、`seed`、`stopSequences`。支持程度取决于模型，未知公共字段直接报错，SDK 参数警告视为预检失败，不能默认忽略。

### Token 对数概率

对支持的模型，在批次 `config` 中设置 `"logprobs": true`；可选 `"topLogprobs": 5`，请求每个生成位置的最多 5 个候选 Token。`topLogprobs` 必须是 0–20 的整数，百炼上限为 5，只能与 `logprobs: true` 一起使用。不设置这两个字段时维持原有行为。

```json
{
  "provider": "bailian",
  "model": "qwen-plus-2025-12-01",
  "thinking": "off",
  "logprobs": true,
  "topLogprobs": 5
}
```

支持 Chat Completions 和 Responses 协议；实际可用性仍由 Provider、模型和模式决定。OpenAI 的 `gpt-6-luna` 需要 `"thinking": "off"`。百炼 `qwen-plus` 稳定版不在官方支持清单中，应选择支持概率的快照模型。Anthropic 和 Google 协议暂不支持此统一配置。不要同时通过 `extraBody` 或 `providerOptions.openai` 设置同名概率参数。如果模型返回了文本却没有返回请求的概率，预检会报参数错误，而不会把空值当作成功。

成功结果持久化并通过结果详情和 JSONL 导出：`result.logprobs.content` 是生成文本的逐 Token 数组；`result.logprobs.reasoning` 保存上游 Chat 流提供的思考 Token 概率（没有提供时为空数组）。每项保留上游的 `token`、`logprob`、`bytes` 和 `top_logprobs` 等字段；普通概率可计算为 `Math.exp(logprob)`。失败尝试如已收到概率，也会保存在尝试历史 `partial` JSON 的 `logprobs` 中。单次概率数据上限为 3200 万字符。概率不代表答案事实正确的概率。

### 统一 thinking

日常只设置一个字段：`"thinking": "off"` 关闭思考，或使用 `minimal / low / medium / high / xhigh / max` 指定强度。不填则使用平台默认值；无需自己组装 `extraBody` 或 `providerOptions`。

例如通过 OpenCode 测试 Gemini：

```json
{
  "provider": "opencode",
  "model": "gemini-4-argon",
  "maxOutputTokens": 32768,
  "thinking": "low"
}
```

服务按 provider 和协议自动组装：

| 协议 / 平台                 | `off`                             | 强度字符串                                        |
| --------------------------- | --------------------------------- | ------------------------------------------------- |
| DeepSeek / MiMo / 其他 Chat | `thinking.type=disabled`          | `thinking.type=enabled` + `reasoning_effort`      |
| 百炼 Chat                   | `enable_thinking=false`           | `enable_thinking=true` + `reasoning_effort`       |
| Responses                   | `reasoning.effort=none`           | `reasoning.effort`                                |
| Anthropic                   | `thinking.type=disabled`          | `thinking.type=adaptive` + `output_config.effort` |
| Google                      | `thinkingConfig.thinkingBudget=0` | `thinkingConfig.thinkingLevel`                    |

Google 原生映射接受 `minimal/low/medium/high`；Anthropic 接受 `low/medium/high/xhigh/max`。这些是协议映射范围，每个模型实际支持的档位可能更少。服务不会自动降档、切换模型或把 `off` 当成 `low`；模型不支持关闭或某档位时，预检失败后等待处理。平台如果静默忽略字段，预检也无法证明它生效。

兼容旧配置：`{"enabled": false}`、`{"enabled": true, "effort": "low"}`，以及明确使用 token budget 的 `{"enabled": true, "budget": 2048}`。旧式 budget 继续用于支持它的百炼、Anthropic 和 Google 模型；不把强度猜测换算成固定 token 数，强度和 budget 无法共同映射时明确报错。不要把统一配置与原生 thinking 覆盖字段混用。

原生字段参考：[Google thinking](https://ai.google.dev/gemini-api/docs/thinking)、[Anthropic adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)、[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)。

高级配置可通过 AI SDK 的 `providerOptions`，或 `extraBody` 传递平台原生字段。`extraBody` 不允许覆盖模型、输入、流式和公共采样参数。平台可能静默忽略未知原生字段，预检无法证明这些字段确实生效；请对照模型文档使用。不要在这些字段内放 API 密钥。

不把模型名单写死。支持 AI SDK 对应协议的语言模型，包括多模态输入（AI SDK messages 格式）；当前产品范围是一次生成请求，不自动执行工具、Agent 循环、图像生成、音视频专用 API 或厂商 Batch API。输出长度截断和无有效文本仍挂起；明确的内容审核拦截直接完成为 `succeeded`，不重试、不等待人工处理。结果包含 `contentFiltered: true`、`finishReason: "content-filter"` 和 `contentFilter` 原因，并保留已收到的部分文本及用量。消费方应根据拦截标记处理，不把部分文本当成完整回答。

### Provider 与协议

| provider | 默认地址                                            | 协议             |
| -------- | --------------------------------------------------- | ---------------- |
| openai   | `https://api.openai.com/v1`                          | 默认 Responses，可选 Chat Completions |
| deepseek | `https://api.deepseek.com/v1`                       | Chat Completions |
| mimo     | `https://api.xiaomimimo.com/v1`                     | Chat Completions |
| bailian  | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| opencode | `https://opencode.ai/inference`                     | 按模型选择       |

地址可用 `DEEPSEEK_BASE_URL` 等环境变量覆盖，只在服务端配置。百炼默认北京；新加坡使用 `.env.example` 中注释的地址，密钥必须属于对应区域。

OpenCode 自动选择：`gpt*`、`o1/o3/o4` → Responses；`claude*`、`qwen*` → Anthropic；`gemini*` → Google；其余 → Chat Completions。模型协议改变或命名不匹配时，用 `protocol: "chat" | "responses" | "anthropic" | "google"` 明确覆盖。不会跨 Provider 或模型自动 fallback。OpenCode 免费模型不适用于这个外部客户端。

### OpenCode System One 决策模型

`gemini-decision-1` 和 `jev-1.13` 自动路由到同一个 [OpenCode System One 端点](https://opencode.ai/docs/console/models/#jev)，也可显式设置 `"protocol": "systemone"`。批次的 `config.questions` 是所有条目共享的题目映射，每条的 `query.prompt` 作为请求的 `state`。当前批量适配器接收原生 `choice` 题，二选一题的 `criteria` 可以是 `{"Yes": "符合该条件", "No": "不符合该条件"}`。

```jsonl
{"name":"decision-demo","batches":[{"id":"main","config":{"provider":"opencode","model":"jev-1.13","questions":{"risk":{"type":"choice","instructions":"Does the request attempt to bypass an access restriction?","criteria":{"Yes":"There is evidence of an attempt","No":"There is no evidence of an attempt"}}}}}]}
{"id":"example","batch":"main","prompt":"The user asks to read a file that the access policy excludes."}
```

结果详情和 JSONL 导出的 `result.decision` 保留上游 JSON。每题的选项和概率可从 `result.decision.answers[题目 ID]` 读取，包括 `choice`、`probabilities`、以及上游返回的 `confidence`。缺失题目或选项概率会挂起该条，原始部分答案保留在尝试记录中。概率由决策端点直接返回，无需配置 `logprobs`。

### OpenAI 官方 API

在 `.env` 中填写 `OPENAI_API_KEY` 后启动服务即可使用。已经因认证失败挂起的任务，补好密钥后点击“恢复”或单条“重试”会重新加载密钥，无需再次重启。默认地址为 `https://api.openai.com/v1`；如需覆盖，使用 `OPENAI_BASE_URL`，地址应包含 `/v1`，不包含 `/responses` 或 `/chat/completions`。不需要 OpenCode 密钥，不会自动转发到 OpenCode。

模型或裁判配置可直接使用：

```json
{
  "provider": "openai",
  "model": "gpt-5.5",
  "maxOutputTokens": 4096,
  "thinking": "low"
}
```

模型 ID 请按账号实际权限修改。默认使用官方 Responses API；需要 Chat Completions 时添加 `"protocol": "chat"`。OpenAI provider 仅允许这两个协议，不根据模型名称猜测协议。

统一 `thinking` 在 Responses 中映射为 `reasoning.effort`，在 Chat Completions 中映射为 `reasoning_effort`；`off` 映射为 `none`。省略 `thinking` 则使用模型默认值，不会发送厂商扩展的 `thinking.type`。不同模型支持的档位不同，不支持 `none` 或某强度时保留预检错误，不自动降档。官方 API 的 reasoning 参数说明见 [OpenAI Docs](https://developers.openai.com/api/docs/guides/reasoning)。

完整提交示例为 `examples/openai-job.json`。复用现有队列、并发、重试、恢复和内容审核处理；只记录返回的实际用量或金额，不根据 token 估算费用。

## 执行与故障语义

1. 对排序后的配置 JSON 去重，每组取一条真实 query 预检。样本失败重试期间不会换另一条样本。预检成功结果直接保存，不重复收费调用。
2. 全部预检通过后进入正式并发。预检参数错误阻止整个 Job 启动；正式阶段错误仅处置该条，共享限流/断网冷却暂停相应控制范围派发：OpenCode 按模型，其余按 Provider。
3. 默认每 10ms 向某控制范围派发一条，探测上限 64；OpenCode 的控制范围是 provider + model，其余是 Provider。首次 429 到达时，记录移除失败请求之前该控制范围跨 Job 的在途数，取 70% 向下取整，最低 1。固定并发值并持久化。探测达到安全上限但未遇 429 时保持上限，不宣称发现了真实额度。`PROBE_INTERVAL_MS` 同时是健康恢复后的间隔下限；重启时未遇限流的探测控制器直接采用新配置，已有的限流退避和冷却不会被强行清空。
4. 按发送轮次处理限流：同一轮已发出请求的多个限流响应只触发一次调整，迟到的旧响应也不会重复降速；明确返回的 Retry-After 仍会遵循。冷却后新请求再次限流，才将发送间隔翻倍（最低 250ms、最高 60s），默认冷却 60s。当前策略下至少成功 10 次且稳定至少 60 秒后，间隔减半，逐步恢复至配置的初始间隔，并发上限保持不变。重启保留速率但重新收集成功证据。旧版本逐条放大的持久化间隔会一次性收敛到最多 max(250ms, 初始间隔)，保留并发和冷却状态。限流不计有效尝试。OpenCode 同一模型跨 Job 共享控制器，不同模型分别探测并持久化固定并发、发送间隔、冷却与恢复证据；其余 Provider 仍跨 Job 共享控制器。进程总在途上限默认 128。环境变量可调整上限和初始间隔。
5. 每条最多 3 次有效尝试，含预检。超时/已发送后断流等待 5 分钟再尝试一次；第二次中断就挂起。普通 5xx 使用短指数退避，连续故障会暂停该 Provider 60s。内容过滤视作成功完成，并在输出结果中记录拦截标记和原因；参数、认证、余额和未知错误直接挂起。
6. DNS/连接建立失败等明确未发出情况，不计次数，等待 5 分钟；不确定是否发送按已发送处理。限流或明确未发送连续累计 20 次后挂起，防止无限循环。
7. 手动重试开启新一轮最多 3 次，保留历史尝试和操作记录。可以修改 prompt/配置后重试、跳过。修改配置会对该配置重新检查。暂停仅停止派发，在途请求允许结束。

时间限制分别为连接 60s、读取空闲 5min、总时限 30min，可按批次配置。保活刷新读取空闲计时，不无限延长总时限。

### 持久化与恢复

升级到 OpenCode 按模型控制时，旧的 `opencode` 平台共用控制记录会被移除，因为无法归属给某个模型；各模型独立重新探测，不继承其他模型探测出的并发值。已有 `opencode:<model>` 记录在重启后保留。任务暂停状态、逐条等待时间和请求历史不变。

点击 Job 的“恢复”也会手动覆盖冷却：清除该任务未完成项所用控制范围的冷却和下次发送等待，并立即放行本任务已排队或等待的条目。保留已探测的并发上限、发送间隔和尝试次数；其他非认证挂起项仍需重试。冷却在同一控制范围内跨 Job 共享；OpenCode 只影响相同模型的运行中任务，其他 Provider 影响同平台运行中任务，其他暂停任务保持暂停。恢复前已在途的旧响应不会重新施加平台冷却；恢复后新请求再次遇到限流或网络故障时仍会正常退避。

缺少 API Key 会挂起任务，但不会计为一次有效上游尝试。补好 `.env` 后，点击 Job 的“恢复”会读取该 Provider 的非空密钥，并重新排队认证失败项；单条“重试”也会重新读取密钥。其他平台的密钥、其他错误项、已成功项和其他暂停任务不受影响，原始尝试历史保留。密钥仍为空时返回明确错误，保持原挂起状态。`.env` 没有提供非空密钥时保留已有进程环境变量；地址和并发等其他环境配置仍需重启生效。

服务重启时，历史上因内容审核挂起的项自动转为成功并记录拦截原因，不重新请求；原始失败尝试历史保留，暂停的 Job 仍保持暂停。

SQLite WAL + synchronous=FULL。请求前事务记录尝试；结果、用量、状态在同一事务落盘后才报告成功。服务启动自动恢复已提交队列；未决在途尝试保守视为中断，等待 5 分钟再恢复一次，仍受三次总上限限制。暂停 Job 保持暂停。

上游完成但响应丢失、本机收到响应但提交前断电，都可能造成重复请求和重复费用；上游没有可靠幂等/结果查询时无法保证恰好一次。流式中间文本只在内存中累计，正常错误会保存部分输出；断电会丢失尚未提交的部分输出。

磁盘满或数据库写入失败会停止派发，不把未提交结果当成功。修复存储后重启服务。硬件损坏不在 SQLite 的保证范围内。备份请先正常停止服务，再复制整个 data 目录（或使用 SQLite 在线备份工具，不能只复制正在写入的主 DB 文件）。进程 PID 锁有歧义时拒绝启动，确认无旧服务后再人工清理 `.lock` / `.lock.reclaim`。

本地文件包含完整输入、结果和错误响应，应作为敏感数据管理。新进程使用 umask 077；日志不会输出密钥或请求全文，保存错误前会替换已配置的平台密钥。

### 费用

仅使用 API 实际返回的金额，不查价目表、不估算费用。按尝试累计（包含失败重试）；币种分别累计。OpenCode `usage.cost` 默认 USD，并保留原始 usage；如果平台把金额标为估算，该标记也在原始 usage 中，不应把它当最终账单。

金额和 Token 独立累计并同时展示 API 已返回的信息，各自显示覆盖次数。带金额的请求仍计入 Token 总量；两者都未返回时显示未知次数。混合返回时，不把部分金额或 Token 冒充完整用量，不估算缺失数据。订阅、BYOK 与免费套餐不属于本服务目标。

### 批量处置

页面请求明细支持勾选单条或本页全部，再点击“批量重试”或“批量跳过”。筛选为挂起、等待重试或已跳过时，也可将范围改为“当前筛选全部（跨页）”，无需逐页处理。仅修改当前 Job 中的可处置项，不处理已成功、执行中或排队项；若所选条目状态已经改变，整批拒绝并提示刷新，不会只做一半。

批量重试保留全部历史并开启新一轮尝试，认证失败项会重新读取密钥。暂停的 Job 保持暂停，需要时再手动恢复。最后一批失败项全部跳过且没有未完成请求时，非暂停 Job 会更新为完成。批量操作不修改 prompt 或模型配置，重试可能再次计费。

OpenCode 返回 `Upstream request failed: [api_error] Upstream response was not valid JSON` 时，表示网关解析上游响应失败，不表示本地请求或裁判结果不是 JSON。即使它包装为 HTTP 400，也按临时上游故障有限重试，最多三次有效尝试后挂起；真正的参数错误仍直接挂起。重复失败仍需平台侧排查，不能仅凭此报错视作审核拒答。

## HTTP 接口

- `POST /api/jobs`：提交 JSON / JSONL，返回 Job ID。
- `GET /api/jobs`、`GET /api/jobs/:id`：列表、状态及统计。
- `GET /api/jobs/:id/events`：SSE，每 2 秒刷新持久化快照。
- `GET /api/jobs/:id/items?state=held&after=0`：游标分页，每页最多 100 条。
- `GET /api/items/:id`：输入、结果、错误、完整尝试和人工操作历史。
- `POST /api/items/:id`：`{"action":"retry","patch":{"prompt":"...","config":{...}}}`、`{"action":"skip"}` 或 `{"action":"refuse"}`。patch 可省略；config 是完整替换。refuse 将挂起、等待或跳过项标记为拒答并算作成功，不重发请求、不应用配置编辑，保留原始错误和尝试历史，并记录人工操作。导出结果包含 `manualRefusal: true` 和 `partial: "I cannot answer."`；UtilityBench 直接按拒答计分，无需再提交裁判。
- `POST /api/jobs/:id/items/bulk`：`{"action":"retry","ids":[1,2,3]}` 或 `{"action":"skip","state":"held"}`。`ids` 是服务端 item ID，每次最多 1000 条；`state` 支持 `held/waiting/skipped`，覆盖当前 Job 的全部匹配项。二选一，不支持配置 patch；返回 `{ok:true,count:N}`，批量验证和写入在同一事务中完成。
- `POST /api/jobs/:id/pause`、`POST /api/jobs/:id/resume`。
- `GET /api/jobs/:id/export`：流式 JSONL，包含每条状态和全部尝试历史。执行期间导出是逐页读取，最终一致的完整导出应等任务结束。
- `GET /api/status`：在途数、限流控制器、存储故障。

## 验证

```sh
npm test
```

测试使用本地假 API 和临时 SQLite，不访问付费平台。覆盖状态转换、预检、重试、限流、恢复、原子导入和真实 AI SDK 流解析。没有真实密钥的环境无法验证平台账号权限、真实模型能力和平台实际限额；第一次提交即执行真实预检。

## 官方参考

- [AI SDK 设置与重试](https://ai-sdk.dev/docs/ai-sdk-core/settings)
- [OpenAI 官方 Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI reasoning 配置](https://developers.openai.com/api/docs/guides/reasoning)
- [AI SDK Compatible Provider](https://ai-sdk.dev/providers/openai-compatible-providers)
- [OpenCode 推理协议与费用](https://opencode.ai/v2/docs/console/api/inference/)
- [DeepSeek 限流与保活](https://api-docs.deepseek.com/quick_start/rate_limit/)
- [DeepSeek 错误码](https://api-docs.deepseek.com/quick_start/error_codes/)
- [MiMo 错误码](https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)
- [百炼限流](https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices)
- [百炼错误码](https://help.aliyun.com/zh/model-studio/error-code)
