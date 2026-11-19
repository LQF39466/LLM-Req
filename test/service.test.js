import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { invoke } from "../src/providers.js";
import { decide, classify } from "../src/policy.js";
import { app } from "../src/server.js";
const config = { provider: "deepseek", model: "test-model", temperature: 0.2 };
const success = {
  partial: "ok",
  usage: { inputTokens: 4, outputTokens: 2 },
  cost: null,
};
function job(
  s,
  batches = [{ id: "a", config }],
  queries = [
    { id: "1", batch: "a", prompt: "hello" },
    { id: "2", batch: "a", prompt: "world" },
  ],
) {
  const imp = s.begin({ name: "test", batches });
  s.append(imp, queries);
  s.seal(imp);
  return imp.id;
}
async function tick(w, n = 1) {
  for (let i = 0; i < n; i++) {
    w.tick();
    await new Promise((r) => setImmediate(r));
  }
}
function fixture(call, opts = {}) {
  const s = new Store(":memory:");
  let now = 1_000_000;
  const w = new Scheduler(s, {
    call,
    clock: () => now,
    probeInterval: 0,
    ...opts,
  });
  return { s, w, advance: (n) => (now += n) };
}
test("deduplicates preflight config and reuses successful samples", async () => {
  let calls = 0;
  const { s, w } = fixture(async () => {
    calls++;
    return success;
  });
  const id = job(
    s,
    [
      { id: "a", config },
      { id: "b", config },
    ],
    [
      { id: "1", batch: "a", prompt: "one" },
      { id: "2", batch: "b", prompt: "two" },
    ],
  );
  await tick(w, 2);
  assert.equal(calls, 1);
  assert.equal(s.get("SELECT state FROM jobs WHERE id=?", id).state, "running");
  await tick(w, 4);
  assert.equal(calls, 2);
  assert.equal(
    s.get("SELECT state FROM jobs WHERE id=?", id).state,
    "completed",
  );
  s.db.close();
});
test("preflight parameter failure blocks whole job; later errors only hold item", async () => {
  let fail = true;
  const { s, w } = fixture(async () => {
    if (fail)
      throw Object.assign(Error("invalid temperature"), { statusCode: 400 });
    return success;
  });
  const id = job(s);
  await tick(w, 3);
  assert.equal(
    s.get("SELECT state FROM jobs WHERE id=?", id).state,
    "preflight_blocked",
  );
  assert.equal(s.get("SELECT count(*) n FROM attempts").n, 1);
  fail = false;
  w.itemAction(1, "retry");
  await tick(w, 2);
  fail = true;
  await tick(w, 3);
  assert.equal(s.get("SELECT state FROM items WHERE id=2").state, "held");
  assert.equal(
    s.get("SELECT state FROM jobs WHERE id=?", id).state,
    "needs_attention",
  );
  s.db.close();
});
test("timeout waits five minutes, pins preflight sample and hangs on second interruption", async () => {
  let calls = 0;
  const { s, w, advance } = fixture(async () => {
    calls++;
    throw Object.assign(Error("timeout"), { name: "TimeoutError" });
  });
  job(s);
  await tick(w, 3);
  assert.equal(calls, 1);
  assert.equal(s.get("SELECT state FROM jobs").state, "preflight");
  advance(299999);
  await tick(w);
  assert.equal(calls, 1);
  advance(1);
  await tick(w);
  assert.equal(calls, 2);
  assert.equal(s.get("SELECT state FROM items WHERE id=1").state, "held");
  assert.equal(s.get("SELECT attempts FROM items WHERE id=1").attempts, 2);
  s.db.close();
});
test("429 snapshots in-flight before removal, fixes 70%, does not count attempts", async () => {
  let pending = [];
  const { s, w, advance } = fixture(async (c, q) => {
    if (q.id === "1") return success;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const id = job(
    s,
    [{ id: "a", config }],
    Array.from({ length: 8 }, (_, i) => ({
      id: String(i + 1),
      batch: "a",
      prompt: "x",
    })),
  );
  await tick(w, 6);
  assert.equal(pending.length, 4);
  pending[0].reject(Object.assign(Error("rate limit"), { statusCode: 429 }));
  await new Promise((r) => setImmediate(r));
  assert.equal(w.control("deepseek").cap, 2);
  assert.equal(w.control("deepseek").mode, "fixed");
  assert.equal(s.get("SELECT attempts FROM items WHERE id=2").attempts, 0);
  assert.equal(s.get("SELECT counted FROM attempts WHERE item=2").counted, 0);
  for (const x of pending.slice(1)) x.resolve(success);
  await new Promise((r) => setImmediate(r));
  advance(60000);
  await tick(w);
  assert.ok(w.active.size <= 2);
  for (const x of pending.slice(4)) x.resolve(success);
  await new Promise((r) => setImmediate(r));
  s.db.close();
});
test("three transient attempts then held; manual cycle retains history", async () => {
  const { s, w, advance } = fixture(async () => {
    throw Object.assign(Error("server error"), { statusCode: 503 });
  });
  job(s);
  for (let n = 0; n < 3; n++) {
    await tick(w);
    advance(120000);
  }
  assert.equal(s.get("SELECT state FROM items WHERE id=1").state, "held");
  assert.equal(s.get("SELECT attempts FROM items WHERE id=1").attempts, 3);
  w.itemAction(1, "retry");
  assert.equal(s.get("SELECT count(*) n FROM attempts").n, 3);
  assert.equal(s.get("SELECT attempts FROM items WHERE id=1").attempts, 0);
  s.db.close();
});
test("recovery preserves succeeded results and marks only running attempt uncertain", () => {
  const s = new Store(":memory:");
  job(s);
  s.run("UPDATE items SET state='succeeded',result='{}' WHERE id=1");
  s.run("UPDATE items SET state='running',attempts=1 WHERE id=2");
  s.run(
    "INSERT INTO attempts(id,item,started,state) VALUES('crash',2,0,'running')",
  );
  s.recover();
  assert.equal(s.get("SELECT state FROM items WHERE id=1").state, "succeeded");
  const row = s.get("SELECT * FROM items WHERE id=2");
  assert.equal(row.state, "waiting");
  assert.equal(row.interruptions, 1);
  assert.ok(row.next > Date.now() + 299000);
  s.recover();
  assert.equal(
    s.get("SELECT interruptions FROM items WHERE id=2").interruptions,
    1,
  );
  s.db.close();
});
test("Bailian TPM quota is rate limit, MiMo 421 content, unsent excluded", () => {
  assert.equal(
    classify(Object.assign(Error("insufficient_quota"), { statusCode: 429 }))
      .kind,
    "rate",
  );
  assert.equal(
    classify(Object.assign(Error("blocked"), { statusCode: 421 })).kind,
    "content",
  );
  assert.equal(
    classify(
      Object.assign(Error("fetch failed"), { cause: { code: "ENOTFOUND" } }),
    ).count,
    false,
  );
  assert.equal(decide("transient", 3, 0).state, "held");
});
test("HTTP streaming import is atomic and duplicate IDs never dispatch", async () => {
  const { s, w } = fixture(async () => success);
  const server = app(s, w);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const head = JSON.stringify({ batches: [{ id: "a", config }] });
    const q = JSON.stringify({ id: "same", batch: "a", prompt: "x" });
    const r = await fetch(base + "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: head + "\n" + q + "\n" + q,
    });
    assert.equal(r.status, 400);
    assert.equal(s.jobs().length, 0);
    const ok = await fetch(base + "/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/x-ndjson" },
      body: head + "\n" + q,
    });
    assert.equal(ok.status, 201);
    assert.equal(s.jobs()[0].state, "preflight");
    const denied = await fetch(base + "/api/jobs", {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(denied.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
test("real AI SDK streaming adapter captures usage, cost, thinking and rejects cut-off streams", async () => {
  const oldKey = process.env.OPENCODE_API_KEY,
    oldBase = process.env.OPENCODE_BASE_URL;
  let mode = "ok",
    received;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          id: "test",
          object: "chat.completion.chunk",
          created: 1,
          model: "test",
          choices: [
            { index: 0, delta: { content: "hello" }, finish_reason: null },
          ],
        }) +
        "\n\n",
    );
    if (mode !== "cut") {
      res.write(
        "data: " +
          JSON.stringify({
            id: "test",
            object: "chat.completion.chunk",
            created: 1,
            model: "test",
            choices: [{ index: 0, delta: {}, finish_reason: mode === "filtered" ? "content_filter" : "stop" }],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
              cost: 0.003,
            },
          }) +
          "\n\n",
      );
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.OPENCODE_API_KEY = "test";
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const c = {
      provider: "opencode",
      model: "test",
      thinking: "high",
    };
    const out = await invoke(c, { prompt: "hello" });
    assert.equal(out.partial, "hello");
    assert.equal(out.cost, 0.003);
    assert.equal(out.currency, "USD");
    assert.equal(out.usage.inputTokens, 5);
    assert.equal(received.thinking.type, "enabled");
    assert.equal(received.reasoning_effort, "high");
    await invoke({ ...c, thinking: "off" }, { prompt: "x" });
    assert.equal(received.thinking.type, "disabled");
    assert.equal(received.reasoning_effort, undefined);
    assert.equal(received.stream_options.include_usage, true);
    mode = "filtered";
    await assert.rejects(invoke(c, { prompt: "x" }),
      e => classify(e).kind === "content" && e.capture.partial === "hello");
    mode = "cut";
    await assert.rejects(
      invoke(c, { prompt: "x" }),
      (e) => classify(e).kind === "interrupted",
    );
  } finally {
    if (oldKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.OPENCODE_BASE_URL;
    else process.env.OPENCODE_BASE_URL = oldBase;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("manual config replacement and skipping all failed samples cannot strand preflight", async () => {
  let bad = true;
  const { s, w } = fixture(async () => {
    if (bad) throw Object.assign(Error("bad parameter"), { statusCode: 400 });
    return success;
  });
  const id = job(
    s,
    [{ id: "a", config }],
    [{ id: "1", batch: "a", prompt: "x" }],
  );
  await tick(w);
  w.itemAction(1, "retry", { config: { ...config, temperature: 0.3 } });
  bad = false;
  await tick(w, 4);
  assert.equal(
    s.get("SELECT state FROM jobs WHERE id=?", id).state,
    "completed",
  );
  s.db.close();
  const f = fixture(async () => {
    throw Object.assign(Error("bad"), { statusCode: 400 });
  });
  const jid = job(
    f.s,
    [{ id: "a", config }],
    [{ id: "1", batch: "a", prompt: "x" }],
  );
  await tick(f.w);
  f.w.itemAction(1, "skip");
  f.w.jobAction(jid, "resume");
  await tick(f.w, 4);
  assert.equal(
    f.s.get("SELECT state FROM jobs WHERE id=?", jid).state,
    "completed",
  );
  f.s.db.close();
});

test("committed WAL survives SIGKILL and stale process lock is reclaimed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { lockDatabase } = await import("../src/lock.js");
  const dir = mkdtempSync(join(tmpdir(), "llm-crash-")),
    path = join(dir, "jobs.sqlite");
  const code = `import {Store} from ${JSON.stringify(new URL("../src/store.js", import.meta.url).href)};import {lockDatabase} from ${JSON.stringify(new URL("../src/lock.js", import.meta.url).href)};lockDatabase(${JSON.stringify(path)});const s=new Store(${JSON.stringify(path)});const j=s.begin({batches:[{id:'a',config:{provider:'deepseek',model:'test'}}]});s.append(j,[{id:'1',batch:'a',prompt:'x'}]);s.seal(j);s.tx(()=>{s.run("UPDATE items SET state='running',attempts=1");s.run("INSERT INTO attempts(id,item,started,state) VALUES('a',1,0,'running')");});console.log('ready');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await once(child.stdout, "data");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const release = lockDatabase(path);
    const s = new Store(path);
    s.recover();
    assert.equal(s.get("SELECT state FROM items").state, "waiting");
    assert.equal(s.get("SELECT state FROM attempts").state, "uncertain");
    assert.throws(() => lockDatabase(path), /使用/);
    s.db.close();
    release();
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode Anthropic and Google protocol paths parse streams and cost", async () => {
  const oldKey = process.env.OPENCODE_API_KEY,
    oldBase = process.env.OPENCODE_BASE_URL;
  let path, received, blocked = false;
  const server = createServer(async (req, res) => {
    path = req.url;
    let body = "";
    for await (const b of req) body += b;
    received = JSON.parse(body);
    assert.equal(req.headers.authorization, "Bearer fixture");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = blocked ? [{ promptFeedback: { blockReason: "SAFETY" } }] : path.includes("anthropic")
      ? [
          {
            type: "message_start",
            message: {
              id: "msg_1",
              role: "assistant",
              model: "claude-test",
              usage: { input_tokens: 5, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 2, cost: 0.02 },
          },
          { type: "message_stop" },
        ]
      : [
          {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "hello" }] },
                finishReason: "STOP",
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 2,
              totalTokenCount: 7,
              cost: 0.03,
            },
          },
        ];
    for (const event of events)
      res.write(
        (event.type ? `event: ${event.type}\n` : "") +
          `data: ${JSON.stringify(event)}\n\n`,
      );
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.OPENCODE_API_KEY = "fixture";
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    let out = await invoke(
      {
        provider: "opencode",
        model: "claude-test",
        maxOutputTokens: 100,
        thinking: "low",
      },
      { prompt: "x" },
    );
    assert.equal(path, "/anthropic/v1/messages");
    assert.deepEqual(received.thinking, { type: "adaptive" });
    assert.equal(received.output_config.effort, "low");
    assert.equal(out.partial, "hello");
    assert.equal(out.cost, 0.02);
    assert.equal(out.usage.inputTokens, 5);
    out = await invoke(
      {
        provider: "opencode",
        model: "gemini-test",
        maxOutputTokens: 100,
        thinking: "low",
      },
      { prompt: "x" },
    );
    assert.ok(
      path.startsWith(
        "/google/v1beta/models/gemini-test:streamGenerateContent",
      ),
    );
    assert.equal(out.partial, "hello");
    assert.equal(out.cost, 0.03);
    assert.equal(out.usage.inputTokens, 5);
    assert.equal(received.generationConfig.thinkingConfig.thinkingLevel, "low");
    assert.equal(
      received.generationConfig.thinkingConfig.thinkingBudget,
      undefined,
    );
    await invoke(
      { provider: "opencode", model: "gemini-test", thinking: "off" },
      { prompt: "x" },
    );
    assert.equal(received.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.equal(
      received.generationConfig.thinkingConfig.thinkingLevel,
      undefined,
    );
  } finally {
    if (oldKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.OPENCODE_BASE_URL;
    else process.env.OPENCODE_BASE_URL = oldBase;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("Python generator submits chunked JSONL and reads status/results", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const { s, w } = fixture(async () => success);
  const server = app(s, w);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const script = `import sys,json\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL("../examples", import.meta.url)))})\nfrom python_client import LLMJobs\nc=LLMJobs('http://127.0.0.1:${server.address().port}')\nj=c.submit(name='python',submission_key='python-test',batches=[{'id':'a','config':{'provider':'deepseek','model':'test'}}],queries=({'id':str(i),'batch':'a','prompt':'测试'} for i in range(1000)))\ns=c.status(j)\nprint(json.dumps({'state':s['state'],'count':s['counts']['queued'],'exported':sum(1 for x in c.results(j))}))\n`;
    const { stdout } = await promisify(execFile)("python3", ["-c", script]);
    assert.deepEqual(JSON.parse(stdout), {
      state: "preflight",
      count: 1000,
      exported: 1000,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});

test("OpenCode Responses routes GPT and retains raw cost", async () => {
  const oldKey = process.env.OPENCODE_API_KEY,
    oldBase = process.env.OPENCODE_BASE_URL;
  let path, received;
  const server = createServer(async (req, res) => {
    path = req.url;
    let body = "";
    for await (const b of req) body += b;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      {
        type: "response.created",
        response: { id: "resp_1", created_at: 1, model: "gpt-test" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "msg_1", type: "message" },
      },
      { type: "response.output_text.delta", item_id: "msg_1", delta: "hello" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "msg_1", type: "message" },
      },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
            cost: 0.04,
          },
        },
      },
    ])
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.OPENCODE_API_KEY = "fixture";
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const out = await invoke(
      { provider: "opencode", model: "gpt-test", thinking: "high" },
      { prompt: "x" },
    );
    assert.equal(path, "/openai/v1/responses");
    assert.equal(received.reasoning.effort, "high");
    assert.equal(out.partial, "hello");
    assert.equal(out.cost, 0.04);
  } finally {
    if (oldKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.OPENCODE_BASE_URL;
    else process.env.OPENCODE_BASE_URL = oldBase;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("a burst of 429s reduces pacing once per dispatch epoch, then recovers gradually", async () => {
  const pending = [];
  const { s, w, advance } = fixture(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    { probeInterval: 100 },
  );
  job(
    s,
    [{ id: "a", config }],
    Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      batch: "a",
      prompt: "fixture",
    })),
  );
  s.run("UPDATE configs SET checked=1");
  s.run("UPDATE jobs SET state='running'");
  const flush = () => new Promise((r) => setImmediate(r));
  const limited = (index, retryAfter = 0) => {
    pending[index].reject(
      Object.assign(Error("rate limit"), {
        statusCode: 429,
        capture: { retryAfter },
      }),
    );
    return flush();
  };
  const launch = async (count, spacing) => {
    for (let i = 0; i < count; i++) {
      await tick(w);
      advance(spacing);
    }
  };
  await launch(50, 100);
  for (let i = 0; i < 8; i++) await limited(i);
  const ctl = w.control("deepseek");
  assert.equal(ctl.cap, 35);
  assert.equal(ctl.interval, 100);
  assert.equal(ctl.epoch, 1);
  for (const p of pending.slice(9)) p.resolve(success);
  await flush();
  assert.equal(ctl.healthy, 0, "old successes cannot undo congestion control");
  advance(60000);
  await launch(10, 100);
  assert.equal(pending.length, 60);
  await limited(50);
  assert.equal(ctl.interval, 250);
  assert.equal(ctl.epoch, 2);
  await limited(8); // Very late response from the original probe.
  for (let i = 51; i < 60; i++) await limited(i);
  assert.equal(ctl.interval, 250);
  assert.equal(ctl.epoch, 2);
  assert.equal(s.get("SELECT sum(attempts) n FROM items").n, 41);
  advance(60000);
  await launch(10, 250);
  for (const p of pending.slice(60, 69)) p.resolve(success);
  await flush();
  assert.equal(ctl.interval, 250, "nine successes do not recover the rate");
  advance(60000);
  pending[69].resolve(success);
  await flush();
  assert.equal(ctl.interval, 125);
  assert.equal(ctl.cap, 35);
  await launch(10, 125);
  advance(60000);
  for (const p of pending.slice(70)) p.resolve(success);
  await flush();
  assert.equal(ctl.interval, 100);
  assert.equal(w.active.size, 0);
  s.db.close();
});

test("late old-epoch rate errors honor Retry-After without multiplying the interval", async () => {
  const pending = [];
  const { s, w, advance } = fixture(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  );
  job(s);
  s.run("UPDATE configs SET checked=1");
  s.run("UPDATE jobs SET state='running'");
  await tick(w, 2);
  pending[0].reject(Object.assign(Error("rate limit"), { statusCode: 429 }));
  await new Promise((r) => setImmediate(r));
  const ctl = w.control("deepseek"),
    firstCooldown = ctl.cooldown;
  advance(1000);
  pending[1].reject(
    Object.assign(Error("rate limit"), {
      statusCode: 429,
      capture: { retryAfter: 120000 },
    }),
  );
  await new Promise((r) => setImmediate(r));
  assert.equal(ctl.epoch, 1);
  assert.equal(ctl.interval, 0);
  assert.equal(ctl.cooldown, firstCooldown + 61000);
  assert.equal(ctl.next, ctl.cooldown);
  s.db.close();
});

test("legacy pacing migration preserves concurrency and cooldown and runs only once", () => {
  const s = new Store(":memory:");
  s.run(
    "INSERT INTO controls VALUES(?,?)",
    "deepseek",
    JSON.stringify({
      mode: "fixed",
      cap: 35,
      interval: 32000,
      next: 1032000,
      cooldown: 1120000,
      failures: 0,
      observed: 50,
    }),
  );
  const w = new Scheduler(s, { clock: () => 1000000 });
  const ctl = w.control("deepseek");
  assert.equal(ctl.cap, 35);
  assert.equal(ctl.interval, 250);
  assert.equal(ctl.next, 1120000);
  assert.equal(ctl.cooldown, 1120000);
  assert.equal(ctl.migration.previousInterval, 32000);
  ctl.interval = 500;
  ctl.healthy = 9;
  w.save("deepseek");
  const reloaded = new Scheduler(s, { clock: () => 1100000 }).control(
    "deepseek",
  );
  assert.equal(reloaded.interval, 500);
  assert.equal(reloaded.healthy, 0);
  assert.equal(reloaded.version, 2);
  s.db.close();
});

test("moderation blocks complete preflight and normal items without retry, retaining partial output and billing", async () => {
  let calls = 0;
  const { s, w } = fixture(async () => {
    calls++;
    throw Object.assign(Error('Content policy block'), {
      statusCode: 421,
      capture: { partial: 'partial answer before block', reasoning: 'partial reasoning',
                 usage: { inputTokens: 4, outputTokens: 2 }, cost: 0.01, currency: 'USD' },
    });
  });
  const id = job(s);
  await tick(w, 8);
  assert.equal(calls, 2);
  assert.equal(s.summary(id).state, 'completed');
  assert.deepEqual(s.summary(id).counts, { succeeded: 2 });
  for (const row of s.all('SELECT * FROM items')) {
    const result = JSON.parse(row.result);
    assert.equal(row.error, null);
    assert.equal(result.contentFiltered, true);
    assert.equal(result.finishReason, 'content-filter');
    assert.equal(result.contentFilter.status, 421);
    assert.equal(result.partial, 'partial answer before block');
    assert.equal(result.cost, 0.01);
  }
  assert.equal(s.summary(id).totals.deepseek.cost.USD, 0.02);
  assert.ok(s.all('SELECT * FROM attempts').every(a => a.state === 'succeeded'));
  assert.equal(decide('content', 3, 0).state, 'succeeded');
  assert.equal(classify({ kind: 'content', statusCode: 400, message: 'blocked' }).kind, 'content');
  assert.equal(classify({ statusCode: 400, message: 'unsupported safety setting' }).kind, 'parameter');
  s.db.close();
});

test("startup adopts old content holds without resending and preserves other errors and paused jobs", async () => {
  let calls = 0;
  const { s, w } = fixture(async () => { calls++; return success; });
  const id = job(s);
  const reason = JSON.stringify({ kind: 'content', status: 421, message: 'old moderation block' });
  s.run("UPDATE items SET state='held',attempts=1,error=? WHERE id=1", reason);
  s.run("INSERT INTO attempts(id,item,started,ended,state,error,partial,cost,currency) VALUES('old',1,1,2,'failed',?,?,0.02,'USD')",
        reason, JSON.stringify({ text: 'old partial', reasoning: 'old reasoning' }));
  s.run("UPDATE jobs SET state='preflight_blocked',error=? WHERE id=?", reason, id);
  const paused = job(s);
  const pausedItems = s.all('SELECT * FROM items WHERE job=?', paused);
  s.run("UPDATE items SET state='held',error=? WHERE id=?", reason, pausedItems[0].id);
  s.run("UPDATE items SET state='held',error=? WHERE id=?", JSON.stringify({ kind: 'auth' }), pausedItems[1].id);
  s.run("UPDATE jobs SET state='paused' WHERE id=?", paused);
  s.recover();
  s.recover(); // Migration is idempotent.
  const result = JSON.parse(s.get('SELECT result FROM items WHERE id=1').result);
  assert.equal(result.contentFiltered, true);
  assert.equal(result.partial, 'old partial');
  assert.equal(result.cost, 0.02);
  assert.equal(s.summary(paused).state, 'paused');
  assert.equal(s.get('SELECT state FROM items WHERE id=?', pausedItems[1].id).state, 'held');
  await tick(w, 6);
  assert.equal(calls, 1); // Only the originally queued item runs.
  assert.equal(s.summary(id).state, 'completed');
  assert.equal(s.get("SELECT state FROM attempts WHERE id='old'").state, 'failed'); // History retained.
  s.db.close();
});

test('Python streaming upload exposes early configuration and duplicate-key errors instead of broken pipe', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { s, w } = fixture(async () => success);
  const server = app(s, w);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const script = `import sys,json
sys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../examples', import.meta.url)))})
from python_client import LLMJobs
c=LLMJobs('http://127.0.0.1:${server.address().port}')
base={'provider':'openai','model':'gpt-test'}
job=c.submit(name='valid',submission_key='same-key',batches=[{'id':'a','config':base}],queries=[{'id':'1','batch':'a','prompt':'hello'}])
errors=[]
for config,key in [({**base,'thinking':'none'},'invalid-key'),(base,'same-key')]:
 try:
  c.submit(name='invalid',submission_key=key,batches=[{'id':'a','config':config}],queries=({'id':str(i),'batch':'a','prompt':'x'*5000} for i in range(15000)))
 except Exception as e:
  errors.append({'type':type(e).__name__,'message':str(e)})
print(json.dumps({'job':job,'errors':errors}))
`;
    const { stdout } = await promisify(execFile)('python3', ['-c', script], { timeout: 15000 });
    const result = JSON.parse(stdout);
    assert.equal(result.errors.length, 2);
    assert.equal(result.errors[0].type, 'RuntimeError');
    assert.match(result.errors[0].message, /HTTP 400.*thinking/);
    assert.equal(result.errors[1].type, 'RuntimeError');
    assert.ok(result.errors[1].message.includes(result.job));
    assert.equal(s.jobs().length, 1);
    assert.equal(s.get('SELECT count(*) n FROM items').n, 1);
    assert.equal(s.get('SELECT count(*) n FROM attempts').n, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    s.db.close();
  }
});

test('resuming a missing-key block requeues the auth sample and preserves completed work and history', async () => {
  let available = false, reloads = 0, sent = 0;
  const { s, w } = fixture(async () => {
    if (!available) throw Object.assign(Error('DEEPSEEK_API_KEY missing'), { kind: 'auth', code: 'MISSING_API_KEY' });
    sent++;
    return success;
  }, { reloadCredentials: provider => { assert.equal(provider, 'deepseek'); reloads++; return available; } });
  const id = job(s);
  const paused = job(s);
  w.jobAction(paused, 'pause');
  await tick(w, 4);
  assert.equal(s.summary(id).state, 'preflight_blocked');
  assert.equal(s.get('SELECT attempts FROM items WHERE id=1').attempts, 0);
  assert.equal(s.get('SELECT counted FROM attempts WHERE item=1').counted, 0);
  assert.throws(() => w.jobAction(id, 'resume'), /API_KEY/);
  assert.equal(s.get('SELECT state FROM items WHERE id=1').state, 'held');
  assert.equal(s.summary(id).state, 'preflight_blocked');
  available = true;
  w.jobAction(id, 'resume');
  assert.equal(s.get('SELECT state FROM items WHERE id=1').state, 'queued');
  await tick(w, 8);
  assert.equal(s.summary(id).state, 'completed');
  assert.equal(s.summary(paused).state, 'paused');
  assert.equal(sent, 2);
  assert.equal(reloads, 2);
  assert.equal(s.get('SELECT count(*) n FROM attempts WHERE item=1').n, 2);
  assert.equal(s.get("SELECT count(*) n FROM actions WHERE item=1 AND action='retry'").n, 1);
  s.db.close();
});

test('retrying an auth-held item reloads credentials and does not rerun succeeded items or other errors', async () => {
  let available = false, reloads = 0;
  const sent = [];
  const { s, w } = fixture(async (config, query) => {
    if (query.id === '2' && !available)
      throw Object.assign(Error('missing key'), { kind: 'auth', code: 'MISSING_API_KEY' });
    sent.push(query.id);
    return success;
  }, { reloadCredentials: () => { reloads++; return available; } });
  const id = job(s);
  await tick(w, 6);
  assert.equal(s.summary(id).state, 'needs_attention');
  assert.equal(s.get('SELECT state FROM items WHERE id=1').state, 'succeeded');
  assert.throws(() => w.itemAction(2, 'retry'), /API_KEY/);
  available = true;
  w.itemAction(2, 'retry');
  await tick(w, 6);
  assert.equal(s.summary(id).state, 'completed');
  assert.deepEqual(sent, ['1', '2']);
  assert.equal(reloads, 2);
  const other = job(s);
  s.run("UPDATE items SET state='held',error=? WHERE job=?", JSON.stringify({ kind: 'parameter' }), other);
  s.run("UPDATE jobs SET state='needs_attention' WHERE id=?", other);
  w.jobAction(other, 'resume');
  assert.equal(s.get("SELECT count(*) n FROM items WHERE job=? AND state='held'", other).n, 2);
  assert.equal(reloads, 2);
  s.db.close();
});
