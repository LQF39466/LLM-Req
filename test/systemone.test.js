import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { validateConfig } from "../src/policy.js";
import { invoke, protocol } from "../src/providers.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";

const models = ["gemini-decision-1", "jev-1.13"];
const questions = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [
  `q${i + 1}`,
  {
    type: "choice",
    instructions: `Does condition ${i + 1} apply?`,
    criteria: { Yes: "The condition applies", No: "The condition does not apply" },
  },
]));
const config = (model) => ({ provider: "opencode", model, questions });

test("routes OpenCode decision models ahead of the generic Gemini and chat rules", () => {
  for (const model of models) {
    assert.equal(protocol(validateConfig(config(model))), "systemone");
    assert.throws(() => validateConfig({ ...config(model), protocol: "chat" }), /systemone/);
    assert.throws(() => validateConfig({ ...config(model), questions: {} }), /questions/);
    assert.throws(() => validateConfig({ ...config(model), logprobs: true }), /不支持/);
  }
  assert.equal(protocol({ provider: "opencode", model: "gemini-4-argon" }), "google");
  assert.throws(() => validateConfig({ ...config("gemini-4-argon") }), /questions/);
});

test("submits 22 binary choices, preserves probabilities in the job result, and detects omission", async (t) => {
  const requests = [];
  let omitProbability = false;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [
      id,
      { type: "choice", choice: "Yes", confidence: 0.62, probabilities: { Yes: 0.8, No: 0.2 } },
    ]));
    if (omitProbability) delete answers.q22.probabilities.No;
    res.writeHead(200, { "Content-Type": "application/json", "X-Request-Id": "fixture-request" });
    res.end(JSON.stringify({
      model: body.model,
      answers,
      usage: { input_tokens: 42, output_tokens: 0, cost: 0.001 },
    }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const savedKey = process.env.OPENCODE_API_KEY;
  const savedBase = process.env.OPENCODE_BASE_URL;
  process.env.OPENCODE_API_KEY = "fixture-key";
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${upstream.address().port}/inference`;
  t.after(() => {
    for (const [key, value] of [["OPENCODE_API_KEY", savedKey], ["OPENCODE_BASE_URL", savedBase]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const store = new Store(":memory:");
  t.after(() => store.db.close());
  const job = store.begin({ batches: models.map((model) => ({ id: model, config: config(model) })) });
  store.append(job, models.map((model) => ({ id: model, batch: model, prompt: "trajectory" })));
  store.seal(job);
  const scheduler = new Scheduler(store, { call: invoke, probeInterval: 0 });
  const deadline = Date.now() + 3000;
  while (store.get("SELECT state FROM jobs WHERE id = ?", job.id).state !== "completed" &&
         Date.now() < deadline) {
    scheduler.tick();
    await setTimeout(10);
  }
  assert.equal(requests.length, 2);
  for (const model of models) {
    const req = requests.find((r) => r.body.model === model);
    assert.equal(req.url, "/inference/systemone/v1/systemone");
    assert.equal(req.auth, "Bearer fixture-key");
    assert.deepEqual(req.body, { model, state: "trajectory", questions });
    const row = store.get("SELECT state, result FROM items WHERE query_id = ?", model);
    assert.equal(row.state, "succeeded");
    const result = JSON.parse(row.result);
    assert.equal(result.decision.model, model);
    assert.equal(Object.keys(result.decision.answers).length, 22);
    assert.deepEqual(result.decision.answers.q22.probabilities, { Yes: 0.8, No: 0.2 });
    assert.equal(result.requestId, "fixture-request");
    assert.equal(result.usage.inputTokens, 42);
    assert.equal(result.cost, 0.001);
  }
  omitProbability = true;
  await assert.rejects(invoke(config(models[0]), { prompt: "trajectory" }), /q22 缺少有效答案或完整选项概率/);
});
