/**
 * Runtime-agnostic core for the multi-model image gateway.
 *
 * Exposes THREE access styles over MuleRouter's async task API:
 *
 *   1. OpenAI Images API  (text-to-image + edit)
 *        POST /v1/images/generations   -> model chosen via `model` field
 *        POST /v1/images/edits         -> gpt-image-2
 *
 *   2. Gemini generateContent API  (Google-native shape)
 *        POST /v1beta/models/{model}:generateContent
 *        POST /v1beta/models/{model}:streamGenerateContent
 *        GET  /v1beta/models           (model list)
 *
 * Supported models: gpt-image-2, nano-banana-2, nano-banana-pro
 * (plus Gemini-style aliases like gemini-3.1-flash-image-preview).
 *
 * Only Web-standard APIs are used, so this file runs unmodified in both
 * Cloudflare Workers (src/worker.js) and Node 18+ (src/server.js).
 *
 * The MuleRouter key is supplied by the CLIENT per request and forwarded
 * upstream — the gateway stores nothing.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ configuration ----------------------------- */

export function resolveConfig(env) {
  return {
    origin: (env && env.MULEROUTER_API_ORIGIN) || "https://api.mulerouter.ai",
    pollInterval: parseInt((env && env.POLL_INTERVAL_MS) || "3000", 10),
    maxAttempts: parseInt((env && env.POLL_MAX_ATTEMPTS) || "40", 10),
  };
}

/* -------------------------------- models --------------------------------- */
/*
 * Each model knows its MuleRouter path prefix and the shape of its generation
 * request, so the OpenAI/Gemini-facing handlers can stay model-agnostic.
 */

const MODELS = {
  "gpt-image-2": {
    label: "gpt-image-2",
    vendor: "openai",
    style: "openai",
    pathPrefix: "/vendors/openai/v1/gpt-image-2",
  },
  "nano-banana-2": {
    label: "nano-banana-2",
    vendor: "google",
    style: "google",
    pathPrefix: "/vendors/google/v1/nano-banana-2",
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "1K",
    aspectRatios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
    supportsWebSearch: true,
  },
  "nano-banana-pro": {
    label: "nano-banana-pro",
    vendor: "google",
    style: "google",
    pathPrefix: "/vendors/google/v1/nano-banana-pro",
    resolutions: ["1K", "2K"],
    defaultResolution: "2K",
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    supportsWebSearch: false,
  },
};

const ALIASES = {
  "gpt-image-1": "gpt-image-2",
  "gpt-image-2": "gpt-image-2",
  "nano-banana-2": "nano-banana-2",
  "nano-banana-pro": "nano-banana-pro",
  // Gemini-native names
  "gemini-3.1-flash-image-preview": "nano-banana-2",
  "gemini-3.1-flash-image": "nano-banana-2",
  "gemini-3-flash-image": "nano-banana-2",
  "gemini-2.5-flash-image": "nano-banana-pro",
  "gemini-2.5-flash-image-preview": "nano-banana-pro",
};

