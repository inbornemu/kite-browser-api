import { createServer } from "node:http";
import { fault, equal } from "./store.mjs";
export async function body(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const b of req) {
    size += b.length;
    if (size > limit) throw fault("body_over_limit", 413);
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw fault("invalid_json");
  }
}
export function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
export function auth(req, token) {
  if (!token || !equal(req.headers.authorization, "Bearer " + token))
    throw fault("authentication_required", 401);
}
export function serve(handler, port = Number(process.env.PORT || 4400)) {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 500, { error: e.code || "internal_error" });
      else res.destroy();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 80;
  return server.listen(port, process.env.HOST || "127.0.0.1");
}
