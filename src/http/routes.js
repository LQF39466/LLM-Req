import { once } from "node:events";
import { HttpError, readJSON, sendJSON } from "./util.js";
import { importJob } from "./importer.js";

const ITEM_COLUMNS = `i.id,i.query_id,i.state,i.attempts,i.interruptions,i.free_failures,i.next,i.error,i.config,
  c.batch AS batch,
  json_extract(c.body,'$.provider') AS provider,
  json_extract(c.body,'$.model') AS model,
  coalesce(substr(json_extract(i.result,'$.partial'),1,200),'') AS preview,
  CASE WHEN length(json_extract(i.result,'$.reasoning'))>0 THEN 1 ELSE 0 END AS hasReasoning,
  json_extract(i.result,'$.contentFiltered') AS contentFiltered,
  json_extract(i.result,'$.manualRefusal') AS manualRefusal,
  json_extract(i.result,'$.usage.inputTokens') AS inputTokens,
  json_extract(i.result,'$.usage.outputTokens') AS outputTokens,
  json_extract(i.result,'$.cost') AS cost,
  json_extract(i.result,'$.currency') AS currency,
  (SELECT a.ended - a.started FROM attempts a WHERE a.item=i.id AND a.ended IS NOT NULL ORDER BY a.started DESC, a.rowid DESC LIMIT 1) AS durationMs`;
const PAGE_SIZE = 100;
const parseJSON = (s) => JSON.parse(s);
const escapeLike = (s) => s.replace(/[\\%_]/g, "\\$&");

