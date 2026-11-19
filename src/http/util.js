import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export async function readJSON(req, max = 2_000_000) {
  let size = 0;
  const parts = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw Error("请求太大，请改用 JSONL");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

/** 仅允许本机 Host 与同源请求；通过返回 true，否则已写入 403。 */
export function guardLocal(req, res) {
  const host = req.headers.host || "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    sendJSON(res, 403, { error: "仅允许 localhost / 127.0.0.1 Host" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) {
    sendJSON(res, 403, { error: "不允许跨站请求" });
    return false;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  return true;
}

export async function serveStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return false;
  res.writeHead(200, { "Content-Type": entry[1], "Content-Security-Policy": CSP });
  res.end(await readFile(PUBLIC_DIR + entry[0]));
  return true;
}

const STORAGE_CODES = [8, 10, 11, 13, 26];
const STORAGE_MESSAGE =
  /SQLITE_(FULL|IOERR|CORRUPT|NOTADB|READONLY)|database or disk is full|disk I.O error/i;

export function isStorageError(e) {
  return STORAGE_CODES.includes((e.errcode || 0) & 255) || STORAGE_MESSAGE.test(e.message);
}
