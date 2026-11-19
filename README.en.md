[中文](README.md) · [Agent Guide](AGENT.md)

# Local LLM Batch Job Runner (LLM Jobs)

A **local batch runner for LLM APIs** built to spare you from babysitting scripts that choke on `429` rate limits, crash mid-run, and force you to start over from row 1.

Requires only **Node.js 24+**—no Redis, no external database, no build step. Progress persists to disk as items finish (`data/jobs.sqlite`), concurrency and recoverable errors handle themselves, and a local dashboard (`http://127.0.0.1:3210`) lets you monitor runs, rescue failed items, and export results.

> **Scope & Safety**: Built for single-turn or multi-turn generation (text + images) and OpenCode System One decisions—**not** agent loops, automatic tool execution, image generation, or vendor async Batch APIs. Binds only to `127.0.0.1` and reads keys solely from local env vars. **Never expose publicly.**

---

## Key Features

- **Crash-safe & resumable**: Every completed item saves immediately. `Ctrl+C` or restarts pick up unfinished work automatically (manually paused jobs stay paused).
- **One schema, many providers**: Built-in support for `openai`, `anthropic`, `google`, `deepseek`, `mimo`, `bailian`, and `opencode`, plus custom/local endpoints in `.env` (`LLM_LOCAL_BASE_URL`). Unified `thinking` controls and optional `logprobs`.
- **Built for real batches**: Up to **100,000 items and 1,000 batches** per job; supports multi-turn `messages`, image inputs (base64 or HTTPS URLs), System One decisions (`jev-1.13` / `gemini-decision-1`), and streaming JSONL uploads.
- **No accidental double-runs**: Pass an optional `submissionKey` (`submission_key` in Python). If a submit request drops mid-flight, re-submitting with the same key returns the existing Job ID instead of running and billing twice.
- **Local Web dashboard (`http://127.0.0.1:3210`)**: Live progress, a "Needs Attention" queue, per-provider concurrency/cooldown visibility, token counts, **actual API-reported costs** (never guessed), error diagnostics, single/cross-page bulk recovery actions, and JSONL export. *(Submit jobs via Python/HTTP; the browser UI is for monitoring and cleanup.)*

---

## Quick Start

### 1. Start the Service

```sh
npm ci
cp .env.example .env
# Fill in API keys only for the providers you use
npm start
```

Open `http://127.0.0.1:3210`; press `Ctrl+C` to stop cleanly. One database file can only be used by one running process—set separate `PORT` and `DB_PATH` values to run multiple instances.

### 2. Submit a Job (Python Client Recommended)

Zero third-party dependencies—use [examples/python_client.py](examples/python_client.py) (see [examples/submit_job.py](examples/submit_job.py) for a full example):

```python
from python_client import LLMJobs

client = LLMJobs("http://127.0.0.1:3210")
job_id = client.submit(
    name="Batch summarization",
    submission_key="dataset-2026-001",
    config={"provider": "deepseek", "model": "deepseek-flash", "maxOutputTokens": 2048, "thinking": "off"},
    queries=["Explain SQLite WAL in one sentence.", "What is exponential backoff?"],
)

status = client.wait(job_id)  # Blocks until completed, paused, or needing attention
for item in client.results(job_id):
    print(item["query_id"], item["state"], item["result"])
```

- **Custom IDs, multi-turn & images**: Items accept `{"id": "row-1", "prompt": "...", "metadata": {...}}`, or `messages` instead of `prompt` (place `data:image/...;base64,...` or HTTPS image URLs in user `content`; System One accepts text `prompt` only).
- **Multi-model comparisons**: Use `batches` with per-batch `id` and `config`—see [examples/job.json](examples/job.json) and [examples/openai-job.json](examples/openai-job.json).
- **Large datasets**: Pass a Python generator to `submit()` or stream a file via `client.submit_file("job.jsonl")` (format in [examples/job.jsonl](examples/job.jsonl)) without loading everything into RAM.
- **`submission_key` rule**: Reuse the **same** key to verify/recover an ambiguous submit; use a **new** key whenever prompts or configs change.
- **Direct `curl` option**:

```sh
curl --fail-with-body http://127.0.0.1:3210/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"config":{"provider":"deepseek","model":"deepseek-flash"},"queries":["Explain SQLite WAL in one sentence.","What is exponential backoff?"]}'
```

### 3. Common Config

```json
{
  "provider": "bailian",
  "model": "qwen-plus",
  "maxOutputTokens": 4096,
  "temperature": 0.7,
  "thinking": "off"
}
```

- **Built-in `provider`s**: `openai`, `anthropic`, `google`, `deepseek`, `mimo`, `bailian`, `opencode`. For local/compatible servers (e.g., vLLM, Ollama), add `LLM_LOCAL_BASE_URL=http://127.0.0.1:8000/v1` (and `LLM_LOCAL_API_KEY` if required) in `.env`, then set `"provider": "local"`. Each custom name tracks concurrency independently.
- **`thinking`**: `"off"` to disable reasoning, or `minimal / low / medium / high / xhigh / max`; omit for provider default. Unsupported levels fail preflight cleanly instead of silently downgrading.
- **`stream: false`**: Opt out of streaming for non-streaming endpoints.
- **`logprobs: true`**: Optional `topLogprobs`; captures token log-probabilities on supported OpenAI / Chat / Responses models.
- **`protocol`**: Only needed to override defaults (e.g., `"chat"` on `openai` instead of Responses, or overriding `opencode` auto-routing).
- **`questions`**: Only for OpenCode System One decision models (`jev-1.13` / `gemini-decision-1`), paired with text `query.prompt`.
- **`timeout`**: Defaults to **60s** connect, **5 min** idle, **30 min** total (`{"connectMs", "idleMs", "totalMs"}`).
- **`extraBody` / `providerOptions`**: Escape hatch for provider-native parameters.

