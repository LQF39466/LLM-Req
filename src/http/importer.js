import { readJSON } from "./util.js";

const CHUNK_ROWS = 250;
const MAX_JSONL_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_LINE = 2_000_000;

/** 流式解析 JSONL：首行为 Job 头，其余为 query；按块写入。 */
async function importJSONL(req, store, state) {
  let pending = "";
  let bytes = 0;
  let lineNo = 0;
  let rows = [];
  const decoder = new TextDecoder();

  const consume = (text) => {
    lineNo++;
    if (!text.trim()) return;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw Error(`第 ${lineNo} 行 JSON 无效`);
    }
    try {
      if (!state.importer) {
        state.importer = store.begin(value);
        return;
      }
      rows.push(value);
      if (rows.length >= CHUNK_ROWS) {
        store.append(state.importer, rows);
        rows = [];
      }
    } catch (e) {
      throw Error(`第 ${lineNo} 行: ${e.message}`);
    }
  };

  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSONL_BYTES) throw Error("Job 超过 512MB");
    pending += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      if (line.length > MAX_LINE) throw Error("单行超过 2M 字符");
      consume(line);
      pending = pending.slice(index + 1);
    }
    if (pending.length > MAX_LINE) throw Error("单行超过 2M 字符");
  }
  pending += decoder.decode();
  if (pending.trim()) consume(pending);
  if (!state.importer) throw Error("空文件");
  if (rows.length) store.append(state.importer, rows);
}

async function importJSON(req, store, state) {
  const spec = await readJSON(req, MAX_JSON_BYTES);
  state.importer = store.begin(spec);
  for (const batch of spec.batches) {
    if (!Array.isArray(batch.queries))
      throw Error("JSON 格式每个 batch 必须有 queries 数组");
    for (let k = 0; k < batch.queries.length; k += CHUNK_ROWS)
      store.append(
        state.importer,
        batch.queries.slice(k, k + CHUNK_ROWS).map((q) => ({ ...q, batch: batch.id })),
      );
  }
}

/** 导入并封存一个 Job，失败时清理半成品；返回 Job ID。 */
export async function importJob(req, store) {
  const state = { importer: null };
  try {
    const isJSONL = (req.headers["content-type"] || "").includes("ndjson");
    await (isJSONL ? importJSONL : importJSON)(req, store, state);
    for (const [batch, configId] of state.importer.batches)
      if (!store.get("SELECT 1 FROM items WHERE config=? LIMIT 1", configId))
        throw Error(`批次 ${batch} 没有 query`);
    return store.seal(state.importer);
  } catch (e) {
    if (state.importer)
      store.run("DELETE FROM jobs WHERE id=? AND state='importing'", state.importer.id);
    throw e;
  }
}
