import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { app } from '../src/server.js';
import { classify, decide } from '../src/policy.js';

function job(s, count = 5) {
  const imp = s.begin({ batches: [{ id: 'main', config: { provider: 'openai', model: 'fixture' } }] });
  s.append(imp, Array.from({ length: count }, (_, i) => ({ id: String(i), batch: 'main', prompt: 'fixture' })));
  s.seal(imp);
  return imp.id;
}

test('10ms pacing dispatches toward the cap and an unthrottled saved probe adopts the new interval', async () => {
  const s = new Store(':memory:');
  let now = 1000;
  const pending = [];
  s.run('INSERT INTO controls VALUES(?,?)', 'openai', JSON.stringify({
    version: 2, mode: 'probe', epoch: 0, cap: 3, interval: 100, next: 1100, cooldown: 0, failures: 0,
  }));
  const w = new Scheduler(s, { probeInterval: 10, clock: () => now,
    call: () => new Promise(resolve => pending.push(resolve)) });
  const id = job(s);
  s.run('UPDATE configs SET checked=1');
  s.run("UPDATE jobs SET state='running' WHERE id=?", id);
  assert.equal(w.control('openai').interval, 10);
  const tick = async () => { w.tick(); await new Promise(resolve => setImmediate(resolve)); };
  await tick();
  now += 9; await tick(); assert.equal(w.active.size, 1);
  now += 1; await tick(); assert.equal(w.active.size, 2);
  now += 10; await tick(); assert.equal(w.active.size, 3);
  now += 10; await tick(); assert.equal(w.active.size, 3);
  for (const resolve of pending) resolve({ partial: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  // Existing rate backoff must survive a restart even with a lower minimum.
  const ctl = w.control('openai');
  ctl.epoch = 1; ctl.interval = 500; ctl.cooldown = now + 60000;
  w.save('openai');
  const restored = new Scheduler(s, { probeInterval: 10, clock: () => now }).control('openai');
  assert.equal(restored.interval, 500);
  assert.equal(restored.cooldown, now + 60000);
  s.db.close();
});

test('bulk retry/skip is scoped, atomic, audited, and preserves pauses, successes and request history', () => {
  const s = new Store(':memory:');
  const w = new Scheduler(s);
  const id = job(s);
  const other = job(s, 1);
  s.run("UPDATE jobs SET state='paused' WHERE id=?", id);
  s.run("UPDATE items SET state='held',attempts=2,error=? WHERE id IN (1,2)", JSON.stringify({ kind: 'parameter' }));
  s.run("UPDATE items SET state='waiting' WHERE id=3");
  s.run("UPDATE items SET state='succeeded',result=? WHERE id=4", JSON.stringify({ partial: 'preserve' }));
  s.run("UPDATE items SET state='running' WHERE id=5");
  s.run("INSERT INTO attempts(id,item,started,state) VALUES('old-attempt',1,1,'failed')");
  assert.deepEqual(w.bulkAction(id, { action: 'retry', state: 'held' }), { count: 2 });
  assert.equal(s.summary(id).state, 'paused');
  assert.equal(s.get('SELECT state FROM items WHERE id=1').state, 'queued');
  assert.equal(s.get('SELECT attempts FROM items WHERE id=1').attempts, 0);
  assert.equal(s.get("SELECT state FROM attempts WHERE id='old-attempt'").state, 'failed');
  const auditCount = s.get('SELECT count(*) n FROM actions').n;
  for (const ids of [[3, 4], [3, 5], [3, 6]]) {
    assert.throws(() => w.bulkAction(id, { action: 'skip', ids }));
    assert.equal(s.get('SELECT state FROM items WHERE id=3').state, 'waiting');
    assert.equal(s.get('SELECT count(*) n FROM actions').n, auditCount);
  }
  assert.deepEqual(w.bulkAction(id, { action: 'skip', ids: [3] }), { count: 1 });
  assert.equal(s.get('SELECT state FROM items WHERE id=3').state, 'skipped');
  assert.equal(JSON.parse(s.get('SELECT result FROM items WHERE id=4').result).partial, 'preserve');
  assert.equal(s.get('SELECT state FROM items WHERE id=5').state, 'running');
  assert.equal(s.get('SELECT state FROM items WHERE job=?', other).state, 'queued');
  assert.throws(() => w.bulkAction(id, { action: 'retry', state: 'succeeded' }));
  assert.throws(() => w.bulkAction(id, { action: 'retry', ids: [1, 1] }));
  assert.throws(() => w.bulkAction(id, { action: 'retry', ids: [1], state: 'held' }));
  assert.throws(() => w.bulkAction(id, { action: 'retry', state: 'held', patch: {} }));
  s.db.close();
});

test('bulk auth retry reloads credentials before changing any rows and restarts a blocked job', () => {
  const s = new Store(':memory:');
  let available = false;
  const w = new Scheduler(s, { reloadCredentials: () => available });
  const id = job(s, 2);
  s.run("UPDATE jobs SET state='preflight_blocked' WHERE id=?", id);
  s.run("UPDATE items SET state='held',error=? WHERE id=1", JSON.stringify({ kind: 'auth' }));
  s.run("UPDATE items SET state='held',error=? WHERE id=2", JSON.stringify({ kind: 'parameter' }));
  assert.throws(() => w.bulkAction(id, { action: 'retry', state: 'held' }), /API_KEY/);
  assert.deepEqual(s.summary(id).counts, { held: 2 });
  assert.equal(s.get('SELECT count(*) n FROM actions').n, 0);
  available = true;
  assert.deepEqual(w.bulkAction(id, { action: 'retry', state: 'held' }), { count: 2 });
  assert.deepEqual(s.summary(id).counts, { queued: 2 });
  assert.equal(s.summary(id).state, 'preflight');
  s.db.close();
});

test('bulk HTTP filtering applies across pages and never touches completed items', async () => {
  const s = new Store(':memory:');
  const w = new Scheduler(s);
  const id = job(s, 250);
  s.run("UPDATE items SET state='held'");
  s.run("UPDATE items SET state='succeeded' WHERE id<=5");
  const server = app(s, w);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/jobs/${id}/items/bulk`;
    let response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip', ids: [1, 6] }) });
    assert.equal(response.status, 400);
    assert.deepEqual(s.summary(id).counts, { held: 245, succeeded: 5 });
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'skip', state: 'held' }) });
    assert.deepEqual(await response.json(), { ok: true, count: 245 });
    assert.deepEqual(s.summary(id).counts, { skipped: 245, succeeded: 5 });
    assert.equal(s.summary(id).state, 'completed');
    assert.equal(s.get('SELECT count(*) n FROM actions').n, 245);
    assert.equal(s.get('SELECT count(*) n FROM attempts').n, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    s.db.close();
  }
});

test('explicit upstream JSON failures are retryable with a finite budget, while invalid parameters still block', () => {
  const error = { statusCode: 400, message: 'Upstream request failed: [api_error] Upstream response was not valid JSON' };
  assert.equal(classify(error).kind, 'transient');
  assert.equal(decide(classify(error).kind, 1, 0).state, 'waiting');
  assert.equal(decide(classify(error).kind, 3, 0).state, 'held');
  assert.equal(classify({ statusCode: 400, message: 'InvalidParameter: request body is not valid JSON' }).kind, 'parameter');
});

test('manual resume clears provider and item waits, preserves pacing/history, and dispatches immediately', async () => {
  const s = new Store(':memory:');
  let sent = 0;
  const w = new Scheduler(s, { clock: () => 1000, call: async () => { sent++; return { partial: 'ok' }; } });
  const id = job(s, 3), other = job(s, 1);
  s.run('UPDATE configs SET checked=1');
  s.run("UPDATE jobs SET state='paused'");
  s.run("UPDATE items SET state='waiting',next=301000,attempts=1,error=?", JSON.stringify({ kind: 'rate' }));
  const items = s.all('SELECT id FROM items WHERE job=? ORDER BY id', id);
  s.run("UPDATE items SET state='succeeded',result=? WHERE id=?", JSON.stringify({ partial: 'keep' }), items[1].id);
  s.run("UPDATE items SET state='held',error=? WHERE id=?", JSON.stringify({ kind: 'parameter' }), items[2].id);
  s.run("INSERT INTO attempts(id,item,started,state) VALUES('history',?,1,'failed')", items[0].id);
  Object.assign(w.control('openai'), { cooldown: 301000, next: 301000, failures: 4, mode: 'fixed', cap: 3, interval: 500, epoch: 2 });
  Object.assign(w.control('mimo'), { cooldown: 999999, next: 999999 });
  w.jobAction(id, 'resume');
  const ctl = w.control('openai');
  assert.equal(ctl.cooldown, 0);
  assert.equal(ctl.next, 1000);
  assert.equal(ctl.failures, 0);
  assert.equal(ctl.cap, 3);
  assert.equal(ctl.interval, 500);
  assert.equal(ctl.mode, 'fixed');
  assert.equal(ctl.resumeEpoch, 3);
  assert.equal(JSON.parse(s.get('SELECT body FROM controls WHERE provider=?', 'openai').body).cooldown, 0);
  assert.equal(w.control('mimo').cooldown, 999999);
  assert.equal(s.get('SELECT next FROM items WHERE id=?', items[0].id).next, 0);
  assert.equal(s.get('SELECT attempts FROM items WHERE id=?', items[0].id).attempts, 1);
  assert.equal(s.get('SELECT count(*) n FROM attempts').n, 1);
  assert.equal(s.get('SELECT state FROM items WHERE id=?', items[2].id).state, 'held');
  assert.equal(s.summary(other).state, 'paused');
  assert.equal(s.get('SELECT next FROM items WHERE job=?', other).next, 301000);
  w.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 1);
  assert.equal(s.get('SELECT state FROM items WHERE id=?', items[0].id).state, 'succeeded');
  assert.equal(JSON.parse(s.get('SELECT result FROM items WHERE id=?', items[1].id).result).partial, 'keep');
  await w.stop();
  s.db.close();
});

test('manual resume ignores stale in-flight cooldowns but new rate errors still cool down', async () => {
  for (const kind of ['rate', 'unsent', 'transient']) {
    const s = new Store(':memory:');
    let rejectCall;
    const w = new Scheduler(s, { clock: () => 1000,
      call: () => new Promise((resolve, reject) => { rejectCall = reject; }) });
    const id = job(s, 2);
    s.run('UPDATE configs SET checked=1');
    s.run("UPDATE jobs SET state='running'");
    w.tick();
    await new Promise(resolve => setImmediate(resolve));
    const ctl = w.control('openai');
    ctl.cooldown = 301000;
    ctl.failures = 2;
    w.jobAction(id, 'resume');
    rejectCall(Object.assign(Error('fixture'), { kind, capture: { retryAfter: 300000 } }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ctl.cooldown, 0, kind);
    assert.equal(ctl.failures, 0, kind);
    ctl.limited({ epoch: ctl.epoch, load: 1 }, 1, false, 60000, 1000);
    assert.equal(ctl.cooldown, 61000, kind);
    await w.stop();
    s.db.close();
  }
});

test('manual refusal is a completed, audited outcome without resending and releases blocked preflight', async () => {
  const s = new Store(':memory:');
  let sent = 0;
  const w = new Scheduler(s, { call: async () => { sent++; return { partial: 'ok' }; } });
  const id = job(s, 2);
  s.run("UPDATE jobs SET state='preflight_blocked',error=?", JSON.stringify({ message: 'blocked' }));
  s.run("UPDATE items SET state='held',attempts=2,error=? WHERE id=1", JSON.stringify({ kind: 'parameter', message: 'original failure' }));
  s.run("INSERT INTO attempts(id,item,started,state,partial) VALUES('original',1,1,'failed',?)", JSON.stringify({ text: 'original partial' }));
  assert.throws(() => w.itemAction(1, 'refuse', { prompt: 'replace' }));
  w.itemAction(1, 'refuse');
  const row = s.get('SELECT * FROM items WHERE id=1'), result = JSON.parse(row.result);
  assert.equal(row.state, 'succeeded');
  assert.equal(row.attempts, 2);
  assert.equal(row.error, null);
  assert.equal(result.manualRefusal, true);
  assert.equal(result.partial, 'I cannot answer.');
  assert.equal(result.manualRefusalReason.originalError.message, 'original failure');
  assert.equal(s.get("SELECT partial FROM attempts WHERE id='original'").partial, JSON.stringify({ text: 'original partial' }));
  assert.equal(s.get("SELECT count(*) n FROM actions WHERE action='manual_refusal'").n, 1);
  assert.equal(s.summary(id).state, 'running');
  assert.equal(s.get('SELECT checked FROM configs').checked, 1);
  assert.equal(sent, 0);
  assert.throws(() => w.itemAction(1, 'refuse'));
  assert.throws(() => w.itemAction(2, 'refuse'));
  w.tick();
  await new Promise(resolve => setImmediate(resolve));
  w.tick();
  assert.equal(sent, 1);
  assert.equal(s.summary(id).state, 'completed');
  await w.stop();
  s.db.close();
});

test('manual refusal HTTP action completes last hold, preserves pauses, and rejects running items', async () => {
  const s = new Store(':memory:');
  const w = new Scheduler(s);
  const id = job(s, 1), paused = job(s, 1), waiting = job(s, 1);
  s.run("UPDATE jobs SET state='needs_attention'");
  s.run("UPDATE jobs SET state='paused' WHERE id=?", paused);
  s.run("UPDATE items SET state='held'");
  s.run("UPDATE items SET state='waiting' WHERE job=?", waiting);
  const server = app(s, w);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const jobId of [id, paused, waiting]) {
      const item = s.get('SELECT id FROM items WHERE job=?', jobId);
      const response = await fetch(`${base}/api/items/${item.id}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'refuse' }) });
      assert.equal(response.status, 200);
    }
    assert.equal(s.summary(id).state, 'completed');
    assert.equal(s.summary(waiting).state, 'completed');
    assert.equal(s.summary(paused).state, 'paused');
    const active = job(s, 1);
    s.run("UPDATE items SET state='running' WHERE job=?", active);
    assert.throws(() => w.itemAction(s.get('SELECT id FROM items WHERE job=?', active).id, 'refuse'), /在途/);
    const response = await fetch(`${base}/api/jobs/${id}/export`);
    const exported = JSON.parse((await response.text()).trim());
    assert.equal(exported.result.manualRefusal, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    s.db.close();
  }
});