/** 构造路由表。每个 handler 接收 ctx = { req, res, url, params, store, scheduler }。 */
export function buildRoutes({ store, scheduler }) {
  const routes = [];
  const add = (method, pattern, handler) =>
    routes.push({
      method,
      regex: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"),
      handler,
    });
  const noFault = (msg) => {
    if (scheduler.fatal) throw Error(msg);
  };
  const requireJob = (id) => {
    if (!store.get("SELECT 1 FROM jobs WHERE id=?", id))
      throw new HttpError(404, "Job 不存在");
  };

  const status = () => ({
    fatal: scheduler.fatal,
    active: scheduler.active.size,
    globalMax: scheduler.globalMax,
    controls: Object.fromEntries(
      [...scheduler.controls].map(([p, c]) => [p, { ...c, inFlight: scheduler.inFlight(p) }]),
    ),
  });
  const overview = (includeArchived = false) => ({
    ...store.overview(undefined, undefined, { includeArchived }),
    status: status(),
  });

  /** SSE：仅在内容变化时推送；定时发送心跳注释保持连接。 */
  const stream = (res, build) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let last = "";
    let beat = 0;
    const tick = () => {
      if (res.writableLength > 256000) return res.destroy();
      try {
        const data = JSON.stringify(build());
        if (data !== last) {
          last = data;
          res.write(`data: ${data}\n\n`);
        } else if (++beat % 8 === 0) res.write(": keepalive\n\n");
      } catch {
        res.end();
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    res.on("close", () => clearInterval(timer));
  };

  add("GET", "/api/status", ({ res }) => sendJSON(res, 200, status()));
  add("GET", "/api/overview", ({ res, url }) =>
    sendJSON(res, 200, overview(url.searchParams.get("all") === "1")),
  );
  add("GET", "/api/stream", ({ res, url }) => {
    const includeArchived = url.searchParams.get("all") === "1";
    stream(res, () => overview(includeArchived));
  });

  add("GET", "/api/jobs", ({ res }) => sendJSON(res, 200, store.jobs()));

  add("POST", "/api/jobs", async ({ req, res }) => {
    noFault("存储故障：停止接收任务");
    sendJSON(res, 201, { id: await importJob(req, store) });
  });

  add("GET", "/api/jobs/:id", ({ res, params }) => {
    requireJob(params.id);
    sendJSON(res, 200, store.summary(params.id));
  });

  add("DELETE", "/api/jobs/:id", ({ res, params }) => {
    requireJob(params.id);
    noFault("存储故障：停止处置任务");
    scheduler.deleteJob(params.id);
    sendJSON(res, 200, { ok: true });
  });

  add("POST", "/api/jobs/:id/items/bulk", async ({ req, res, params }) => {
    requireJob(params.id);
    noFault("存储故障：停止处置任务");
    const result = scheduler.bulkAction(params.id, await readJSON(req));
    sendJSON(res, 200, { ok: true, ...result });
  });

  add("POST", "/api/jobs/:id/batch-ops", async ({ req, res, params }) => {
    requireJob(params.id);
    noFault("存储故障：停止处置任务");
    const result = scheduler.batchOperate(params.id, await readJSON(req));
    sendJSON(res, 200, { ok: true, ...result });
  });

  for (const action of ["pause", "resume"])
    add("POST", `/api/jobs/:id/${action}`, ({ res, params }) => {
      requireJob(params.id);
      scheduler.jobAction(params.id, action);
      sendJSON(res, 200, { ok: true });
    });

  add("GET", "/api/jobs/:id/items", ({ res, url, params }) => {
    requireJob(params.id);
    const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
    const state = url.searchParams.get("state");
    const batch = url.searchParams.get("batch");
    const q = (url.searchParams.get("q") || "").trim();
    const conds = ["i.job=?", "i.id>?"];
    const queryParams = [params.id, after];
    if (state) {
      conds.push("i.state=?");
      queryParams.push(state);
    }
    if (batch) {
      conds.push("c.batch=?");
      queryParams.push(batch);
    }
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      conds.push(
        "(i.query_id LIKE ? ESCAPE '\\' OR coalesce(i.error,'') LIKE ? ESCAPE '\\' OR coalesce(i.result,'') LIKE ? ESCAPE '\\')",
      );
      queryParams.push(pattern, pattern, pattern);
    }
    const rows = store.all(
      `SELECT ${ITEM_COLUMNS} FROM items i JOIN configs c ON c.id=i.config
       WHERE ${conds.join(" AND ")} ORDER BY i.id LIMIT ${PAGE_SIZE}`,
      ...queryParams,
    );
    sendJSON(res, 200, rows);
  });

  add("GET", "/api/jobs/:id/events", ({ res, params }) => {
    requireJob(params.id);
    stream(res, () => store.summary(params.id));
  });

  add("GET", "/api/jobs/:id/export", async ({ res, params }) => {
    requireJob(params.id);
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${params.id}.jsonl"`,
    });
    let cursor = 0;
    while (!res.destroyed) {
      const rows = store.all(
        `SELECT i.*,c.body AS config_body FROM items i JOIN configs c ON c.id=i.config WHERE i.job=? AND i.id>? ORDER BY i.id LIMIT ${PAGE_SIZE}`,
        params.id,
        cursor,
      );
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.id;
        const record = {
          ...row,
          input: parseJSON(row.input),
          config: parseJSON(row.config_body),
          config_body: undefined,
          result: row.result ? parseJSON(row.result) : null,
          attemptHistory: store.all(
            "SELECT * FROM attempts WHERE item=? ORDER BY started",
            row.id,
          ),
        };
        if (!res.write(JSON.stringify(record) + "\n")) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
          if (res.destroyed) break;
        }
      }
    }
    res.end();
  });

  add("GET", "/api/items/:id", ({ res, params }) => {
    const id = Number(params.id);
    const row = store.get("SELECT * FROM items WHERE id=?", id);
    if (!row) throw new HttpError(404, "条目不存在");
    const cfg = store.get("SELECT batch,body FROM configs WHERE id=?", row.config);
    sendJSON(res, 200, {
      ...row,
      batch: cfg?.batch || null,
      configBody: parseJSON(cfg.body),
      attemptHistory: store.all("SELECT * FROM attempts WHERE item=? ORDER BY started, rowid", id),
      actions: store.all("SELECT * FROM actions WHERE item=? ORDER BY time, id", id),
    });
  });

  add("POST", "/api/items/:id", async ({ req, res, params }) => {
    const body = await readJSON(req);
    scheduler.itemAction(Number(params.id), body.action, body.patch);
    sendJSON(res, 200, { ok: true });
  });

  return (method, pathname) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) return { handler: r.handler, params: { ...m.groups } };
    }
    return null;
  };
}
