# AGENT.md — Job Submission & Monitoring Protocol

Operational specification for AI agents interacting with the local **LLM Jobs** batch service (`http://127.0.0.1:3210` by default). Follow these rules strictly to prevent duplicate billing, corrupted state, and noisy polling.

---

## 1. Non-Negotiable Rules

- **Use the service API or Python client**: When asked to execute batch LLM requests, submit them through `POST /api/jobs` or [examples/python_client.py](examples/python_client.py). **MUST NOT** write ad-hoc parallel API scripts that bypass the service.
- **Never touch SQLite directly**: **MUST NOT** read, write, or lock `data/jobs.sqlite` (or `DB_PATH`) directly while the service runs.
- **Never leak credentials**: **MUST NOT** read, print, log, or copy API keys from `.env` or environment variables into prompts, reports, `extraBody`, or `providerOptions`.
- **Never spawn a duplicate server**: Only one process may hold a given `DB_PATH` lock. Before starting the service (if authorized), verify it is not already listening.

---

## 2. Pre-Submission Checklist

1. **Health & fault check (`GET /api/status`)**:
   - Confirm the service responds and `fatal` is `null`.
   - If `fatal` is non-null, **STOP** immediately and report the storage fault to the user; `POST /api/jobs` will reject submissions (`503`).
   - If unreachable, report that the service is not running (only start `npm start` if the user authorized it).
2. **Mandatory deterministic `submissionKey` (`submission_key` in Python)**:
   - Agents **MUST** always supply a deterministic `submissionKey` (1–256 chars, unique across the entire DB), e.g. `<task>-<dataset>-<run-tag>`.
   - **MUST NOT** retry an ambiguous or timed-out `POST /api/jobs` without a `submissionKey`.
   - If `POST /api/jobs` returns HTTP `400` containing `submissionKey 已存在，原 Job: <job_id>`, **MUST NOT** invent a random suffix to force a new job for the same workload—inspect and monitor `<job_id>` instead. Only change `submissionKey` when prompts or configs intentionally change.
3. **Preflight cost check**:
   - Sealing a job immediately dispatches **1 real paid API request per distinct config** during preflight. Verify `provider`, `model`, `thinking`, and item count before submitting large workloads.

---

## 3. Submission Specification & Pitfalls

### Transport
- **Python client (preferred)**: Use `LLMJobs` from [examples/python_client.py](examples/python_client.py).
  - `client.submit(...)`: streams iterables/generators over chunked JSONL without materializing everything in RAM.
  - `client.submit_file(path)`: streams an existing `.jsonl` file.
- **Direct HTTP (`POST /api/jobs`)**:
  - `Content-Type: application/json` for payloads `<= 16 MiB`.
  - `Content-Type: application/x-ndjson` (JSONL) for larger payloads up to `512 MiB` (line 1 = header JSON with `name`, `submissionKey`, and `config` or `batches`; lines 2+ = one query per line).
  - Hard caps: max **100,000 items**, **1,000 batches**, **2,000,000 chars per JSONL line**.

### Payload Rules
- **Single vs. multi-batch**: Provide **either** `config` (implicitly creates batch `"main"`) **or** `batches: [{id, config, ...}]`, never both. Every declared batch **MUST** receive at least 1 query.
  - In JSON single-config format, items live in top-level `queries`. In JSON multi-batch format, items live inside each `batches[].queries`.
  - In JSONL multi-batch format, omit `queries` from line 1 `batches[]` and tag every query line with `"id"` and `"batch"`.
- **Query shape**:
  - Each query **MUST** have **either** `prompt` (string) **or** `messages` (non-empty array of `{role, content}` with `role` in `system|user|assistant|tool`), never both.
  - `query.id` must be 1–256 chars and unique within the job (auto-numbered `"1"`, `"2"`, ... only in single-config mode when omitted). Use `metadata` to carry source IDs/splits.

### Config Validation Traps (Immediate HTTP 400 or Preflight Block)
- Unknown config keys are rejected. Allowed keys: `provider`, `model`, `protocol`, `stream`, `questions`, `temperature`, `topP`, `topK`, `maxOutputTokens`, `presencePenalty`, `frequencyPenalty`, `seed`, `stopSequences`, `logprobs`, `topLogprobs`, `thinking`, `providerOptions`, `extraBody`, `timeout`.
- **Unified `thinking`**: Use `"off"` (NEVER `"none"`) or `"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`; omit for provider default. Never mix unified `thinking` with native thinking fields in `extraBody`.
- **`logprobs`**: Supported only on `chat` and `responses` protocols (`topLogprobs` integer `0..20`, max `5` for `bailian`, requires `logprobs: true`). Do not duplicate `logprobs`/`top_logprobs` in `extraBody` or `providerOptions.openai`.
- **`extraBody`**: **MUST NOT** override reserved keys (`model`, `messages`, `input`, `contents`, `stream`, `stream_options`, `temperature`, `top_p`, `top_k`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `seed`, `stop`, `presence_penalty`, `frequency_penalty`).
- **OpenCode System One (`jev-1.13`, `gemini-decision-1`, or `protocol: "systemone"`)**: Only `provider`, `model`, `protocol`, `questions`, `timeout` are allowed; `questions` must be non-empty `choice` definitions with `instructions` and `>= 2` `criteria` options; queries **MUST** use non-empty string `prompt` (no `messages`).

Record the returned `id` (`job_id`) immediately before starting monitoring.

---

## 4. Continuous Monitoring Protocol

### Monitoring Channels
- **Polling**: `GET /api/jobs/:id` (or `LLMJobs.status(job_id)`) paired with `GET /api/status`.
- **SSE streams**: `GET /api/jobs/:id/events` pushes the `GET /api/jobs/:id` summary every 2s *only when changed* (plus `: keepalive` comments every ~16s); `GET /api/stream` streams overview + status.

