import { randomUUID, createHash } from "node:crypto";
import { canonical, validateConfig, validateQuery } from "./policy.js";
import { classify, contentFilteredResult, decide } from "./retry.js";
import { invoke, errorRecord, refreshCredentials } from "./providers.js";
import { ConcurrencyWindow, controlKey } from "./concurrency.js";
import { keyVariable } from "./endpoints.js";
export { controlKey };

export class Scheduler {
  constructor(
    store,
    {
      call = invoke,
      reloadCredentials = refreshCredentials,
      clock = Date.now,
      globalMax = Number(process.env.GLOBAL_CONCURRENCY || 128),
      probeMax = Number(process.env.PROBE_MAX_CONCURRENCY || 64),
      probeInterval = Number(process.env.PROBE_INTERVAL_MS || 10),
    } = {},
  ) {
    if (
      !Number.isInteger(globalMax) ||
      globalMax < 1 ||
      !Number.isInteger(probeMax) ||
      probeMax < 1 ||
      !Number.isInteger(probeInterval) ||
      probeInterval < 0
    )
      throw Error("并发配置必须是正整数，发送间隔必须为非负整数");
    this.s = store;
    this.call = call;
    this.reloadCredentials = reloadCredentials;
    this.clock = clock;
    this.globalMax = globalMax;
    this.probeMax = Math.min(globalMax, probeMax);
    this.probeInterval = probeInterval;
    this.active = new Map();
    this.controls = new Map();
    this.loads = new Map();
    this.stopped = false;
    this.fatal = null;
    for (const r of store.all("SELECT * FROM controls")) {
      if (r.provider === "opencode") {
        // A historical shared limit cannot be attributed to any single model.
        store.run("DELETE FROM controls WHERE provider=?", r.provider);
        continue;
      }
      this.controls.set(r.provider, new ConcurrencyWindow(
        this.probeMax, probeInterval, clock(), JSON.parse(r.body),
      ));
      this.save(r.provider);
    }
  }
  control(provider) {
    if (!this.controls.has(provider))
      this.controls.set(provider, new ConcurrencyWindow(this.probeMax, this.probeInterval, this.clock()));
    return this.controls.get(provider);
  }
  save(provider) {
    this.s.run(
      "INSERT INTO controls VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET body=excluded.body",
      provider,
      JSON.stringify(this.control(provider)),
    );
  }
  inFlight(provider) {
    return this.loads.get(provider) ?? 0;
  }
  start() {
    if (this.timer || this.stopped) return;
    const poll = () => {
      try {
        const busy = this.tick();
        if (!this.stopped) this.timer = setTimeout(poll, busy ? 10 : 250);
      } catch (e) {
        this.storageFault(e);
      }
    };
    poll();
  }
  storageFault(e) {
    this.fatal = e.message;
    this.stopped = true;
    console.error("服务停止派发，持久化/调度异常:", e.message);
  }
  tick() {
    if (this.stopped) return false;
    if (this.active.size >= this.globalMax) return true;
    const jobs = this.s.all(
      "SELECT * FROM jobs WHERE state IN ('preflight','running') ORDER BY created",
    );
    // Rotate jobs each tick so an older job cannot monopolize a provider.
    this.cursor = ((this.cursor || 0) + 1) % Math.max(1, jobs.length);
    jobs.push(...jobs.splice(0, this.cursor));
    for (const job of jobs) {
      if (this.active.size >= this.globalMax) break;
      let configs = this.s.all(
        "SELECT * FROM configs WHERE job=? ORDER BY rowid",
        job.id,
      );
      if (job.state === "preflight") {
        configs = configs.filter((c) => !c.checked);
        if (!configs.length) {
          this.s.run(
            "UPDATE jobs SET state='running',error=NULL WHERE id=?",
            job.id,
          );
          continue;
        }
        if ([...this.active.values()].some((x) => x.job === job.id)) continue;
        configs = [configs[0]];
      }
      for (const c of configs) {
        if (this.active.size >= this.globalMax) break;
        const config = JSON.parse(c.body),
          scope = controlKey(config),
          control = this.control(scope);
        const now = this.clock();
        if (
          control.cooldown > now ||
          control.next > now ||
          this.inFlight(scope) >= control.cap
        )
          continue;
        const row = c.checked
          ? this.s.get(
              "SELECT * FROM items WHERE config=? AND state IN ('queued','waiting') AND next<=? ORDER BY id LIMIT 1",
              c.id,
              now,
            )
          : this.s.get(
              "SELECT * FROM items WHERE config=? AND state!='skipped' ORDER BY id LIMIT 1",
              c.id,
            );
        if (
          row &&
          (!["queued", "waiting"].includes(row.state) || row.next > now)
        ) {
          if (row.state === "held" && !c.checked) {
            this.s.run(
              "UPDATE jobs SET state='preflight_blocked',error=? WHERE id=?",
              row.error,
              job.id,
            );
            break;
          }
          continue;
        }
        if (!row) {
          // The unchecked query above includes every non-skipped state.
          if (!c.checked) this.s.run("UPDATE configs SET checked=1 WHERE id=?", c.id);
          continue;
        }
        if (!c.checked && [...this.active.values()].some(a => a.config === c.id)) continue;
        this.dispatch(row, c, config);
        control.next = now + control.interval;
      }
      if (
        job.state === "running" &&
        !this.s.get(
          "SELECT 1 FROM items WHERE job=? AND state IN ('queued','waiting','running') LIMIT 1",
          job.id,
        )
      ) {
        const held = this.s.get(
          "SELECT 1 FROM items WHERE job=? AND state='held' LIMIT 1",
          job.id,
        );
        this.s.run(
          "UPDATE jobs SET state=? WHERE id=? AND state='running'",
          held ? "needs_attention" : "completed",
          job.id,
        );
      }
    }
    return jobs.length > 0;
  }
  dispatch(item, c, config) {
    const id = randomUUID(),
      started = this.clock();
    this.s.tx(() => {
      this.s.run(
        "UPDATE items SET state='running',attempts=attempts+1 WHERE id=?",
        item.id,
      );
      this.s.run(
        "INSERT INTO attempts(id,item,started,state) VALUES(?,?,?,?)",
        id,
        item.id,
        started,
        "running",
      );
    });
    const abort = new AbortController();
    const scope = controlKey(config);
    const control = this.control(scope);
    const load = this.inFlight(scope) + 1;
    this.loads.set(scope, load);
    this.active.set(id, {
      provider: config.provider, scope, load, cap: control.cap, epoch: control.epoch,
      started,
      job: item.job,
      config: c.id,
      abort,
    });
    Promise.resolve()
      .then(() =>
        this.call(config, JSON.parse(item.input), { signal: abort.signal }),
      )
      .then(
        (r) => this.finish(id, item, c, r, null),
        (e) => this.finish(id, item, c, null, e),
      )
      .catch((e) => this.storageFault(e))
      .finally(() => {
        this.active.delete(id);
        this.loads.set(scope, this.inFlight(scope) - 1);
      });
  }
  finish(id, item, c, result, error) {
    const now = this.clock();
    const attempt = this.active.get(id);
    const scope = attempt.scope;
    const ctl = this.control(scope);
    const checking = !c.checked;
    const capture = result || error?.capture || {};
    const classification = error ? classify(error, attempt.provider) : null;
    const rec = error ? { ...errorRecord(error), kind: classification.kind } : null;
    let decision = { state: "succeeded", next: 0 };
    if (classification?.kind === "content") {
      result = contentFilteredResult(capture, rec);
      error = null; // A moderation block is a completed outcome, not an operator task.
    }
    // Running items cannot be edited before this attempt settles.
    let attempts = item.attempts + 1,
      interruptions = item.interruptions,
      freeFailures = item.free_failures;
    if (error) {
      if (!classification.count) {
        attempts--;
        freeFailures++;
      }
      if (classification.kind === "interrupted") interruptions++;
      decision = decide(
        classification.kind,
        attempts,
        interruptions,
        now,
        capture.retryAfter || 0,
      );
      if (freeFailures >= 20) {
        decision = { state: "held", next: 0 };
        rec.message += "；连续免费重试达到 20 次，需人工处理";
      }
      if (classification.kind === "rate") {
        ctl.limited(attempt, this.inFlight(scope), checking, capture.retryAfter || 0, now);
      } else {
        ctl.unavailable(attempt, classification.kind, capture.retryAfter || 0, now);
      }
    } else {
      freeFailures = 0;
      ctl.succeeded(attempt, now);
    }
    this.s.tx(() => {
      this.s.run(
        "UPDATE attempts SET ended=?,state=?,counted=?,error=?,usage=?,cost=?,currency=?,request_id=?,partial=? WHERE id=?",
        now,
        error ? "failed" : "succeeded",
        classification && !classification.count ? 0 : 1,
        rec ? JSON.stringify(rec) : null,
        capture.usage ? JSON.stringify(capture.usage) : null,
        capture.cost ?? null,
        capture.currency ?? null,
        capture.requestId ?? null,
        error
          ? JSON.stringify({
              text: capture.partial || "",
              reasoning: capture.reasoning || "",
              ...(capture.logprobs ? { logprobs: capture.logprobs } : {}),
            })
          : null,
        id,
      );
      this.s.run(
        "UPDATE items SET state=?,attempts=?,interruptions=?,free_failures=?,next=?,error=?,result=? WHERE id=?",
        decision.state,
        attempts,
        interruptions,
        freeFailures,
        decision.next,
        error && rec ? JSON.stringify(rec) : null,
        result ? JSON.stringify(result) : null,
        item.id,
      );
      if (checking && !error)
        this.s.run(
          "UPDATE configs SET checked=1 WHERE job=? AND fingerprint=?",
          item.job,
          c.fingerprint,
        );
      if (checking && decision.state === "held")
        this.s.run(
          "UPDATE jobs SET state='preflight_blocked',error=? WHERE id=? AND state IN ('preflight', 'running')",
          JSON.stringify(rec),
          item.job,
        );
      this.save(scope);
    });
  }
  jobAction(id, action) {
    const job = this.s.get("SELECT * FROM jobs WHERE id=?", id);
    if (!job) throw Error("Job 不存在");
    if (action === "pause") {
      this.s.run(
        "UPDATE jobs SET state='paused' WHERE id=? AND state IN ('preflight','running','preflight_blocked','needs_attention')",
        id,
      );
    } else if (action === "resume") {
      if (job.state === "importing") throw Error("正在导入");
      const authItems = this.s.all(
        `SELECT i.id,c.body FROM items i JOIN configs c ON c.id=i.config
         WHERE i.job=? AND i.state='held' AND json_extract(i.error,'$.kind')='auth'`,
        id,
      );
      for (const provider of new Set(authItems.map(i => JSON.parse(i.body).provider))) {
        if (!this.reloadCredentials(provider))
          throw Error(`${keyVariable(provider)} 未配置；请补充 .env 后再次恢复`);
      }
      this.s.tx(() => {
        const now = this.clock();
        const providers = this.s.all(
          `SELECT DISTINCT c.body FROM items i JOIN configs c ON c.id=i.config
           WHERE i.job=? AND i.state NOT IN ('succeeded','skipped')`, id,
        );
        for (const scope of new Set(providers.map(r => controlKey(JSON.parse(r.body))))) {
          const ctl = this.control(scope);
          ctl.resume(now);
          this.save(scope);
        }
        this.s.run(
          "UPDATE items SET next=0 WHERE job=? AND state IN ('queued','waiting')", id,
        );
        for (const item of authItems) {
          this.s.run(
            "UPDATE items SET state='queued',attempts=0,interruptions=0,free_failures=0,next=0,error=NULL WHERE id=?",
            item.id,
          );
          this.s.run(
            "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
            item.id, id, this.clock(), "retry", JSON.stringify({ reason: "credentials_reloaded" }),
          );
        }
        const unchecked = this.s.get(
          "SELECT 1 FROM configs WHERE job=? AND checked=0 LIMIT 1", id,
        );
        this.s.run(
          "UPDATE jobs SET state=?,error=NULL WHERE id=?",
          unchecked ? "preflight" : "running", id,
        );
      });
    } else throw Error("未知操作");
    this.s.run(
      "INSERT INTO actions(job,time,action) VALUES(?,?,?)",
      id,
      this.clock(),
      action,
    );
  }
  itemAction(id, action, patch = {}) {
    const i = this.s.get("SELECT * FROM items WHERE id=?", id);
    if (!i) throw Error("条目不存在");
    if (i.state === "running") throw Error("在途请求不可修改，请等待完成");
    if (!["held", "waiting", "skipped"].includes(i.state))
      throw Error("只能处置挂起、等待或跳过的条目");
    if (!["retry", "skip", "refuse"].includes(action)) throw Error("未知操作");
    if (action === "refuse") {
      if (!patch || Object.keys(patch).length) throw Error("标记拒答不支持修改配置或 prompt");
      return this.s.tx(() => {
        const detail = {
          reason: "Operator marked this item as a refusal and a successful outcome.",
          previousState: i.state,
          originalError: i.error ? JSON.parse(i.error) : null,
        };
        const result = {
          partial: "I cannot answer.", reasoning: "", finishReason: "stop",
          manualRefusal: true, manualRefusalReason: detail,
        };
        this.s.run(
          "UPDATE items SET state='succeeded',next=0,error=NULL,result=? WHERE id=?",
          JSON.stringify(result), id,
        );
        this.s.run("UPDATE configs SET checked=1 WHERE id=?", i.config);
        this.s.run(
          "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
          id, i.job, this.clock(), "manual_refusal", JSON.stringify(detail),
        );
        const job = this.s.get("SELECT * FROM jobs WHERE id=?", i.job);
        if (["preflight_blocked", "needs_attention"].includes(job.state)) {
          const unchecked = this.s.get("SELECT 1 FROM configs WHERE job=? AND checked=0 LIMIT 1", i.job);
          this.s.run("UPDATE jobs SET state=?,error=NULL WHERE id=?", unchecked ? "preflight" : "running", i.job);
        }
        this.finishResolvedJob(i.job);
      });
    }
    if (action === "retry" && JSON.parse(i.error || "null")?.kind === "auth") {
      const config = patch.config ? validateConfig(patch.config) : JSON.parse(
        this.s.get("SELECT body FROM configs WHERE id=?", i.config).body,
      );
      if (!this.reloadCredentials(config.provider))
        throw Error(`${keyVariable(config.provider)} 未配置；请补充 .env 后再次重试`);
    }
    this.s.tx(() => {
      let cid = i.config,
        input = i.input;
      if (patch.config) {
        const conf = canonical(validateConfig(patch.config));
        cid = randomUUID();
        this.s.run(
          "INSERT INTO configs(id,job,batch,fingerprint,body) VALUES(?,?,?,?,?)",
          cid,
          i.job,
          `manual-${cid}`,
          createHash("sha256").update(conf).digest("hex"),
          conf,
        );
      }
      if (patch.prompt !== undefined) {
        const q = JSON.parse(input);
        delete q.messages;
        q.prompt = patch.prompt;
        input = JSON.stringify(validateQuery(q));
      }
      this.s.run(
        "UPDATE items SET state=?,attempts=0,interruptions=0,free_failures=0,next=0,error=NULL,config=?,input=? WHERE id=?",
        action === "skip" ? "skipped" : "queued",
        cid,
        input,
        id,
      );
      this.s.run(
        "DELETE FROM configs WHERE id=? AND NOT EXISTS(SELECT 1 FROM items WHERE config=?)",
        i.config,
        i.config,
      );
      this.s.run(
        "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
        id,
        i.job,
        this.clock(),
        action,
        JSON.stringify(patch),
      );
      const job = this.s.get("SELECT * FROM jobs WHERE id=?", i.job);
      if (
        action === "retry" &&
        ["preflight_blocked", "needs_attention", "completed"].includes(
          job.state,
        )
      )
        this.s.run(
          "UPDATE jobs SET state=?,error=NULL WHERE id=?",
          job.state === "preflight_blocked" ? "preflight" : "running",
          i.job,
        );
      if (action === "skip") this.finishResolvedJob(i.job);
    });
  }
  finishResolvedJob(jobId) {
    if (!this.s.get(
      "SELECT 1 FROM items WHERE job=? AND state NOT IN ('succeeded','skipped') LIMIT 1", jobId,
    ))
      this.s.run(
        "UPDATE jobs SET state='completed',error=NULL WHERE id=? AND state NOT IN ('paused','importing')", jobId,
      );
  }
  bulkAction(jobId, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => !["action", "ids", "state"].includes(key)))
      throw Error("批量处置仅接受 action 和 ids / state 范围，不支持修改配置");
    const { action, ids, state } = body;
    if (!["retry", "skip"].includes(action)) throw Error("批量操作仅支持 retry / skip");
    if ((ids !== undefined) === (state !== undefined))
      throw Error("请选择 ids 或 state 其中一种批量范围");
    const eligible = ["held", "waiting", "skipped"];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 1000 ||
        !ids.every(id => Number.isSafeInteger(id) && id > 0) || new Set(ids).size !== ids.length))
      throw Error("ids 必须是 1–1000 个不重复的正整数");
    if (state !== undefined && !eligible.includes(state))
      throw Error("批量筛选仅支持 held / waiting / skipped");
    return this.s.tx(() => {
      const job = this.s.get("SELECT * FROM jobs WHERE id=?", jobId);
      if (!job) throw Error("Job 不存在");
      const rows = this.s.all(
        `SELECT i.id,i.state,i.error,c.body FROM items i JOIN configs c ON c.id=i.config
         WHERE i.job=? AND ${ids !== undefined ? `i.id IN (${ids.map(() => "?").join(",")})` : "i.state=?"}`,
        jobId, ...(ids !== undefined ? ids : [state]),
      );
      if (ids !== undefined && rows.length !== ids.length)
        throw Error("所选条目不存在或不属于当前 Job；未执行批量操作");
      if (rows.some(row => !eligible.includes(row.state)))
        throw Error("所选条目包含执行中、已成功或排队项；请刷新后重新选择，未执行批量操作");
      if (action === "retry") {
        const providers = new Set(rows.filter(row => JSON.parse(row.error || "null")?.kind === "auth")
          .map(row => JSON.parse(row.body).provider));
        for (const provider of providers)
          if (!this.reloadCredentials(provider))
            throw Error(`${keyVariable(provider)} 未配置；批量重试未执行`);
      }
      for (const row of rows) {
        this.s.run(
          "UPDATE items SET state=?,attempts=0,interruptions=0,free_failures=0,next=0,error=NULL WHERE id=?",
          action === "retry" ? "queued" : "skipped", row.id,
        );
        this.s.run(
          "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
          row.id, jobId, this.clock(), action, JSON.stringify({ bulk: true }),
        );
      }
      if (rows.length && action === "retry" &&
          ["preflight_blocked", "needs_attention", "completed"].includes(job.state))
        this.s.run("UPDATE jobs SET state=?,error=NULL WHERE id=?",
          job.state === "preflight_blocked" ? "preflight" : "running", jobId);
      if (rows.length && action === "skip") this.finishResolvedJob(jobId);
      return { count: rows.length };
    });
  }
  deleteJob(jobId) {
    const job = this.s.get("SELECT * FROM jobs WHERE id=?", jobId);
    if (!job) throw Error("Job 不存在");
    if (
      [...this.active.values()].some((a) => a.job === jobId) ||
      this.s.get("SELECT 1 FROM items WHERE job=? AND state='running' LIMIT 1", jobId)
    )
      throw Error("任务仍有在途请求，请先暂停并等待在途请求结束");
    this.s.tx(() => {
      this.s.run("DELETE FROM actions WHERE job=?", jobId);
      this.s.run("DELETE FROM items WHERE job=?", jobId);
      this.s.run("DELETE FROM configs WHERE job=?", jobId);
      this.s.run("DELETE FROM jobs WHERE id=?", jobId);
    });
  }
  batchOperate(jobId, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw Error("无效请求体");
    const { action, ids, state, batch } = body;
    if (!["refuse", "patch_config"].includes(action))
      throw Error("不支持的批量操作");
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > 1000 ||
        !ids.every((id) => Number.isSafeInteger(id) && id > 0) ||
        new Set(ids).size !== ids.length)
    )
      throw Error("ids 必须是 1–1000 个不重复的正整数");
    if (batch !== undefined && (typeof batch !== "string" || !batch))
      throw Error("batch 无效");

    if (action === "refuse") {
      if ((ids !== undefined) === (state !== undefined))
        throw Error("请选择 ids 或 state 其中一种批量范围");
      const eligible = ["held", "waiting", "skipped"];
      if (state !== undefined && !eligible.includes(state))
        throw Error("批量标记拒答仅支持 held / waiting / skipped");
      return this.s.tx(() => {
        const job = this.s.get("SELECT * FROM jobs WHERE id=?", jobId);
        if (!job) throw Error("Job 不存在");
        const rows =
          ids !== undefined
            ? this.s.all(
                `SELECT id,state,error,config FROM items WHERE job=? AND id IN (${ids.map(() => "?").join(",")})`,
                jobId,
                ...ids,
              )
            : batch
              ? this.s.all(
                  "SELECT i.id,i.state,i.error,i.config FROM items i JOIN configs c ON c.id=i.config WHERE i.job=? AND i.state=? AND c.batch=?",
                  jobId,
                  state,
                  batch,
                )
              : this.s.all(
                  "SELECT id,state,error,config FROM items WHERE job=? AND state=?",
                  jobId,
                  state,
                );
        if (ids !== undefined && rows.length !== ids.length)
          throw Error("所选条目不存在或不属于当前 Job；未执行批量操作");
        if (rows.some((row) => !eligible.includes(row.state)))
          throw Error("所选条目包含执行中、已成功或排队项；请刷新后重新选择，未执行批量操作");
        for (const row of rows) {
          const detail = {
            reason: "Operator marked this item as a refusal and a successful outcome.",
            previousState: row.state,
            originalError: row.error ? JSON.parse(row.error) : null,
            bulk: true,
          };
          const result = {
            partial: "I cannot answer.",
            reasoning: "",
            finishReason: "stop",
            manualRefusal: true,
            manualRefusalReason: detail,
          };
          this.s.run(
            "UPDATE items SET state='succeeded',next=0,error=NULL,result=? WHERE id=?",
            JSON.stringify(result),
            row.id,
          );
          this.s.run(
            "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
            row.id,
            jobId,
            this.clock(),
            "manual_refusal",
            JSON.stringify(detail),
          );
        }
        for (const cid of new Set(rows.map((r) => r.config)))
          this.s.run("UPDATE configs SET checked=1 WHERE id=?", cid);
        if (rows.length && ["preflight_blocked", "needs_attention"].includes(job.state)) {
          const unchecked = this.s.get(
            "SELECT 1 FROM configs WHERE job=? AND checked=0 LIMIT 1",
            jobId,
          );
          this.s.run(
            "UPDATE jobs SET state=?,error=NULL WHERE id=?",
            unchecked ? "preflight" : "running",
            jobId,
          );
        }
        if (rows.length) this.finishResolvedJob(jobId);
        return { count: rows.length };
      });
    }

    // action === "patch_config"
    const shouldRetry = body.retry === undefined ? true : body.retry;
    if (typeof shouldRetry !== "boolean") throw Error("retry 必须是 boolean");
    if (ids !== undefined && (state !== undefined || batch !== undefined))
      throw Error("传了 ids 时不能同时指定 state 或 batch");
    const editableStates = ["queued", "held", "waiting", "skipped"];
    if (state !== undefined && !editableStates.includes(state))
      throw Error("state 仅支持 queued / held / waiting / skipped");
    const validated = validateConfig(body.config);
    const confBody = canonical(validated);
    const fingerprint = createHash("sha256").update(confBody).digest("hex");

    return this.s.tx(() => {
      const job = this.s.get("SELECT * FROM jobs WHERE id=?", jobId);
      if (!job) throw Error("Job 不存在");
      let rows;
      if (ids !== undefined) {
        rows = this.s.all(
          `SELECT i.id,i.state,i.error,i.config,c.batch AS batch_name
           FROM items i JOIN configs c ON c.id=i.config
           WHERE i.job=? AND i.id IN (${ids.map(() => "?").join(",")})`,
          jobId,
          ...ids,
        );
        if (rows.length !== ids.length)
          throw Error("所选条目不存在或不属于当前 Job；未执行批量修改");
        if (rows.some((r) => !editableStates.includes(r.state)))
          throw Error("所选条目包含执行中或已成功项；请刷新后重新选择，未执行批量修改");
      } else {
        const targetStates = state !== undefined ? [state] : ["queued", "held", "waiting"];
        const conds = ["i.job=?", `i.state IN (${targetStates.map(() => "?").join(",")})`];
        const params = [jobId, ...targetStates];
        if (batch !== undefined) {
          conds.push("c.batch=?");
          params.push(batch);
        }
        rows = this.s.all(
          `SELECT i.id,i.state,i.error,i.config,c.batch AS batch_name
           FROM items i JOIN configs c ON c.id=i.config
           WHERE ${conds.join(" AND ")}`,
          ...params,
        );
      }
      if (!rows.length) return { count: 0 };

      if (
        shouldRetry &&
        rows.some((r) => JSON.parse(r.error || "null")?.kind === "auth") &&
        !this.reloadCredentials(validated.provider)
      )
        throw Error(`${keyVariable(validated.provider)} 未配置；批量修改未执行`);

      const byOldConfig = new Map();
      for (const r of rows) {
        let group = byOldConfig.get(r.config);
        if (!group) {
          group = { batchName: r.batch_name, items: [] };
          byOldConfig.set(r.config, group);
        }
        group.items.push(r);
      }

      const targetConfigId = new Map();
      for (const [oldCid, group] of byOldConfig) {
        const totalInOld = this.s.get("SELECT count(*) AS n FROM items WHERE config=?", oldCid).n;
        if (totalInOld === group.items.length) {
          this.s.run(
            "UPDATE configs SET fingerprint=?,body=?,checked=0 WHERE id=?",
            fingerprint,
            confBody,
            oldCid,
          );
          targetConfigId.set(oldCid, oldCid);
        } else {
          const newCid = randomUUID();
          const baseBatch = group.batchName.replace(/#[0-9a-f]{6}$/, "");
          const newBatch = `${baseBatch}#${newCid.slice(0, 6)}`;
          this.s.run(
            "INSERT INTO configs(id,job,batch,fingerprint,body,checked) VALUES(?,?,?,?,?,0)",
            newCid,
            jobId,
            newBatch,
            fingerprint,
            confBody,
          );
          targetConfigId.set(oldCid, newCid);
        }
      }

      const reviveSkipped = ids !== undefined || state === "skipped";
      let hasQueued = false;
      for (const row of rows) {
        const newCid = targetConfigId.get(row.config);
        const resetToQueue =
          shouldRetry &&
          (row.state === "held" ||
            row.state === "waiting" ||
            (reviveSkipped && row.state === "skipped"));
        if (resetToQueue) {
          this.s.run(
            "UPDATE items SET state='queued',attempts=0,interruptions=0,free_failures=0,next=0,error=NULL,config=? WHERE id=?",
            newCid,
            row.id,
          );
          hasQueued = true;
        } else {
          if (row.state === "queued") hasQueued = true;
          this.s.run("UPDATE items SET config=? WHERE id=?", newCid, row.id);
        }
        this.s.run(
          "INSERT INTO actions(item,job,time,action,detail) VALUES(?,?,?,?,?)",
          row.id,
          jobId,
          this.clock(),
          shouldRetry ? "bulk_patch_retry" : "bulk_patch_config",
          JSON.stringify({ batch: row.batch_name, config: validated }),
        );
      }

      for (const oldCid of byOldConfig.keys())
        this.s.run(
          "DELETE FROM configs WHERE id=? AND NOT EXISTS(SELECT 1 FROM items WHERE config=?)",
          oldCid,
          oldCid,
        );

      if (
        hasQueued &&
        ["preflight_blocked", "needs_attention", "completed"].includes(job.state)
      ) {
        const unchecked = this.s.get(
          "SELECT 1 FROM configs WHERE job=? AND checked=0 LIMIT 1",
          jobId,
        );
        this.s.run(
          "UPDATE jobs SET state=?,error=NULL WHERE id=?",
          unchecked ? "preflight" : "running",
          jobId,
        );
      }
      return { count: rows.length };
    });
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const a of this.active.values())
      a.abort.abort(
        Object.assign(Error("服务关闭，结果不确定"), { name: "TimeoutError" }),
      );
    while (this.active.size) await new Promise((r) => setTimeout(r, 20));
  }
}
