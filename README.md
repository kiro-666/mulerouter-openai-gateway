# mulerouter-openai-gateway

A Cloudflare Worker that exposes [MuleRouter's `gpt-image-2`](https://www.mulerouter.ai/models/gpt-image-2) as a **standard OpenAI Images API**.

MuleRouter uses an **async task API** (submit a task → poll until done). This gateway hides that behind the synchronous OpenAI endpoints, so any OpenAI client can call it directly. The MuleRouter API key is supplied by the **client** in the `Authorization` header — the Worker stores no secrets.

## Endpoints

| OpenAI endpoint | Maps to |
| --- | --- |
| `POST /v1/images/generations` | MuleRouter `/generation` |
| `POST /v1/images/edits` | MuleRouter `/edit` |
| `GET /health` | health check |

## Deploy

The same core (`src/core.js`) has two entry points — pick one.

```
src/core.js     # runtime-agnostic logic (Web-standard APIs only)
src/worker.js   # Cloudflare Workers entry
src/server.js   # Node.js native-http entry (Docker / bare metal)
```

### Option A — Docker / Node  (no plan limits)

No dependencies, no install step:

```bash
# Docker (recommended)
docker compose up -d --build
# or: docker build -t gateway . && docker run -p 8787:8787 gateway
# or pull the CI-published image from GHCR (no local build needed):
docker run -d -p 8787:8787 --name gateway \
  -e POLL_MAX_ATTEMPTS=60 \
  ghcr.io/<your-github-username>/mulerouter-openai-gateway:latest

# Plain Node (>= 18)
node src/server.js          # or: npm start
```

Defaults to `http://0.0.0.0:8787`. Configure with env vars (`HOST`, `PORT`,
`MULEROUTER_BASE_URL`, `POLL_INTERVAL_MS`, `POLL_MAX_ATTEMPTS`) — set them in
`docker-compose.yml` or the shell. For HTTPS, put it behind Caddy/nginx/Traefik.

### Option B — Cloudflare Workers

```bash
npm install
npx wrangler deploy
```

Then point any OpenAI client at the deployed URL, using your **MuleRouter key** as the API key.

## Usage

### Text-to-image (curl)

```bash
curl https://<your-worker>.workers.dev/v1/images/generations \
  -H "Authorization: Bearer $MULEROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "a red panda astronaut, studio lighting",
    "size": "1024x1024",
    "n": 1,
    "quality": "high"
  }'
```

### Image edit (multipart, like OpenAI)

```bash
curl https://<your-worker>.workers.dev/v1/images/edits \
  -H "Authorization: Bearer $MULEROUTER_KEY" \
  -F image=@input.png \
  -F 'prompt=replace the background with a beach' \
  -F mask=@mask.png
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-worker>.workers.dev/v1",
    api_key="<MULEROUTER_KEY>",   # client-provided, forwarded upstream
)

# generate
img = client.images.generate(model="gpt-image-1", prompt="a corgi", size="1024x1024")

# edit
with open("input.png", "rb") as f:
    img = client.images.edit(model="gpt-image-1", image=f, prompt="add a hat")
```

## Parameter mapping

| OpenAI (generations) | → MuleRouter |
| --- | --- |
| `prompt` | `prompt` |
| `n` | `n` |
| `size` | `size` (`auto` supported, up to 4K) |
| `quality` | `quality` (`high`/`medium`/`low`/`auto`) |
| `response_format` | shapes the response (`url` or `b64_json`) |
| `model` | ignored (always routes to `gpt-image-2`) |

| OpenAI (edits) | → MuleRouter |
| --- | --- |
| `prompt` | `prompt` |
| `image` / `images` | `images` (files → base64; URLs/base64 pass through) |
| `mask` | `mask` (file → base64; URL/base64 pass through) |
| `n`, `size` | `n`, `size` |

The response is reshaped to OpenAI form: `{ "created": <ts>, "data": [ { "url" } | { "b64_json" } ] }`.
The upstream task id is echoed back in the `X-Upstream-Task-Id` response header.

## Configuration (env vars)

Defined in `wrangler.jsonc` under `vars`:

| Var | Default | Meaning |
| --- | --- | --- |
| `MULEROUTER_BASE_URL` | `…/vendors/openai/v1/gpt-image-2` | Upstream base path |
| `POLL_INTERVAL_MS` | `3000` | Delay between poll calls |
| `POLL_MAX_ATTEMPTS` | `40` | Max poll rounds (40 × 3s = 120s) |

## Notes & limitations

- **Workers target = use the Paid plan.** Each request is 1 submit + N polls. Workers Free is capped at **50 subrequests** and **10ms CPU**, which polling + base64 encoding will exceed; Paid allows 10,000 subrequests and 30s CPU (`limits.cpu_ms` is set). **The Docker/Node target has none of these caps** — that's the main reason to self-host.
- **`response_format`:** if you request `b64_json` but the upstream returns a URL, the Worker fetches and re-encodes it (one extra subrequest per image). Requesting `url` when only base64 is available returns a `data:` URI.
- **CORS** is enabled (`*`) with `OPTIONS` preflight support, so browser clients work out of the box.
- The Worker is stateless and stores no keys — the client's key is forwarded per request.