test('OpenCode models probe, fix concurrency, pace and cool down independently across jobs', async () => {
  const s = new Store(':memory:');
  let now = 1000;
  const pending = [];
  const w = new Scheduler(s, { clock: () => now, probeMax: 3, probeInterval: 10,
    call: config => new Promise((resolve, reject) => pending.push({ model: config.model, resolve, reject })) });
  function modelJob(model) {
    const imp = s.begin({ batches: [{ id: 'main', config: { provider: 'opencode', model } }] });
    s.append(imp, Array.from({ length: 6 }, (_, i) => ({ id: String(i), batch: 'main', prompt: 'fixture' })));
    s.seal(imp);
    return imp.id;
  }
  modelJob('claude-opus-test');
  modelJob('claude-opus-test');
  modelJob('qwen-test');
  s.run('UPDATE configs SET checked=1');
  s.run("UPDATE jobs SET state='running'");
  for (let i = 0; i < 3; i++) {
    w.tick();
    await new Promise(resolve => setImmediate(resolve));
    now += 10;
  }
  const opus = 'opencode:claude-opus-test', qwen = 'opencode:qwen-test';
  assert.equal(w.inFlight(opus), 3); // Shared by both Opus jobs, not three per job.
  assert.equal(w.inFlight(qwen), 3);
  assert.equal(pending.length, 6);
  pending.find(p => p.model === 'claude-opus-test').reject(Object.assign(Error('rate limit'), { statusCode: 429 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.control(opus).observed, 3); // Excludes Qwen's three in-flight requests.
  assert.equal(w.control(opus).cap, 2);
  assert.equal(w.control(opus).mode, 'adaptive');
  assert.equal(w.control(opus).cooldown, now + 60000);
  assert.equal(w.control(qwen).cap, 3);
  assert.equal(w.control(qwen).mode, 'probe');
  assert.equal(w.control(qwen).cooldown, 0);
  pending.find(p => p.model === 'qwen-test').resolve({ partial: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  w.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.filter(p => p.model === 'qwen-test').length, 4);
  assert.equal(pending.filter(p => p.model === 'claude-opus-test').length, 3);
  assert.equal(w.inFlight(qwen), 3);
  assert.ok(s.get('SELECT body FROM controls WHERE provider=?', opus));
  assert.ok(s.get('SELECT body FROM controls WHERE provider=?', qwen));
  assert.equal(s.get('SELECT body FROM controls WHERE provider=?', 'opencode'), undefined);
  for (const p of pending) p.resolve({ partial: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  await w.stop();
  s.db.close();
});

test('OpenCode retires unattributable shared limits, preserves model limits, and resume only clears its model', () => {
  const s = new Store(':memory:');
  s.run('INSERT INTO controls VALUES(?,?)', 'opencode', JSON.stringify({ cap: 35, interval: 32000, cooldown: 999999 }));
  for (const [key, cap] of [['opencode:claude-opus-test', 2], ['opencode:qwen-test', 9]]) {
    s.run('INSERT INTO controls VALUES(?,?)', key, JSON.stringify({
      version: 2, epoch: 1, mode: 'fixed', cap, interval: 500, cooldown: 61000, next: 61000, failures: 3,
    }));
  }
  const imp = s.begin({ batches: [{ id: 'main', config: { provider: 'opencode', model: 'claude-opus-test' } }] });
  s.append(imp, [{ id: '1', batch: 'main', prompt: 'fixture' }]); s.seal(imp);
  s.run('UPDATE configs SET checked=1');
  s.run("UPDATE jobs SET state='paused'");
  s.run("UPDATE items SET state='waiting',next=61000");
  const w = new Scheduler(s, { clock: () => 1000 });
  assert.equal(w.controls.has('opencode'), false);
  assert.equal(s.get("SELECT body FROM controls WHERE provider='opencode'"), undefined);
  assert.equal(w.control('opencode:claude-opus-test').cap, 2);
  assert.equal(w.control('opencode:qwen-test').cap, 9);
  w.jobAction(imp.id, 'resume');
  assert.equal(w.control('opencode:claude-opus-test').cooldown, 0);
  assert.equal(w.control('opencode:claude-opus-test').cap, 2);
  assert.equal(w.control('opencode:qwen-test').cooldown, 61000);
  assert.equal(w.control('opencode:qwen-test').next, 61000);
  const reload = new Scheduler(s, { clock: () => 2000 });
  assert.equal(reload.control('opencode:claude-opus-test').cap, 2);
  assert.equal(reload.control('opencode:claude-opus-test').cooldown, 0);
  assert.equal(reload.control('opencode:qwen-test').cap, 9);
  assert.equal(reload.control('opencode:qwen-test').cooldown, 61000);
  s.db.close();
});

test('billing independently totals cost and tokens, including overlapping and zero-valued usage', () => {
  const s = new Store(':memory:');
  const id = job(s, 1), item = s.get('SELECT id FROM items WHERE job=?', id).id;
  const rows = [
    ['both', { inputTokens: 10, outputTokens: 4 }, 0.25, 'USD'],
    ['tokens', { inputTokens: 20, outputTokens: 6 }, null, null],
    ['cost', null, 2, 'CNY'],
    ['unknown', null, null, null],
    ['zero', { inputTokens: 0, outputTokens: 0 }, 0, 'USD'],
  ];
  for (const [key, usage, cost, currency] of rows)
    s.run('INSERT INTO attempts(id,item,started,state,usage,cost,currency) VALUES(?,?,1,?,?,?,?)',
      key, item, 'succeeded', usage ? JSON.stringify(usage) : null, cost, currency);
  s.run("INSERT INTO attempts(id,item,started,state) VALUES('inflight',?,1,'running')", item);
  assert.deepEqual(s.summary(id).totals.openai, {
    attempts: 5, cost: { USD: 0.25, CNY: 2 }, costAttempts: 3, tokenAttempts: 3,
    unknownAttempts: 1, inputTokens: 30, outputTokens: 10,
  });
  s.db.close();
});

test('store overview archiving and summary batches/errorGroups aggregation', () => {
  const s = new Store(':memory:');
  const now = 10_000_000_000;
  const oldImp = s.begin({
    name: 'old-job',
    batches: [{ id: 'a', config: { provider: 'openai', model: 'gpt-5' } }],
  });
  s.append(oldImp, [{ id: '1', batch: 'a', prompt: 'hi' }]);
  s.seal(oldImp);
  s.run("UPDATE jobs SET state='completed',created=? WHERE id=?", now - 5 * 86400_000, oldImp.id);
  s.run("UPDATE items SET state='succeeded' WHERE job=?", oldImp.id);

  const recentImp = s.begin({
    name: 'recent-job',
    batches: [
      { id: 'b1', config: { provider: 'openai', model: 'gpt-5', maxOutputTokens: 128 } },
      { id: 'b2', config: { provider: 'deepseek', model: 'deepseek-flash', maxOutputTokens: 128 } },
    ],
  });
  s.append(recentImp, [
    { id: '1', batch: 'b1', prompt: 'p1' },
    { id: '2', batch: 'b1', prompt: 'p2' },
    { id: '3', batch: 'b2', prompt: 'p3' },
  ]);
  s.seal(recentImp);
  s.run("UPDATE jobs SET state='needs_attention',created=? WHERE id=?", now - 3600_000, recentImp.id);
  const items = s.all('SELECT id,query_id FROM items WHERE job=? ORDER BY id', recentImp.id);
  s.run("UPDATE items SET state='succeeded' WHERE id=?", items[0].id);
  s.run("INSERT INTO attempts(id,item,started,ended,state,usage,cost,currency) VALUES('a1',?,1000,2500,'succeeded',?,?,?)",
    items[0].id, JSON.stringify({ inputTokens: 100, outputTokens: 20 }), 0.01, 'USD');
  s.run("UPDATE items SET state='held',error=? WHERE id IN (?,?)",
    JSON.stringify({ kind: 'output', message: '输出达到长度上限' }), items[1].id, items[2].id);

  const defOv = s.overview(3 * 86400_000, now);
  assert.equal(defOv.jobs.length, 1);
  assert.equal(defOv.hiddenCount, 1);
  assert.equal(defOv.jobs[0].id, recentImp.id);
  assert.equal(defOv.jobs[0].topError.count, 2);
  assert.equal(defOv.jobs[0].topError.kind, 'output');
  assert.deepEqual(defOv.jobs[0].models, ['gpt-5', 'deepseek-flash']);

  const allOv = s.overview(3 * 86400_000, now, { includeArchived: true });
  assert.equal(allOv.jobs.length, 2);
  assert.equal(allOv.hiddenCount, 0);

  const sum = s.summary(recentImp.id);
  assert.equal(sum.batches.length, 2);
  assert.equal(sum.batches[0].batch, 'b1');
  assert.deepEqual(sum.batches[0].counts, { succeeded: 1, held: 1 });
  assert.equal(sum.batches[0].usage.avgDurationMs, 1500);
  assert.equal(sum.batches[0].usage.cost.USD, 0.01);
  assert.equal(sum.batches[1].batch, 'b2');
  assert.deepEqual(sum.batches[1].counts, { held: 1 });
  assert.equal(sum.errorGroups.length, 2);
  s.db.close();
});

test('batchOperate patch_config fixes blocked preflight and partial held items, and refuse completes selected items', async () => {
  const s = new Store(':memory:');
  const calls = [];
  const w = new Scheduler(s, {
    probeInterval: 0,
    call: async (config) => {
      calls.push(config);
      if (config.model === 'bad-model') throw Object.assign(Error('bad model'), { statusCode: 400 });
      if ((config.maxOutputTokens || 0) < 512) throw Object.assign(Error('输出达到长度上限'), { kind: 'output' });
      return { partial: 'ok' };
    },
  });
  const step = async (n = 4) => {
    for (let i = 0; i < n; i++) {
      w.tick();
      await new Promise((r) => setImmediate(r));
    }
  };

  // Scenario 1: preflight_blocked fixed in-place when no succeeded items exist on that batch
  const imp1 = s.begin({
    batches: [{ id: 'main', config: { provider: 'openai', model: 'bad-model', maxOutputTokens: 512 } }],
  });
  s.append(imp1, [
    { id: '1', batch: 'main', prompt: 'a' },
    { id: '2', batch: 'main', prompt: 'b' },
  ]);
  s.seal(imp1);
  await step(1);
  assert.equal(s.summary(imp1.id).state, 'preflight_blocked');

  const res1 = w.batchOperate(imp1.id, {
    action: 'patch_config',
    batch: 'main',
    config: { provider: 'openai', model: 'good-model', maxOutputTokens: 512 },
    retry: true,
  });
  assert.equal(res1.count, 2);
  assert.equal(s.summary(imp1.id).state, 'preflight');
  assert.equal(s.summary(imp1.id).batches.length, 1);
  assert.equal(s.summary(imp1.id).batches[0].batch, 'main');
  await step(4);
  assert.equal(s.summary(imp1.id).state, 'completed');

  // Scenario 2: job with succeeded + held items splits config cleanly without mutating succeeded items' config
  const imp2 = s.begin({
    batches: [{ id: 'eval', config: { provider: 'openai', model: 'good-model', maxOutputTokens: 128 } }],
  });
  s.append(imp2, [
    { id: 's1', batch: 'eval', prompt: 'x' },
    { id: 'h1', batch: 'eval', prompt: 'y' },
    { id: 'h2', batch: 'eval', prompt: 'z' },
  ]);
  s.seal(imp2);
  const rows2 = s.all('SELECT id FROM items WHERE job=? ORDER BY id', imp2.id);
  s.run("UPDATE configs SET checked=1 WHERE job=?", imp2.id);
  s.run("UPDATE jobs SET state='needs_attention' WHERE id=?", imp2.id);
  s.run("UPDATE items SET state='succeeded',result=? WHERE id=?", JSON.stringify({ partial: 'done' }), rows2[0].id);
  s.run("UPDATE items SET state='held',error=? WHERE id IN (?,?)",
    JSON.stringify({ kind: 'output', message: '输出达到长度上限' }), rows2[1].id, rows2[2].id);

  // Refuse one held item in bulk via batchOperate, patch_config the other
  const refRes = w.batchOperate(imp2.id, { action: 'refuse', ids: [rows2[1].id] });
  assert.equal(refRes.count, 1);
  assert.equal(s.get('SELECT state FROM items WHERE id=?', rows2[1].id).state, 'succeeded');
  assert.equal(JSON.parse(s.get('SELECT result FROM items WHERE id=?', rows2[1].id).result).manualRefusal, true);

  const patchRes = w.batchOperate(imp2.id, {
    action: 'patch_config',
    batch: 'eval',
    state: 'held',
    config: { provider: 'openai', model: 'good-model', maxOutputTokens: 1024 },
  });
  assert.equal(patchRes.count, 1);
  const sum2 = s.summary(imp2.id);
  assert.equal(sum2.batches.length, 2);
  assert.equal(sum2.batches[0].config.maxOutputTokens, 128);
  assert.equal(sum2.batches[1].config.maxOutputTokens, 1024);
  assert.equal(sum2.state, 'running');
  // A replacement config still needs its first real sample, even on a running job.
  w.batchOperate(imp2.id, { action: 'patch_config', ids: [rows2[2].id],
    config: { provider: 'openai', model: 'bad-model' } });
  await step(2);
  assert.equal(s.summary(imp2.id).state, 'preflight_blocked');
  w.itemAction(rows2[2].id, 'retry', { config: { provider: 'openai', model: 'good-model', maxOutputTokens: 1024 } });
  await step(4);
  assert.equal(s.summary(imp2.id).state, 'completed');
  await w.stop();
  s.db.close();
});

test('deleteJob removes non-running jobs, rejects active jobs, and HTTP routes expose filters and batch-ops', async () => {
  const s = new Store(':memory:');
  const pending = [];
  const w = new Scheduler(s, {
    probeInterval: 0,
    call: () => new Promise((_, reject) => { pending.push(reject); }),
  });
  const imp = s.begin({
    name: 'http-test',
    batches: [
      { id: 'b1', config: { provider: 'openai', model: 'm1' } },
      { id: 'b2', config: { provider: 'deepseek', model: 'm2' } },
    ],
  });
  s.append(imp, [
    { id: 'q-alpha', batch: 'b1', prompt: 'hello' },
    { id: 'q-beta', batch: 'b2', prompt: 'world' },
  ]);
  s.seal(imp);
  s.run("UPDATE configs SET checked=1 WHERE job=?", imp.id);
  s.run("UPDATE jobs SET state='running' WHERE id=?", imp.id);
  w.tick();
  await new Promise((r) => setImmediate(r));

  // Cannot delete while running
  assert.throws(() => w.deleteJob(imp.id), /在途/);

  // Complete/hold running requests
  while (pending.length) pending.shift()(Object.assign(Error('bad param'), { statusCode: 400 }));
  await new Promise((r) => setImmediate(r));
  s.run("UPDATE items SET state='succeeded',result=? WHERE query_id='q-alpha'", JSON.stringify({ partial: 'answer one' }));

  const server = app(s, w);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const filtered = await (await fetch(`${base}/api/jobs/${imp.id}/items?batch=b1&q=answer`)).json();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].query_id, 'q-alpha');
    assert.equal(filtered[0].batch, 'b1');
    assert.equal(filtered[0].preview, 'answer one');

    const heldRows = await (await fetch(`${base}/api/jobs/${imp.id}/items?state=held`)).json();
    assert.equal(heldRows.length, 1);
    assert.equal(heldRows[0].batch, 'b2');

    const refResp = await fetch(`${base}/api/jobs/${imp.id}/batch-ops`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refuse', state: 'held', batch: 'b2' }),
    });
    assert.equal(refResp.status, 200);
    assert.deepEqual(await refResp.json(), { ok: true, count: 1 });
    assert.equal(s.summary(imp.id).state, 'completed');

    const delResp = await fetch(`${base}/api/jobs/${imp.id}`, { method: 'DELETE' });
    assert.equal(delResp.status, 200);
    assert.deepEqual(await delResp.json(), { ok: true });
    assert.equal(s.jobs().length, 0);
  } finally {
    while (pending.length) pending.shift()(Object.assign(Error('cleanup'), { statusCode: 400 }));
    await w.stop();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
