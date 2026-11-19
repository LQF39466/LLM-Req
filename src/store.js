import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonical, validateConfig, validateQuery, contentFilteredResult } from "./policy.js";
function parseErrorSafe(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
    return { message: String(parsed) };
  } catch {
    return { message: String(raw) };
  }
}
export class Store {
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.statements = new Map();
    this.writeSeq = 0;
    this._overviewCache = new Map();
    this._jobMetaCache = new Map();
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, submission_key TEXT UNIQUE, name TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS configs(id TEXT PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, batch TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, checked INTEGER NOT NULL DEFAULT 0, UNIQUE(job,batch));
      CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, config TEXT NOT NULL REFERENCES configs(id), query_id TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, interruptions INTEGER NOT NULL DEFAULT 0, free_failures INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, UNIQUE(job,query_id));
      CREATE INDEX IF NOT EXISTS queue_idx ON items(job,state,next,config);
      CREATE INDEX IF NOT EXISTS config_queue ON items(config,state,next);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, item INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, started INTEGER NOT NULL, ended INTEGER, state TEXT NOT NULL, counted INTEGER NOT NULL DEFAULT 1, error TEXT, usage TEXT, cost REAL, currency TEXT, request_id TEXT, partial TEXT);
      CREATE INDEX IF NOT EXISTS attempt_items ON attempts(item,started);
      CREATE TABLE IF NOT EXISTS controls(provider TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY, item INTEGER, job TEXT, time INTEGER, action TEXT, detail TEXT);
    `);
  }
  statement(sql) {
    if (!this.statements.has(sql))
      this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  run(sql, ...params) {
    const res = this.statement(sql).run(...params);
    this.writeSeq++;
    return res;
  }
  get(sql, ...params) {
    return this.statement(sql).get(...params);
  }
  all(sql, ...params) {
    return this.statement(sql).all(...params);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const x = fn();
      this.db.exec("COMMIT");
      return x;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  begin(spec) {
    const single = spec?.config !== undefined;
    if (single && spec.batches !== undefined) throw Error("config 与 batches 只能选一个");
    const definitions = single ? [{ id: "main", config: spec.config }] : spec?.batches;
    if (!Array.isArray(definitions) || !definitions.length) throw Error("batches 不能为空");
    if (definitions.length > 1000) throw Error("最多 1000 个配置批次");
    if (
      spec.submissionKey !== undefined &&
      (typeof spec.submissionKey !== "string" ||
        !spec.submissionKey ||
        spec.submissionKey.length > 256)
    )
      throw Error("submissionKey 无效");
    if (spec.submissionKey) {
      const previous = this.get(
        "SELECT id FROM jobs WHERE submission_key=?",
        spec.submissionKey,
      );
      if (previous) throw Error(`submissionKey 已存在，原 Job: ${previous.id}`);
    }
    const id = randomUUID();
    return this.tx(() => {
      this.run(
        "INSERT INTO jobs VALUES(?,?,?,?,?,NULL)",
        id,
        spec.submissionKey || null,
        String(spec.name || "Untitled").slice(0, 200),
        "importing",
        Date.now(),
      );
      const batches = new Map();
      for (const b of definitions) {
        if (typeof b.id !== "string" || !b.id || batches.has(b.id))
          throw Error("batch.id 缺失或重复");
        const body = canonical(validateConfig(b.config));
        const cid = randomUUID();
        this.run(
          "INSERT INTO configs(id,job,batch,fingerprint,body) VALUES(?,?,?,?,?)",
          cid,
          id,
          b.id,
          createHash("sha256").update(body).digest("hex"),
          body,
        );
        batches.set(b.id, cid);
      }
      return { id, batches, single, count: 0 };
    });
  }
  append(importer, rows) {
    if (importer.count + rows.length > 100000) throw Error("Job 最多 100000 条");
    this.tx(() => {
      for (const [index, row] of rows.entries()) {
        let q = row;
        if (importer.single) {
          const fields = typeof row === "string" ? { prompt: row } : row;
          q = { id: String(importer.count + index + 1), batch: "main", ...fields };
        }
        validateQuery(q);
        const config = importer.batches.get(q.batch);
        if (!config) throw Error(`未知 batch: ${q.batch}`);
        this.run(
          "INSERT INTO items(job,config,query_id,input) VALUES(?,?,?,?)",
          importer.id,
          config,
          q.id,
          JSON.stringify(q),
        );
      }
    });
    importer.count += rows.length;
  }
  seal(importer) {
    if (!importer.count) throw Error("Job 不能为空");
    this.run("UPDATE jobs SET state='preflight' WHERE id=?", importer.id);
    return importer.id;
  }
  recover() {
    this.tx(() => {
      this.run("DELETE FROM jobs WHERE state='importing'");
      // Adopt previously held moderation blocks without sending them upstream again.
      const filtered = this.all(
        "SELECT * FROM items WHERE state='held' AND json_extract(error,'$.kind')='content'",
      );
      for (const item of filtered) {
        const attempt = this.get(
          "SELECT * FROM attempts WHERE item=? ORDER BY started DESC, rowid DESC LIMIT 1", item.id,
        );
        const partial = JSON.parse(attempt?.partial || "null") || {};
        const capture = {
          partial: partial.text || "", reasoning: partial.reasoning || "",
          usage: JSON.parse(attempt?.usage || "null"), cost: attempt?.cost ?? null,
          currency: attempt?.currency ?? null, requestId: attempt?.request_id ?? null,
        };
        this.run(
          "UPDATE items SET state='succeeded',next=0,error=NULL,result=? WHERE id=?",
          JSON.stringify(contentFilteredResult(capture, JSON.parse(item.error))), item.id,
        );
        this.run(
          "UPDATE configs SET checked=1 WHERE job=? AND fingerprint=(SELECT fingerprint FROM configs WHERE id=?)",
          item.job, item.config,
        );
        this.run(
          `UPDATE jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM configs WHERE job=? AND checked=0)
           THEN 'preflight' ELSE 'running' END,error=NULL
           WHERE id=? AND state IN ('preflight_blocked','needs_attention')`,
          item.job, item.job,
        );
      }

      const rows = this.all(
        "SELECT i.*,a.id AS attempt_id FROM items i JOIN attempts a ON a.item=i.id WHERE a.state='running'",
      );
      for (const i of rows) {
        const n = i.interruptions + 1;
        const state = n >= 2 || i.attempts >= 3 ? "held" : "waiting";
        const error = JSON.stringify({
          kind: "interrupted",
          message:
            "进程中断：上游可能已完成；5 分钟后最多恢复一次，可能重复计费",
        });
        this.run(
          "UPDATE attempts SET state=?,ended=?,error=? WHERE id=?",
          "uncertain",
          Date.now(),
          error,
          i.attempt_id,
        );
        this.run(
          "UPDATE items SET state=?,interruptions=?,next=?,error=? WHERE id=?",
          state,
          n,
          Date.now() + 300000,
          error,
          i.id,
        );
        if (state === "held")
          this.run(
            "UPDATE jobs SET state='preflight_blocked',error=? WHERE id=? AND state='preflight'",
            error,
            i.job,
          );
      }
    });
  }
  jobs() {
    return this.all("SELECT * FROM jobs ORDER BY created DESC");
  }
  /** 前端用：近期活跃的 Job（附计数与最近活动时间）及全局汇总。 */
  overview(maxIdleMs = 3 * 24 * 3600 * 1000, now = Date.now(), { includeArchived = false } = {}) {
    const cacheKey = `${maxIdleMs}:${Boolean(includeArchived)}`;
    const cachedOverview = this._overviewCache.get(cacheKey);
    if (
      cachedOverview &&
      cachedOverview.writeSeq === this.writeSeq &&
      now >= cachedOverview.computedAt &&
      now <= cachedOverview.validUntil
    ) {
      return cachedOverview.result;
    }

    const allJobs = this.jobs();
    const liveIds = new Set(allJobs.map((j) => j.id));
    for (const key of this._jobMetaCache.keys()) {
      if (!liveIds.has(key)) this._jobMetaCache.delete(key);
    }

    const counts = {};
    for (const r of this.all("SELECT job,state,count(*) AS n FROM items GROUP BY job,state"))
      (counts[r.job] ??= {})[r.state] = r.n;
    const actionMaxByJob = Object.fromEntries(
      this.all("SELECT job,max(time) AS t FROM actions GROUP BY job").map((r) => [r.job, r.t]),
    );
    const modelsByJob = {};
    for (const r of this.all(
      "SELECT job,json_extract(body,'$.model') AS model FROM configs ORDER BY rowid",
    )) {
      if (!r.model) continue;
      const list = (modelsByJob[r.job] ??= []);
      if (!list.includes(r.model)) list.push(r.model);
    }

    const jobs = [];
    const totals = { counts: {}, cost: {}, attempts: 0, inputTokens: 0, outputTokens: 0 };
    let validUntil = Infinity;

    for (const j of allJobs) {
      const c = counts[j.id] || {};
      const countsKey = JSON.stringify(c);
      const actionMax = actionMaxByJob[j.id] || 0;
      const cached = this._jobMetaCache.get(j.id);
      let meta;
      if (
        cached &&
        (cached.writeSeq === this.writeSeq ||
          (cached.jobState === "completed" &&
            j.state === "completed" &&
            !c.running &&
            !c.queued &&
            !c.waiting &&
            !c.held &&
            cached.countsKey === countsKey &&
            cached.actionMax === actionMax))
      ) {
        meta = cached;
      } else {
        const attemptMax =
          this.get(
            "SELECT max(coalesce(a.ended,a.started)) AS t FROM items i JOIN attempts a ON a.item=i.id WHERE i.job=?",
            j.id,
          )?.t || 0;
        const lastActivity = Math.max(j.created, attemptMax, actionMax);
        const billing = this.all(
          `SELECT a.currency,count(*) n,sum(a.cost) cost,
            sum(coalesce(json_extract(a.usage,'$.inputTokens'),0)) inp,
            sum(coalesce(json_extract(a.usage,'$.outputTokens'),0)) outp
           FROM items i JOIN attempts a ON a.item=i.id WHERE i.job=? AND a.state!='running' GROUP BY a.currency`,
          j.id,
        );
        let topError = null;
        if ((c.held || 0) + (c.waiting || 0) > 0) {
          const errRow = this.get(
            "SELECT error,count(*) AS n FROM items WHERE job=? AND state IN ('held','waiting') AND error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 1",
            j.id,
          );
          if (errRow) {
            const parsed = parseErrorSafe(errRow.error);
            topError = {
              kind: parsed?.kind || null,
              message: parsed?.message || String(errRow.error),
              count: errRow.n,
            };
          }
        }
        meta = {
          writeSeq: this.writeSeq,
          jobState: j.state,
          countsKey,
          actionMax,
          lastActivity,
          billing,
          topError,
        };
        this._jobMetaCache.set(j.id, meta);
      }

      if (!includeArchived && now - meta.lastActivity > maxIdleMs && !c.running) continue;
      if (!includeArchived && !c.running) {
        validUntil = Math.min(validUntil, meta.lastActivity + maxIdleMs);
      }
      jobs.push({
        ...j,
        counts: c,
        lastActivity: meta.lastActivity,
        topError: meta.topError,
        models: modelsByJob[j.id] || [],
      });
      for (const [k, n] of Object.entries(c)) totals.counts[k] = (totals.counts[k] || 0) + n;
      for (const b of meta.billing) {
        totals.attempts += b.n;
        totals.inputTokens += b.inp;
        totals.outputTokens += b.outp;
        if (b.cost)
          totals.cost[b.currency || "unknown"] =
            (totals.cost[b.currency || "unknown"] || 0) + b.cost;
      }
    }

    const result = { jobs, totals, hiddenCount: allJobs.length - jobs.length };
    this._overviewCache.set(cacheKey, {
      writeSeq: this.writeSeq,
      computedAt: now,
      validUntil,
      result,
    });
    return result;
  }
  summary(id) {
    const job = this.get("SELECT * FROM jobs WHERE id=?", id);
    if (!job) return null;
    const counts = Object.fromEntries(
      this.all(
        "SELECT state,count(*) AS n FROM items WHERE job=? GROUP BY state",
        id,
      ).map((r) => [r.state, r.n]),
    );
    const billing = this.all(
      `SELECT json_extract(c.body,'$.provider') provider,a.currency,
      count(*) n, count(a.cost) cost_count, sum(a.cost) cost,
      sum(CASE WHEN a.usage IS NOT NULL THEN 1 ELSE 0 END) token_count,
      sum(CASE WHEN a.cost IS NULL AND a.usage IS NULL THEN 1 ELSE 0 END) unknown_count,
      sum(coalesce(json_extract(a.usage,'$.inputTokens'),0)) input_tokens,
      sum(coalesce(json_extract(a.usage,'$.outputTokens'),0)) output_tokens
      FROM attempts a JOIN items i ON i.id=a.item JOIN configs c ON c.id=i.config WHERE i.job=? AND a.state!='running' GROUP BY provider,a.currency`,
      id,
    );
    const totals = {};
    for (const b of billing) {
      const t = (totals[b.provider] ??= {
        attempts: 0,
        cost: {},
        costAttempts: 0,
        tokenAttempts: 0,
        unknownAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      t.attempts += b.n;
      t.costAttempts += b.cost_count;
      t.tokenAttempts += b.token_count;
      t.unknownAttempts += b.unknown_count;
      t.inputTokens += b.input_tokens;
      t.outputTokens += b.output_tokens;
      if (b.cost_count)
        t.cost[b.currency || "unknown"] =
          (t.cost[b.currency || "unknown"] || 0) + b.cost;
    }

    const configRows = this.all(
      "SELECT id,batch,body,checked FROM configs WHERE job=? ORDER BY rowid",
      id,
    );
    const batchCounts = {};
    for (const r of this.all(
      "SELECT config,state,count(*) AS n FROM items WHERE job=? GROUP BY config,state",
      id,
    ))
      (batchCounts[r.config] ??= {})[r.state] = r.n;

    const batchBilling = {};
    for (const b of this.all(
      `SELECT i.config AS config_id,a.currency,
        count(*) n, count(a.cost) cost_count, sum(a.cost) cost,
        sum(CASE WHEN a.usage IS NOT NULL THEN 1 ELSE 0 END) token_count,
        sum(CASE WHEN a.cost IS NULL AND a.usage IS NULL THEN 1 ELSE 0 END) unknown_count,
        sum(coalesce(json_extract(a.usage,'$.inputTokens'),0)) input_tokens,
        sum(coalesce(json_extract(a.usage,'$.outputTokens'),0)) output_tokens,
        sum(CASE WHEN a.ended IS NOT NULL THEN a.ended - a.started ELSE 0 END) duration_sum,
        sum(CASE WHEN a.ended IS NOT NULL THEN 1 ELSE 0 END) duration_count
       FROM items i JOIN attempts a ON a.item=i.id
       WHERE i.job=? AND a.state!='running'
       GROUP BY i.config,a.currency`,
      id,
    )) {
      const u = (batchBilling[b.config_id] ??= {
        attempts: 0,
        cost: {},
        costAttempts: 0,
        tokenAttempts: 0,
        unknownAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        _durSum: 0,
        _durCount: 0,
      });
      u.attempts += b.n;
      u.costAttempts += b.cost_count;
      u.tokenAttempts += b.token_count;
      u.unknownAttempts += b.unknown_count;
      u.inputTokens += b.input_tokens;
      u.outputTokens += b.output_tokens;
      u._durSum += b.duration_sum;
      u._durCount += b.duration_count;
      if (b.cost_count)
        u.cost[b.currency || "unknown"] =
          (u.cost[b.currency || "unknown"] || 0) + b.cost;
    }

    const batches = configRows.map((c) => {
      const rawU = batchBilling[c.id];
      const usage = rawU
        ? {
            attempts: rawU.attempts,
            cost: rawU.cost,
            costAttempts: rawU.costAttempts,
            tokenAttempts: rawU.tokenAttempts,
            unknownAttempts: rawU.unknownAttempts,
            inputTokens: rawU.inputTokens,
            outputTokens: rawU.outputTokens,
            avgDurationMs: rawU._durCount ? Math.round(rawU._durSum / rawU._durCount) : null,
          }
        : {
            attempts: 0,
            cost: {},
            costAttempts: 0,
            tokenAttempts: 0,
            unknownAttempts: 0,
            inputTokens: 0,
            outputTokens: 0,
            avgDurationMs: null,
          };
      return {
        id: c.id,
        batch: c.batch,
        checked: Boolean(c.checked),
        config: JSON.parse(c.body),
        counts: batchCounts[c.id] || {},
        usage,
      };
    });

    const errorGroups = this.all(
      `SELECT c.batch AS batch,i.config AS config_id,i.state AS state,i.error AS error,count(*) AS n
       FROM items i JOIN configs c ON c.id=i.config
       WHERE i.job=? AND i.state IN ('held','waiting') AND i.error IS NOT NULL
       GROUP BY i.config,i.state,i.error
       ORDER BY n DESC`,
      id,
    ).map((r) => ({
      batch: r.batch,
      configId: r.config_id,
      state: r.state,
      count: r.n,
      error: parseErrorSafe(r.error),
    }));

    const attemptMax =
      this.get(
        "SELECT max(coalesce(a.ended,a.started)) AS t FROM items i JOIN attempts a ON a.item=i.id WHERE i.job=?",
        id,
      )?.t || 0;
    const actionMax =
      this.get("SELECT max(time) AS t FROM actions WHERE job=?", id)?.t || 0;
    const lastActivity = Math.max(job.created, attemptMax, actionMax);

    return {
      ...job,
      lastActivity,
      counts,
      totals,
      batches,
      errorGroups,
      configs: configRows.map((x) => ({
        batch: x.batch,
        body: JSON.parse(x.body),
        checked: x.checked,
      })),
    };
  }
}
