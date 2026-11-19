import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { validateConfig } from '../src/policy.js';
import { bodyOptions, errorRecord, invoke, protocol } from '../src/providers.js';

const config = (thinking, transport) => validateConfig({
  provider: 'openai', model: 'gpt-test',
  ...(thinking === undefined ? {} : { thinking }),
  ...(transport === undefined ? {} : { protocol: transport }),
});

test('official OpenAI defaults to Responses and maps unified thinking without vendor fields', () => {
  assert.equal(protocol(config()), 'responses');
  assert.equal(protocol(config(undefined, 'chat')), 'chat');
  assert.deepEqual(bodyOptions(config(), 'responses'), {});
  for (const effort of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const native = effort === 'off' ? 'none' : effort;
    assert.deepEqual(bodyOptions(config(effort), 'responses'), { reasoning: { effort: native } });
    assert.deepEqual(bodyOptions(config(effort, 'chat'), 'chat'), { reasoning_effort: native });
  }
  for (const transport of ['google', 'anthropic'])
    assert.throws(() => config(undefined, transport), /OpenAI/);
  for (const transport of ['responses', 'chat'])
    assert.throws(() => bodyOptions(config({ enabled: true, budget: 2048 }, transport), transport), /budget/);
});

test('official OpenAI sends native paths/auth, streams text and usage, and redacts its key', async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  const oldBase = process.env.OPENAI_BASE_URL;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_official_fixture' });
    const events = req.url === '/v1/responses' ? [
      { type: 'response.created', response: { id: 'resp_fixture', created_at: 1, model: 'gpt-test' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_fixture', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_fixture', delta: 'hello' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_fixture', type: 'message' } },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ] : [
      { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] },
      { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (req.url !== '/v1/responses') res.write('data: [DONE]\n\n');
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.OPENAI_API_KEY = 'fixture-official-secret';
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1/`;
  try {
    for (const [thinking, transport] of [['low', undefined], ['off', undefined],
                                          ['high', 'chat'], ['off', 'chat'], [undefined, undefined]]) {
      const out = await invoke(config(thinking, transport), { prompt: 'hello' });
      const sent = requests.at(-1);
      assert.equal(sent.path, transport === 'chat' ? '/v1/chat/completions' : '/v1/responses');
      assert.equal(sent.authorization, 'Bearer fixture-official-secret');
      assert.equal(sent.body.thinking, undefined);
      assert.equal(sent.body.stream, true);
      if (transport === 'chat') assert.equal(sent.body.stream_options.include_usage, true);
      if (thinking !== undefined) {
        const effort = transport === 'chat' ? sent.body.reasoning_effort : sent.body.reasoning.effort;
        assert.equal(effort, thinking === 'off' ? 'none' : thinking);
      } else assert.equal(sent.body.reasoning, undefined);
      assert.equal(out.partial, 'hello');
      assert.equal(out.usage.inputTokens, 5);
      assert.equal(out.usage.outputTokens, 2);
      assert.equal(out.cost, null); // Official token usage does not imply an actual billed amount.
      assert.equal(out.requestId, 'req_official_fixture');
    }
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6l8AAAAASUVORK5CYII=';
    const messages = JSON.parse(JSON.stringify([{
      role: 'user',
      content: [{ type: 'text', text: 'Describe this image' }, { type: 'image', image }],
    }]));
    for (const transport of ['responses', 'chat']) {
      const out = await invoke(config(undefined, transport), { messages });
      const { body } = requests.at(-1);
      if (transport === 'responses') {
        assert.deepEqual(body.input[0].content, [
          { type: 'input_text', text: 'Describe this image' },
          { type: 'input_image', image_url: image },
        ]);
      } else {
        assert.deepEqual(body.messages[0].content, [
          { type: 'text', text: 'Describe this image' },
          { type: 'image_url', image_url: { url: image } },
        ]);
      }
      assert.equal(out.partial, 'hello');
    }
    const record = errorRecord({ message: 'fixture-official-secret', responseBody: 'fixture-official-secret' });
    assert.equal(record.message, '[REDACTED]');
    assert.equal(record.body, '[REDACTED]');
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(invoke(config('low'), { prompt: 'x' }), /OPENAI_API_KEY/);
    assert.equal(requests.length, 7); // Missing credentials never reach the upstream.
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = oldBase;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('explicit credential refresh loads a new key from dotenv without exposing or replacing other settings', async () => {
  const { refreshCredentials } = await import('../src/providers.js');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'req-key-test-'));
  const envPath = join(directory, '.env');
  const oldKey = process.env.OPENAI_API_KEY;
  const oldOther = process.env.MIMO_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    process.env.MIMO_API_KEY = 'keep-existing';
    assert.equal(refreshCredentials('openai', envPath), false);
    writeFileSync(envPath, 'OPENAI_API_KEY=\n');
    assert.equal(refreshCredentials('openai', envPath), false);
    writeFileSync(envPath, 'OPENAI_API_KEY="new-local-key"\nMIMO_API_KEY=do-not-load\n');
    assert.equal(refreshCredentials('openai', envPath), true);
    assert.equal(process.env.OPENAI_API_KEY, 'new-local-key');
    assert.equal(process.env.MIMO_API_KEY, 'keep-existing');
    writeFileSync(envPath, 'OPENAI_API_KEY=replaced-local-key\n');
    assert.equal(refreshCredentials('openai', envPath), true);
    assert.equal(process.env.OPENAI_API_KEY, 'replaced-local-key');
    assert.equal(errorRecord({ message: 'replaced-local-key' }).message, '[REDACTED]');
    assert.equal(errorRecord({ message: 'new-local-key' }).message, '[REDACTED]');
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(invoke(config(), { prompt: 'x' }), error => error.code === 'MISSING_API_KEY');
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldOther === undefined) delete process.env.MIMO_API_KEY;
    else process.env.MIMO_API_KEY = oldOther;
    rmSync(directory, { recursive: true, force: true });
  }
});