### Polling & Waiting Discipline
- **Never tight-loop**: **MUST NOT** poll faster than once every 2s. Use **5–15s** intervals for small active runs, and back off to **30–60s** (or use background/scheduled wakeup mechanisms where available) for large runs or active cooldowns.
- **Check `fatal` every cycle**: Inspect `GET /api/status` → `fatal`. If non-null, stop monitoring and escalate the storage error immediately.
- **Respect cooldowns—do NOT panic on `waiting`**:
  - Rate limits (`429`) trigger a shared cooldown (`Retry-After`, default **60s**) on `controls[scope]` (where `scope` is `opencode:<model>` for `opencode`, and `<provider>` otherwise).
  - DNS/connect failures and mid-flight interruptions wait **5 minutes** (`300,000 ms`).
  - Before treating a flat progress bar as a hang, check `controls[scope].cooldown > Date.now()` and `counts.waiting`.
  - **MUST NOT** pause, delete, resume, or re-submit a running job just because items are `waiting` or concurrency dropped.
- **Report deltas, not raw dumps**: Summarize changes in `state`, `counts`, `lastActivity`, `errorGroups`, and `controls[scope]` (`cap`, `inFlight`, `cooldown`).

### Job State Machine & Agent Actions

| `job.state` | Meaning | Agent Action |
| --- | --- | --- |
| `importing` | Upload/validation still finalizing | Wait briefly and re-check |
| `preflight` | Running 1 real probe item per config | Continue monitoring |
| `running` | Concurrent execution active | Continue monitoring until terminal or attention state |
| `completed` | All items `succeeded` or `skipped` | Stop monitoring; proceed to export & verification |
| `preflight_blocked` | A config probe hit a hard error (`held`) | Stop monitoring; inspect `job.error`, `errorGroups`, and `GET /api/jobs/:id/items?state=held`; report diagnosis to user |
| `needs_attention` | No `queued`/`waiting`/`running` items remain, ≥1 item `held` | Stop monitoring; triage via `errorGroups` and sample `GET /api/items/:id`; report breakdown to user before retrying or skipping |
| `paused` | Operator paused dispatch | Stop monitoring; **MUST NOT** call `resume` unless explicitly instructed |

---

## 5. Diagnostics vs. Mutations (Authorization Boundaries)

### Read-Only Diagnostics (Call Freely)
- `GET /api/status` — global `active`, `globalMax`, `fatal`, and per-scope `controls`.
- `GET /api/jobs/:id` — job `state`, `counts`, `totals` (tokens/cost per provider), `batches`, `errorGroups` (grouped `held`/`waiting` errors with counts).
- `GET /api/jobs/:id/items?state=held&after=0` — cursor-paginated items (`limit 100`; supports `state`, `batch`, `q`, `after=<last_id>`).
- `GET /api/items/:id` — full item `input`, `configBody`, `error`, `attemptHistory`, and operator `actions`.

### Mutating Endpoints (Require User Approval Unless Pre-Authorized)
Retries and resumes spend API budget. Unless the user explicitly pre-authorized autonomous recovery for the specific failure mode, **diagnose and ask before mutating**:
- `POST /api/jobs/:id/pause` / `POST /api/jobs/:id/resume` (`resume` clears scope cooldowns, reloads `.env` keys for `auth`-held items, and re-queues them).
- `POST /api/items/:id` — `{"action":"retry","patch":{...}}`, `{"action":"skip"}`, or `{"action":"refuse"}`.
- `POST /api/jobs/:id/items/bulk` — `{"action":"retry"|"skip", "ids":[...]|"state":"held"|"waiting"|"skipped"}` (`ids` max 1000).
- `POST /api/jobs/:id/batch-ops` — `{"action":"refuse", ...}` or `{"action":"patch_config", "config":{...}, "retry":true|false, ...}`.
- `DELETE /api/jobs/:id` — requires job idle/paused with `0` running items.

> **Atomic bulk check**: Bulk mutation endpoints validate every target item inside a transaction and reject the entire call if any item transitioned to `running` or `succeeded`. Re-fetch items before retrying a rejected bulk call.

---

## 6. Exporting & Consuming Results

1. **Wait for `state === "completed"`** before calling `GET /api/jobs/:id/export` (or `LLMJobs.results(job_id)`). Exports during `running` read page-by-page and are not an atomic snapshot.
2. **Stream JSONL line-by-line**; each line is one item record containing `query_id`, `state`, `input`, `config`, `result`, `error`, and `attemptHistory`.
3. **Read the right fields**:
   - **Generated text is at `record.result.partial`** (NOT `record.result.text`).
   - Other `record.result` fields when present: `reasoning`, `logprobs` (`{content, reasoning}`), `decision` (System One `answers`), `usage`, `cost`, `currency`, `warnings`, `finishReason`.
4. **Mandatory safety & state checks**:
   - Check `record.state` (`succeeded` vs. `skipped` vs. `held`).
   - **Check `record.result?.contentFiltered === true`**: Content-filtered items are marked `state: "succeeded"` so they do not block jobs. **MUST NOT** treat `record.result.partial` as a valid full completion when `contentFiltered` is `true`.
   - **Check `record.result?.manualRefusal === true`**: Operator-marked refusals also have `state: "succeeded"` and `record.result.partial === "I cannot answer."`.
5. **Cost reporting**: Report only API-reported `cost` + `currency` and token totals from `GET /api/jobs/:id` (`totals`) or exported records. **MUST NOT** estimate dollar amounts from token counts.
