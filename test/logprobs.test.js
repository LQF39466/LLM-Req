import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateConfig, classify } from '../src/policy.js';
import { invoke } from '../src/providers.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { app } from '../src/server.js';

const token = { token: 'hello', logprob: -0.2, bytes: [104,101,108,108,111], top_logprobs: [{ token: 'hello', logprob: -0.2, bytes: [104,101,108,108,111] }, { token: 'hi', logprob: -2, bytes: [104,105] }] };
const base = { provider: 'openai', model: 'gpt-6-luna', thinking: 'off', logprobs: true, topLogprobs: 2 };

test('logprobs configuration checks counts, conflicts and exhausted credits', () => {
  assert.deepEqual(validateConfig(base), base);
  for (const config of [
    { ...base, logprobs: 'true' }, { ...base, topLogprobs: -1 },
    { ...base, topLogprobs: 21 }, { ...base, topLogprobs: 1.5 },
    { ...base, logprobs: false }, { ...base, extraBody: { logprobs: true } },
    { ...base, providerOptions: { openai: { logprobs: 2 } } },
    { ...base, provider: 'bailian', topLogprobs: 6 },
  ]) assert.throws(() => validateConfig(config));
  assert.equal(classify({ statusCode: 429, responseBody: '{"code":"credit_balance_exhausted"}' }).kind, 'quota');
});

test('streams chat and Responses probabilities, persists and exports them, and detects silent omission', async () => {
  const requests = [];
  let omit = false, truncate = false;
  const upstream = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push({path: req.url, body});
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const events = req.url === '/v1/responses' ? [
      { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'gpt-6-luna' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_fixture', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', delta: 'hello', ...(omit ? {} : { logprobs: [token] }) },
      { type: 'response.output_text.done', item_id: 'msg_fixture', text: 'hello', logprobs: [token] },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_fixture', type: 'message' } },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
    ] : [
      { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-luna', choices: [{ index: 0, delta: { content: 'hello' }, logprobs: {content: [token], reasoning_content: [{...token, token: 'think'}]}, finish_reason: null }] },
      { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-6-luna', choices: [{ index: 0, delta: {}, finish_reason: truncate ? 'length' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (req.url !== '/v1/responses') res.write('data: [DONE]\n\n');
    res.end();
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const prevKey = process.env.OPENAI_API_KEY, prevBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_API_KEY = 'fixture-key';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
  let store, local;
  try {
    const responses = await invoke(validateConfig(base), { prompt: 'x' });
    assert.deepEqual(responses.logprobs.content, [token]);
    assert.deepEqual(responses.logprobs.reasoning, []);
    assert.equal(requests.at(-1).body.top_logprobs, 2);
    assert.ok(requests.at(-1).body.include.includes('message.output_text.logprobs'));
    assert.equal(requests.at(-1).body.reasoning.effort, 'none');
    const chat = await invoke(validateConfig({...base, protocol:'chat'}), { prompt: 'x' });
    assert.deepEqual(chat.logprobs.content, [token]);
    assert.equal(chat.logprobs.reasoning[0].token, 'think');
    assert.equal(requests.at(-1).body.logprobs, true);
    assert.equal(requests.at(-1).body.top_logprobs, 2);
    assert.equal(requests.at(-1).body.reasoning_effort, 'none');
    omit = true;
    await assert.rejects(invoke(validateConfig(base), {prompt:'x'}), /没有返回输出 Token 概率/);
    omit = false;
    store = new Store(':memory:');
    const scheduler = new Scheduler(store, { call: invoke, probeInterval: 0 });
    const job = store.begin({batches:[{id:'main', config:base}]});
    store.append(job, [{id:'q',batch:'main',prompt:'x'}]); store.seal(job);
    scheduler.tick();
    const deadline = Date.now() + 3000;
    while (scheduler.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.get('SELECT state FROM items').state, 'succeeded');
    assert.deepEqual(JSON.parse(store.get('SELECT result FROM items').result).logprobs.content, [token]);
    local = app(store, scheduler); local.listen(0, '127.0.0.1'); await once(local, 'listening');
    const response = await fetch(`http://127.0.0.1:${local.address().port}/api/jobs/${job.id}/export`);
    const exported = JSON.parse((await response.text()).trim());
    assert.deepEqual(exported.result.logprobs.content, [token]);
    assert.equal(exported.config.topLogprobs, 2);
    truncate = true;
    const failed = store.begin({batches:[{id:'main', config:{...base, protocol:'chat'}}]});
    store.append(failed, [{id:'q',batch:'main',prompt:'x'}]); store.seal(failed);
    scheduler.tick();
    const failureDeadline = Date.now() + 3000;
    while (scheduler.active.size && Date.now() < failureDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(store.get('SELECT state FROM items WHERE job=?', failed.id).state, 'held');
    const attempt = store.get('SELECT partial FROM attempts WHERE item=(SELECT id FROM items WHERE job=?)', failed.id);
    assert.deepEqual(JSON.parse(attempt.partial).logprobs.content, [token]);
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevBase;
    if (local) { local.closeAllConnections(); await new Promise(r => local.close(r)); }
    store?.db.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  }
});