### 4. Collect Results

In Python, call `client.wait(job_id)` then iterate `client.results(job_id)`. In the dashboard, click **Export JSONL** once the job is `completed` for a complete final snapshot (inputs, states, outputs, usage/costs, and full attempt history).

---

## Concurrency & Retries

Understanding these three mechanics tells you whether the runner is stuck or just being polite to an upstream rate limit.

1. **Preflight Check (1 real test request per config)**
   Before launching full concurrency, each unique config sends **1 real request** (yes, billed normally). If it succeeds, that result is kept (never run twice) and the batch opens up; if it hits a hard error (bad key, wrong model, invalid param), the whole job halts at `preflight_blocked` so thousands of requests don't crash into the same wall.

2. **Adaptive Concurrency (Ramp up, brake on limits, recover steadily)**
   - **Scope**: Tracked **per model** for `opencode`, **per provider** for everything else. Running jobs share the limit fairly, and learned windows persist across restarts.
   - **Ramp-up**: Starts at **4** concurrent requests and doubles whenever a full window succeeds cleanly (`4 → 8 → 16 → 32 → ...` up to `PROBE_MAX_CONCURRENCY=64`, global cap `GLOBAL_CONCURRENCY=128`).
   - **Braking**: Concurrent `429`s from the same burst count as one step down—shrinking concurrency to **70%** of observed load (min `1`) and triggering a cooldown (`Retry-After`, default **60s**). Repeated hits widen dispatch spacing.
   - **Recovery**: After cooldown, once a scope logs **≥10 consecutive successes over 60 stable seconds**, spacing halves back toward normal, then concurrency climbs **+1** at a time when saturated.

3. **Error Handling & Retry Rules**

| Failure | Automatic Action | Counts Toward 3-Attempt Cap? |
| --- | --- | --- |
| **Rate limit (`429`)** | Wait cooldown (`Retry-After` / **60s**), then retry | **No** (held after **20** consecutive free retries) |
| **Clearly unsent** (DNS / refused / connect timeout) | Pause scope **5 min**, then retry | **No** (held after **20** consecutive free retries) |
| **Temporary server error (`5xx`, transient gateway)** | Short exponential backoff (seconds); **3** in a row pauses scope **60s** | **Yes** (max **3** attempts total, incl. preflight) |
| **Mid-flight interruption** (read/total timeout, dropped stream, crash/restart) | Waits **5 min**, retries **at most once**; 2nd interruption holds | **Yes** (max 1 automatic interruption retry) |
| **Content safety filter** | Marked **`succeeded`** directly (`contentFiltered: true` + reason + partial text); never stalls job | — *(Consumers must check `contentFiltered`)* |
| **Hard failure** (auth/missing key, out of balance, invalid model/param, `maxOutputTokens` truncation, empty reply, unknown) | **Held (`held`) immediately**—no wasted retries | Missing key burns 0 attempts; others hold at once |

> **Honest billing note**: Items are only marked `succeeded` after writing to disk, and partial text from normal errors is preserved. Still, if the network drops *after* upstream generation completes or power cuts mid-write, that cautious retry can occasionally double-bill (unavoidable without upstream result-lookup APIs). Dashboard totals show **only** actual API-reported costs and tokens—never estimated from price tables.

---

## When to Intervene

**Leave it alone**: Normal runs, 60s / 5m cooldowns, occasional `5xx` retries, content-filter completions, and post-restart recovery.

**Step in (`http://127.0.0.1:3210`)**: When `client.wait()` returns `preflight_blocked` / `needs_attention`, or a job shows under **Needs Attention**:

- **`preflight_blocked`**: For a missing key, update `.env` and click **Resume** (hot-reloads keys **without restarting**). For bad model/params, fix the config in the UI and retry.
- **`needs_attention` (held items remaining)**: Filter by **Held** and inspect the error summary:
  - Missing/bad key → update `.env`, click **Resume** or **Retry** (non-key env vars like base URLs or concurrency limits still require a restart).
  - Out of balance → top up your account, select items (or *"All matching across pages"*), click **Batch Retry**.
  - Truncated (`maxOutputTokens`) or incompatible params → **Edit Config & Retry…** (re-runs preflight; retries may incur new charges).
  - Item-specific failures / 3 attempts exhausted → inspect attempt timeline, then **Save & Retry**, **Skip** (clears the way to `completed`), or **Mark as Refusal** (writes `manualRefusal: true` and `"I cannot answer."` with no API call).
- **Skip a cooldown**: If you know the upstream/network is back, click **Resume** to clear active cooldowns while preserving the learned concurrency cap.
- **Disk full / lock conflict**: Disk errors halt dispatching—free space and restart. On a stale crash lock, verify no old process is running before deleting `.lock` / `.lock.reclaim` in `data/`.
- **Pause, delete, backup**: **Pause** lets in-flight requests finish cleanly; pause and wait for zero in-flight items before deleting a job; stop (`Ctrl+C`) before backing up `data/` (which contains full inputs and outputs).

---

## Reference

- Environment & concurrency tuning: [.env.example](.env.example)
- Python client & payload examples: [examples/python_client.py](examples/python_client.py), [examples/submit_job.py](examples/submit_job.py), [examples/job.json](examples/job.json), [examples/job.jsonl](examples/job.jsonl), [examples/openai-job.json](examples/openai-job.json)
- AI agent job submission & monitoring spec: [AGENT.md](AGENT.md)
- Local test suite (mock endpoints, zero API cost): `npm test`
