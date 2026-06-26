/**
 * Cloudflare Workers entry — thin adapter over the shared core.
 * Deploy with: npx wrangler deploy   (wrangler.jsonc -> main = src/worker.js)
 */
import { handleRequest, resolveConfig } from "./core.js";

export default {
  fetch(request, env) {
    return handleRequest(request, resolveConfig(env));
  },
};