function resolveModel(rawName, { defaultModel = "gpt-image-2" } = {}) {
  const name = String(rawName || "").trim().toLowerCase();
  if (!name) return defaultModel;
  if (ALIASES[name]) return ALIASES[name];
  const isBanana = name.includes("banana") || name.includes("flash-image");
  if (isBanana && name.includes("pro")) return "nano-banana-pro";
  if (isBanana && (name.includes("2") || name.includes("3"))) return "nano-banana-2";
  if (isBanana) return "nano-banana-2";
  if (name.includes("gpt-image")) return "gpt-image-2";
  return null;
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

// Google-style error envelope, for the Gemini-style routes.
function geminiError(status, message, statusStr = "INVALID_ARGUMENT") {
  return json(status, { error: { code: status, message, status: statusStr } });
}

function extractKey(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

// Gemini clients pass the key as x-goog-api-key or ?key=; fall back to Bearer.
function extractKeyAny(request) {
  const goog = request.headers.get("x-goog-api-key");
  if (goog) return goog.trim();
  const q = new URL(request.url).searchParams.get("key");
  if (q) return q.trim();
  return extractKey(request);
}

function toInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ------------------------- OpenAI -> upstream params ---------------------- */

const SIZE_TO_ASPECT = {
  "1024x1024": "1:1", "2048x2048": "1:1", "4096x4096": "1:1",
  "1536x1024": "3:2", "1024x1536": "2:3",
  "1792x1024": "16:9", "1024x1792": "9:16",
  "3840x2160": "16:9", "2160x3840": "9:16",
  "2048x1152": "16:9", "2048x858": "21:9",
};

function sizeToAspectRatio(size) {
  return SIZE_TO_ASPECT[size] || null;
}

function qualityToResolution(quality, model) {
  if (!quality || quality === "auto") return null;
  if (quality === "high") return model.resolutions.includes("4K") ? "2K" : "2K"; // keep 2K; pass explicit resolution for 4K
  return "1K";
}

// Build the upstream generation payload for a given model from a unified input.
function buildGenerationPayload(modelKey, input) {
  const m = MODELS[modelKey];
  if (m.style === "openai") {
    return {
      prompt: input.prompt,
      n: toInt(input.n, 1),
      size: input.size || "auto",
      quality: input.quality || "high",
      format: input.format || "png",
    };
  }
  // Google models: aspect_ratio + resolution (+ web_search for nano-banana-2)
  let aspectRatio = input.aspect_ratio || sizeToAspectRatio(input.size) || "1:1";
  if (!m.aspectRatios.includes(aspectRatio)) aspectRatio = "1:1";
  let resolution = input.resolution || qualityToResolution(input.quality, m) || m.defaultResolution;
  if (!m.resolutions.includes(resolution)) resolution = m.defaultResolution;
  const payload = { prompt: input.prompt, aspect_ratio: aspectRatio, resolution };
  if (m.supportsWebSearch && input.web_search !== undefined) {
    payload.web_search = !!input.web_search;
  }
  return payload;
}

/* ------------------------------ upstream I/O ------------------------------ */

async function submitTask(url, apiKey, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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
    const detail = parsed?.error?.message || parsed?.message || parsed?.detail || text;
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
      continue; // transient — keep polling
    }
    const status = parsed?.task_info?.status;
    if (status === "completed" || status === "succeeded" || status === "failed") {
      return parsed;
    }
  }
  return null;
}

/** Locate the image list across response shapes MuleRouter may return. */
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

