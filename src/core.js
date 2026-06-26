/**
 * Runtime-agnostic core for the OpenAI-compatible MuleRouter gpt-image-2 gateway.
 *
 * Exposes:
 *   - resolveConfig(env): turn an env record (CF env bindings OR process.env)
 *     into a plain { base, pollInterval, maxAttempts } config.
 *   - handleRequest(request, config): standard Web Request -> Web Response.
 *
 * Consumed by two thin entry points that share this core:
 *   - src/worker.js  (Cloudflare Workers)
 *   - src/server.js  (Node.js native http / Docker)
 *
 * Only Web-standard APIs are used (fetch, Request, Response, Headers, URL,
 * formData, btoa, setTimeout) — all available globally in both Workers and
 * Node 18+, so this file runs unmodified in either runtime.
 */

const DEFAULT_BASE = "https://api.mulerouter.ai/vendors/openai/v1/gpt-image-2";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function resolveConfig(env) {
  return {
    base: (env && env.MULEROUTER_BASE_URL) || DEFAULT_BASE,
    pollInterval: parseInt((env && env.POLL_INTERVAL_MS) || "3000", 10),
    maxAttempts: parseInt((env && env.POLL_MAX_ATTEMPTS) || "40", 10),
  };
}

/* ----------------------------- small helpers ----------------------------- */

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}

function openaiError(status, message, type = "invalid_request_error") {
  return json(status, { error: { message, type, param: null, code: null } });
}

