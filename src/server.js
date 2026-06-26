/**
 * Node.js (native http) entry — thin adapter over the shared core.
 *
 * Bridges Node's http.IncomingMessage <-> Web Request/Response so the exact
 * same core.js used by the Worker target runs under plain Node / Docker.
 *
 * Run:  node src/server.js        Env: PORT, HOST, POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS, MULEROUTER_BASE_URL
 */
import http from "node:http";
import { handleRequest, resolveConfig } from "./core.js";

const config = resolveConfig(process.env);
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "0.0.0.0";

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  try {
    // Buffer the request body (fine for this gateway's payload sizes).
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody && chunks.length ? Buffer.concat(chunks) : undefined;

    // Reconstruct a full URL (honor x-forwarded-proto behind a reverse proxy).
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = `${proto}://${host}${req.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await handleRequest(request, config);

    const outHeaders = {};
    response.headers.forEach((v, k) => {
      outHeaders[k] = v;
    });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));

    console.log(`${req.method} ${req.url} ${response.status} ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error("Request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err?.message || err), type: "api_error" } }));
    } else {
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    }
  }
});

server.on("clientError", (_err, socket) => socket.destroy());

server.listen(PORT, HOST, () => {
  console.log(`mulerouter-openai-gateway listening on http://${HOST}:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