async function fetchToBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return arrayBufferToBase64(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Run a text-to-image generation for `modelKey`. Returns { images, description, error }.
 * Google models generate one image per task, so n>1 fans out to n parallel tasks;
 * the OpenAI model handles n in a single task natively.
 */
async function runGeneration(origin, modelKey, apiKey, input, config) {
  const m = MODELS[modelKey];
  const payload = buildGenerationPayload(modelKey, input);
  const submitUrl = `${origin}${m.pathPrefix}/generation`;
  const pollUrl = (id) => `${origin}${m.pathPrefix}/generation/${id}`;

  const one = async () => {
    let task;
    try {
      task = await submitTask(submitUrl, apiKey, payload);
    } catch (e) {
      return { error: { status: 502, message: `Failed to submit task: ${e.message}` } };
    }
    const id = task?.task_info?.id;
    if (!id) {
      return { error: { status: 502, message: "Upstream accepted the request but returned no task id." } };
    }
    const result = await pollTask(pollUrl(id), apiKey, config);
    if (!result) {
      return { error: { status: 504, message: `Image generation timed out while polling upstream (${modelKey}).`, type: "api_error" } };
    }
    if (result.task_info?.status === "failed") {
      return { error: { status: 502, message: `Upstream task failed: ${JSON.stringify(result.task_info)}` } };
    }
    return { result };
  };

  let description;
  const images = [];

  if (m.style === "openai") {
    const r = await one();
    if (r.error) return { images: [], error: r.error };
    description = r.result.description;
    images.push(...extractImages(r.result));
  } else {
    const n = Math.max(1, Math.min(toInt(input.n, 1), 4));
    const results = await Promise.all(Array.from({ length: n }, () => one()));
    for (const r of results) {
      if (r.error) return { images: [], error: r.error };
      images.push(...extractImages(r.result));
      if (!description && r.result.description) description = r.result.description;
    }
  }

  return { images, description };
}

/** Shape upstream images into the OpenAI response, honoring response_format. */
async function shapeOpenAIResponse(images, responseFormat, extraHeaders) {
  const wantB64 = responseFormat === "b64_json";
  const data = [];
  for (const img of images) {
    if (wantB64) {
      let b64 = img.b64_json;
      if (!b64 && img.url && img.url.startsWith("data:")) b64 = img.url.split(",")[1];
      if (!b64 && img.url) b64 = await fetchToBase64(img.url);
      data.push(b64 ? { b64_json: b64 } : { url: img.url });
    } else {
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

/* ------------------------------- Gemini I/O ------------------------------ */

function extractGeminiPrompt(body) {
  const parts = [];
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  for (const c of contents) {
    const ps = Array.isArray(c?.parts) ? c.parts : [];
    for (const p of ps) {
      if (typeof p?.text === "string" && p.text.length) parts.push(p.text);
    }
  }
  return parts.join("\n").trim();
}

/** Convert a finished generation into Gemini candidates (inlineData = base64). */
async function shapeGeminiResponse(images, description, requestedModel) {
  const parts = [];
  if (description) parts.push({ text: description });
  for (const img of images) {
    let b64 = img.b64_json;
    let mime = "image/png";
    if (!b64 && img.url) {
      const m = img.url.match(/^data:([^;]+);base64,(.*)$/);
      if (m) {
        mime = m[1];
        b64 = m[2];
      } else {
        b64 = await fetchToBase64(img.url);
      }
    }
    if (b64) parts.push({ inlineData: { mimeType: mime, data: b64 } });
  }
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    modelVersion: requestedModel,
  };
}

const GEMINI_MODEL_LIST = [
  { name: "models/gemini-3.1-flash-image-preview", baseModelId: "nano-banana-2", displayName: "Nano Banana 2", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
  { name: "models/gemini-2.5-flash-image-preview", baseModelId: "nano-banana-pro", displayName: "Nano Banana Pro", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
];

/* ----------------------------- route handlers ---------------------------- */

async function handleGenerations(request, apiKey, config) {
  let body;
  try {
    body = await request.json();
  } catch {
    return openaiError(400, "Request body must be valid JSON.");
  }

  const modelKey = resolveModel(body?.model);
  if (!modelKey) {
    return openaiError(400, `Unknown model: '${body?.model}'. Supported: gpt-image-2, nano-banana-2, nano-banana-pro.`);
  }
  if (!body?.prompt || typeof body.prompt !== "string") {
    return openaiError(400, "`prompt` is required.");
  }

  const { images, error } = await runGeneration(config.origin, modelKey, apiKey, body, config);
  if (error) return openaiError(error.status, error.message, error.type);
  if (!images.length) return openaiError(502, "Upstream completed but returned no images.", "api_error");
  return shapeOpenAIResponse(images, body.response_format, { "X-Upstream-Model": modelKey });
}

async function handleGeminiGenerate(request, config, requestedModel, modelKey, apiKey, method) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // empty body is allowed only if prompt provided via query? require contents
  }

  const prompt = extractGeminiPrompt(body);
  if (!prompt) {
    return geminiError(400, "Request must contain contents[].parts[].text with a prompt.", "INVALID_ARGUMENT");
  }

  const g = body.generationConfig || {};
  const input = {
    prompt,
    aspect_ratio: g.aspectRatio || g.aspect_ratio,
    resolution: g.resolution,
    web_search: g.webSearch ?? g.web_search,
    n: 1,
  };

  const { images, description, error } = await runGeneration(config.origin, modelKey, apiKey, input, config);
  if (error) {
    const statusStr = error.status === 401 ? "UNAUTHENTICATED" : error.status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT";
    return geminiError(error.status, error.message, statusStr);
  }
  if (!images.length) return geminiError(502, "Upstream completed but returned no images.", "INTERNAL");

  const candBody = await shapeGeminiResponse(images, description, requestedModel);
  const headers = { "X-Upstream-Model": modelKey };
  // streamGenerateContent returns a JSON array of candidate chunks.
  if (method === "streamGenerateContent") {
    return json(200, [candBody], headers);
  }
  return json(200, candBody, headers);
}

async function handleEdits(request, apiKey, config) {
  // Image edits are routed to gpt-image-2 (OpenAI) for now.
  const m = MODELS["gpt-image-2"];
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

  const payload = { prompt, images, n: toInt(n, 1), size: size || "auto", format: "png" };
  if (mask) payload.mask = mask;

  let task;
  try {
    task = await submitTask(`${config.origin}${m.pathPrefix}/edit`, apiKey, payload);
  } catch (e) {
    return openaiError(502, `Failed to submit task: ${e.message}`);
  }
  const taskId = task?.task_info?.id;
  if (!taskId) return openaiError(502, "Upstream accepted the request but returned no task id.");

  const result = await pollTask(`${config.origin}${m.pathPrefix}/edit/${taskId}`, apiKey, config);
  if (!result) return openaiError(504, "Image edit timed out while polling upstream.", "api_error");
  if (result.task_info?.status === "failed") {
    return openaiError(502, `Upstream task failed: ${JSON.stringify(result.task_info)}`);
  }

  const imgs = extractImages(result);
  if (!imgs.length) return openaiError(502, "Upstream completed but returned no images.", "api_error");
  return shapeOpenAIResponse(imgs, response_format, { "X-Upstream-Model": "gpt-image-2" });
}

/* --------------------------------- entry --------------------------------- */

const GEMINI_RE = /^\/(v1|v1beta)\/models\/([^/:]+):(generateContent|streamGenerateContent|predict)$/;
const GEMINI_LIST_RE = /^\/(v1|v1beta)\/models\/?$/;

export async function handleRequest(request, config) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, x-goog-api-key",
      },
    });
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return json(200, { status: "ok", service: "mulerouter-image-gateway", models: Object.keys(MODELS) });
  }

  // Gemini-style: list models
  if (request.method === "GET" && GEMINI_LIST_RE.test(url.pathname)) {
    return json(200, { models: GEMINI_MODEL_LIST });
  }

  // Gemini-style: generateContent / streamGenerateContent / predict
  const gem = request.method === "POST" ? url.pathname.match(GEMINI_RE) : null;
  if (gem) {
    const requestedModel = decodeURIComponent(gem[2]);
    const modelKey = resolveModel(requestedModel);
    if (!modelKey || MODELS[modelKey].style !== "google") {
      return geminiError(404, `Unsupported model for Gemini-style access: '${requestedModel}'. Supported: nano-banana-2, nano-banana-pro (and gemini-* aliases).`, "NOT_FOUND");
    }
    const apiKey = extractKeyAny(request);
    if (!apiKey) {
      return geminiError(401, "Missing API key. Use x-goog-api-key header, ?key=, or Authorization: Bearer.", "UNAUTHENTICATED");
    }
    try {
      return await handleGeminiGenerate(request, config, requestedModel, modelKey, apiKey, gem[3]);
    } catch (e) {
      return geminiError(500, `Internal error: ${e?.message || String(e)}`, "INTERNAL");
    }
  }

  if (request.method !== "POST") {
    return openaiError(405, `Method not allowed: ${request.method}`);
  }

  // OpenAI-style: generations + edits
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