function extractKey(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

/** Integer coercion that treats null/"" as "use the default" (Number(null) is 0!). */
function toInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000; // avoid call-stack overflow on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ------------------------------ upstream I/O ------------------------------ */

async function submitTask(url, apiKey, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Upstream returned non-JSON (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail =
      parsed?.error?.message || parsed?.message || parsed?.detail || text;
    const err = new Error(`Upstream HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

async function pollTask(url, apiKey, config) {
  for (let i = 0; i < config.maxAttempts; i++) {
    await sleep(config.pollInterval);
    let parsed;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      parsed = await res.json();
    } catch {
      continue; // transient network/parse error — keep polling
    }
    const status = parsed?.task_info?.status;
    if (status === "completed" || status === "succeeded" || status === "failed") {
      return parsed;
    }
  }
  return null; // timed out
}

/* --------------------------- response shaping ---------------------------- */

/** Locate the image list across the response shapes MuleRouter may return. */
function extractImages(result) {
  const candidates = [
    result?.data,
    result?.images,
    result?.output,
    result?.result?.data,
    result?.result?.images,
    result?.result?.output,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return c.map(normalizeImage).filter(Boolean);
    }
  }
  return [];
}

function normalizeImage(item) {
  if (typeof item === "string") {
    return /^https?:\/\//.test(item) ? { url: item } : { b64_json: item };
  }
  if (item && typeof item === "object") {
    if (item.url) return { url: item.url };
    if (item.b64_json) return { b64_json: item.b64_json };
    if (item.image_url) return { url: item.image_url };
    if (item.base64) return { b64_json: item.base64 };
  }
  return null;
}

/** Best-effort: download a URL and return base64 (one extra outbound call). */
async function fetchToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return arrayBufferToBase64(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Shape upstream images into the OpenAI response, honoring response_format. */
async function shapeResponse(images, responseFormat, extraHeaders) {
  const wantB64 = responseFormat === "b64_json";
  const data = [];
  for (const img of images) {
    if (wantB64) {
      let b64 = img.b64_json;
      if (!b64 && img.url && img.url.startsWith("data:")) b64 = img.url.split(",")[1];
      if (!b64 && img.url) b64 = await fetchToBase64(img.url);
      data.push(b64 ? { b64_json: b64 } : { url: img.url });
    } else {
      // want url: prefer a real URL, else wrap base64 as a data URI
      if (img.url && !img.url.startsWith("data:")) {
        data.push({ url: img.url });
      } else if (img.b64_json) {
        data.push({ url: `data:image/png;base64,${img.b64_json}` });
      } else if (img.url) {
        data.push({ url: img.url });
      }
    }
  }
  return json(200, { created: Math.floor(Date.now() / 1000), data }, extraHeaders);
}

/* ----------------------------- route handlers ---------------------------- */

async function handleGenerations(request, apiKey, config) {
  let body;
  try {
    body = await request.json();
  } catch {
    return openaiError(400, "Request body must be valid JSON.");
  }

  const { prompt, n, size, quality, response_format } = body || {};
  if (!prompt || typeof prompt !== "string") {
    return openaiError(400, "`prompt` is required.");
  }

  const payload = {
    prompt,
    n: toInt(n, 1),
    size: size || "auto",
    quality: quality || "high",
    format: "png",
  };

  let task;
  try {
    task = await submitTask(`${config.base}/generation`, apiKey, payload);
  } catch (e) {
    return openaiError(502, `Failed to submit task: ${e.message}`);
  }

  const taskId = task?.task_info?.id;
  if (!taskId) {
    return openaiError(502, "Upstream accepted the request but returned no task id.");
  }

  const result = await pollTask(`${config.base}/generation/${taskId}`, apiKey, config);
  if (!result) {
    return openaiError(504, "Image generation timed out while polling upstream.", "api_error");
  }
  if (result.task_info?.status === "failed") {
    return openaiError(502, `Upstream task failed: ${JSON.stringify(result.task_info)}`);
  }

  const images = extractImages(result);
  if (!images.length) {
    return openaiError(502, "Upstream completed but returned no images.", "api_error");
  }
  return shapeResponse(images, response_format, { "X-Upstream-Task-Id": taskId });
}

async function handleEdits(request, apiKey, config) {
  // Accept both multipart/form-data (standard OpenAI) and JSON bodies.
  const ct = request.headers.get("content-type") || "";
  let prompt, imageItems, maskItem, n, size, response_format;

  if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    prompt = form.get("prompt");
    n = form.get("n");
    size = form.get("size");
    response_format = form.get("response_format");
    imageItems = [];
    for (const key of ["image", "images"]) {
      for (const v of form.getAll(key)) imageItems.push(v);
    }
    maskItem = form.get("mask");
  } else {
    let body;
    try {
      body = await request.json();
    } catch {
      return openaiError(400, "Request must be multipart/form-data or JSON.");
    }
    prompt = body.prompt;
    n = body.n;
    size = body.size;
    response_format = body.response_format;
    imageItems = [].concat(body.image || body.images || []).filter(Boolean);
    maskItem = body.mask;
  }

  if (!prompt) return openaiError(400, "`prompt` is required.");

  // Normalize inputs: file/blob -> base64; string -> pass-through (URL or base64).
  const images = [];
  for (const item of imageItems) {
    if (item && typeof item.arrayBuffer === "function") {
      images.push(arrayBufferToBase64(await item.arrayBuffer()));
    } else if (typeof item === "string" && item.length > 0) {
      images.push(item);
    }
  }
  if (!images.length) return openaiError(400, "`image` is required.");

  let mask = null;
  if (maskItem) {
    if (typeof maskItem.arrayBuffer === "function") {
      mask = arrayBufferToBase64(await maskItem.arrayBuffer());
    } else if (typeof maskItem === "string") {
      mask = maskItem;
    }
  }

  const payload = {
    prompt,
    images,
    n: toInt(n, 1),
    size: size || "auto",
    format: "png",
  };
  if (mask) payload.mask = mask;

  let task;
  try {
    task = await submitTask(`${config.base}/edit`, apiKey, payload);
  } catch (e) {
    return openaiError(502, `Failed to submit task: ${e.message}`);
  }

  const taskId = task?.task_info?.id;
  if (!taskId) {
    return openaiError(502, "Upstream accepted the request but returned no task id.");
  }

  const result = await pollTask(`${config.base}/edit/${taskId}`, apiKey, config);
  if (!result) {
    return openaiError(504, "Image edit timed out while polling upstream.", "api_error");
  }
  if (result.task_info?.status === "failed") {
    return openaiError(502, `Upstream task failed: ${JSON.stringify(result.task_info)}`);
  }

  const imgs = extractImages(result);
  if (!imgs.length) {
    return openaiError(502, "Upstream completed but returned no images.", "api_error");
  }
  return shapeResponse(imgs, response_format, { "X-Upstream-Task-Id": taskId });
}

/* --------------------------------- entry --------------------------------- */

export async function handleRequest(request, config) {
  const url = new URL(request.url);

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  // Health check
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(200, { status: "ok", service: "mulerouter-openai-gateway" });
  }

  if (request.method !== "POST") {
    return openaiError(405, `Method not allowed: ${request.method}`);
  }

  const apiKey = extractKey(request);
  if (!apiKey) {
    return openaiError(401, "Missing API key. Send `Authorization: Bearer <MULEROUTER_KEY>`.", "authentication_error");
  }

  try {
    if (url.pathname === "/v1/images/generations") {
      return await handleGenerations(request, apiKey, config);
    }
    if (url.pathname === "/v1/images/edits") {
      return await handleEdits(request, apiKey, config);
    }
    return openaiError(404, `Unknown endpoint: ${url.pathname}`);
  } catch (e) {
    return openaiError(500, `Internal error: ${e?.message || String(e)}`, "api_error");
  }
}
