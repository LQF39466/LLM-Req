import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { Scheduler } from "./scheduler.js";
import { lockDatabase } from "./lock.js";
import { buildRoutes } from "./http/routes.js";
import {
  guardLocal,
  isStorageError,
  sendJSON,
  serveStatic,
} from "./http/util.js";

process.umask(0o077);

export function app(store, scheduler) {
  const match = buildRoutes({ store, scheduler });
  return createServer(async (req, res) => {
    if (!guardLocal(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const route = match(req.method, url.pathname);
      if (route) return await route.handler({ req, res, url, params: route.params, store, scheduler });
      if (req.method === "GET" && (await serveStatic(res, url.pathname))) return;
      sendJSON(res, 404, { error: "Not found" });
    } catch (e) {
      if (res.headersSent) return void res.end();
      const storage = isStorageError(e);
      if (storage) scheduler.storageFault(e);
      sendJSON(res, e.status ?? (storage ? 503 : 400), { error: e.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  const dbPath = process.env.DB_PATH || "data/jobs.sqlite";
  const unlock = lockDatabase(dbPath);
  const store = new Store(dbPath);
  // Bind before recovering or dispatching: a second process must never reclaim live work.
  const scheduler = new Scheduler(store);
  const server = app(store, scheduler);
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.on("error", (e) => {
    console.error(e.message);
    store.db.close();
    unlock();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    store.recover();
    scheduler.start();
    console.log(`LLM Jobs: http://127.0.0.1:${port}`);
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeAllConnections();
    await scheduler.stop();
    store.db.close();
    unlock();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
