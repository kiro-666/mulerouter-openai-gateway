# mulerouter-image-gateway

A stateless gateway that exposes [MuleRouter](https://www.mulerouter.ai)'s async image models through **standard APIs**, so any OpenAI- or Gemini-compatible client can use them as if they were synchronous.

MuleRouter uses an async task API (submit → poll → result). This gateway hides that behind two familiar shapes, and the MuleRouter key is supplied **by the client per request** — the gateway stores nothing.

## Models

| Model | MuleRouter upstream | Notes |
| --- | --- | --- |
| `gpt-image-2` | OpenAI gpt-image-2 | Default. Supports generation + edit. |
| `nano-banana-2` | Google Nano Banana 2 (Gemini 3.1 Flash Image Preview) | Up to 4K, 14 aspect ratios, optional `web_search` grounding. |
| `nano-banana-pro` | Google Nano Banana Pro | 1K/2K, 10 aspect ratios. |

Accepted `model` aliases: `gpt-image-1`, `gemini-3.1-flash-image-preview`, `gemini-2.5-flash-image`, etc.

## Endpoints

**OpenAI style**

| Endpoint | Maps to |
| --- | --- |
| `POST /v1/images/generations` | any model (chosen via `model`) |
| `POST /v1/images/edits` | gpt-image-2 |
| `GET /health` | health / model list |

**Gemini style** (Google-native shape)

| Endpoint | Maps to |
| --- | --- |
| `POST /v1beta/models/{model}:generateContent` | nano-banana-2 / nano-banana-pro |
| `POST /v1beta/models/{model}:streamGenerateContent` | same (returns a JSON array of chunks) |
| `GET /v1beta/models` | model list (Google format) |

Auth for either style: `Authorization: Bearer <KEY>`. Gemini clients may also use the `x-goog-api-key` header or `?key=` query param.

## Deploy

The same core (`src/core.js`) has two entry points — pick one.

```
src/core.js     # runtime-agnostic logic (Web-standard APIs only)
src/worker.js   # Cloudflare Workers entry
src/server.js   # Node.js native-http entry (Docker / bare metal)
```

### Option A — Docker / Node (no plan limits)

```bash
# Docker
docker compose up -d --build
# or pull the CI-published image from GHCR (no local build):
docker run -d -p 8787:8787 --name gateway \
  -e POLL_MAX_ATTEMPTS=60 \
  ghcr.io/kiro-666/mulerouter-openai-gateway:latest

# Plain Node (>= 18)
node src/server.js          # or: npm start
```

### Option B — Cloudflare Workers

```bash
npm install
npx wrangler deploy
```

## Usage

### OpenAI style — gpt-image-2

```bash
curl $HOST/v1/images/generations \
  -H "Authorization: Bearer $MULEROUTER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"a red panda","size":"1024x1024","quality":"high"}'
```

### OpenAI style — Nano Banana 2

```bash
curl $HOST/v1/images/generations \
  -H "Authorization: Bearer $MULEROUTER_KEY" -H "Content-Type: application/json" \
  -d '{"model":"nano-banana-2","prompt":"a ceramicist portrait","aspect_ratio":"3:4","resolution":"2K","web_search":true}'
```

Standard OpenAI fields are mapped when native ones aren't supplied: `size` → `aspect_ratio`, `quality` → `resolution`. Add `"response_format":"b64_json"` to get base64 back. `n>1` fans out to parallel tasks on Google models.

```python
from openai import OpenAI
c = OpenAI(base_url="https://<host>/v1", api_key="<MULEROUTER_KEY>")
img = c.images.generate(model="nano-banana-pro", prompt="a corgi", size="1024x1024")
```

### Gemini style — generateContent

```bash
curl $HOST/v1beta/models/gemini-3.1-flash-image-preview:generateContent \
  -H "x-goog-api-key: $MULEROUTER_KEY" -H "Content-Type: application/json" \
  -d '{
    "contents": [{"parts": [{"text": "a red panda astronaut, studio lighting"}]}],
    "generationConfig": {"aspectRatio": "3:4", "resolution": "2K"}
  }'
```

Response is Google-shaped; images come back as `inlineData` (base64). `generationConfig.aspectRatio` / `resolution` map to the native params.

```python
from google import genai
c = genai.Client(api_key="<MULEROUTER_KEY>", http_options={"base_url": "https://<host>"})
r = c.models.generate_content(model="gemini-3.1-flash-image-preview", contents="a corgi")
# r.candidates[0].content.parts[*].inline_data.data
```

## Parameter mapping

| OpenAI field | gpt-image-2 | Google models (nano-banana-*) |
| --- | --- | --- |
| `prompt` | `prompt` | `prompt` |
| `n` | `n` | fans out to N tasks (max 4) |
| `size` | `size` | → `aspect_ratio` (if not given) |
| `quality` | `quality` | → `resolution` (if not given) |
| `response_format` | shapes output | shapes output |
| — | — | `aspect_ratio`, `resolution`, `web_search` (nano-banana-2) pass through |

Allowed `aspect_ratio`: nano-banana-2 — `1:1 1:4 1:8 2:3 3:2 3:4 4:1 4:3 4:5 5:4 8:1 9:16 16:9 21:9`; nano-banana-pro — `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`. `resolution`: nano-banana-2 — `1K 2K 4K`; nano-banana-pro — `1K 2K`.

## Configuration (env vars)

All optional — defaults work out of the box.

| Var | Default | Meaning |
| --- | --- | --- |
| `MULEROUTER_API_ORIGIN` | `https://api.mulerouter.ai` | Upstream API origin |
| `POLL_INTERVAL_MS` | `3000` | Delay between poll calls |
| `POLL_MAX_ATTEMPTS` | `40` | Max poll rounds (self-host: raise to 60+) |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Node/Docker listen address (not used on Workers) |

## Notes & limitations

- **Stateless.** No DB/volume — the key is client-supplied and forwarded; restart-safe, horizontally scalable.
- **Workers target = Paid plan** (Free is capped at 50 subrequests / 10ms CPU). Docker/Node has no such caps.
- **Quota/balance**: MuleRouter exposes no balance API; check the [console](https://www.mulerouter.ai/app).
- Image edits are currently routed to gpt-image-2 only. CORS is enabled (`*`) with preflight support.
