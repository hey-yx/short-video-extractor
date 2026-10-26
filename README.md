<div align="center">

<img src="assets/cover.png" alt="short-video-extractor — short-video parsing API" width="840" />

# short-video-extractor

**[English](README.md) | [简体中文](README.zh-CN.md)**

*Short-video parsing API — paste a share link, get watermark-free video / photo-album direct links.*

[![CI](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml/badge.svg)](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml)
[![Bun](https://img.shields.io/badge/Bun-1.2%2B-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)

[Architecture](#architecture) • [Platform Status](#platform-status) • [API](#api) • [Observability](#observability) • [Local Development](#local-development) • [Environment Variables](#environment-variables) • [Deployment](#deployment) • [CI](#ci) • [Design Documents](#design-documents)

</div>

A short-video parsing API: give it a share link, get watermark-free video / photo-album direct links back. v2 is a full rewrite (2026-10, no contract relation with the legacy version — `/pv` and `/public/*` are gone), supporting Douyin, Xiaohongshu, Kuaishou and Bilibili. The default response is direct links (the client downloads without a Referer header), so the server carries zero bandwidth; the `/media` relay is an optional add-on.

## Architecture

Request flow: **match (identify the platform) → cache → dispatch (short-link expansion) → fetch (platform adapters) → parse (pure function) → unified envelope response**.

```
src/
├── index.ts                  # entry
├── bootstrap/{app,server}.ts # createApp() (callable directly from tests), listen + graceful shutdown
├── routes/
│   ├── parse.routes.ts       # POST|GET /parse (rate limit, cache, metrics)
│   ├── media.routes.ts       # GET|HEAD /media (optional streaming relay)
│   └── ops.routes.ts         # /health /ready /platforms /metrics
├── services/
│   ├── parse.service.ts      # orchestration: match → cache → dispatch → fetch → parse
│   ├── cache.ts              # LRU + expiresAt semantics + negative cache + singleflight
│   ├── limiter.ts            # per-IP token bucket rate limiter
│   └── media-proxy.ts        # HMAC signing + SSRF allowlist + manual 302 follow + Range passthrough
├── platforms/                # plugin-style platform layer: adding a platform = add a directory + one registration line in app.ts
│   ├── douyin/  xhs/  kuaishou/  bilibili/
│   └── registry.ts  hosts.ts
├── core/                     # error codes, unified envelope, URL utilities
├── infra/                    # pino logging, metrics, Puppeteer browser gateway
└── types/platform.ts         # unified data model (MediaAsset / ParseResult / FetchCtx)
```

Three hard rules for the platform layer: `platforms/**` never imports Elysia, never reads env, never calls console.log; `parse()` is a pure function (same input, same output) covered by fixture-based offline regression tests; IO goes only through `fetch()` and the injected `FetchCtx`. When a platform changes its pages/APIs, the symptom is "the unit test goes red first" — not silently empty results in production.

Tech stack: Bun + Elysia. The only runtime dependencies are elysia, @elysiajs/cors, lru-cache, pino, and puppeteer (the primary channel for Xiaohongshu, the risk-control fallback for Douyin).

## Stability

- **Douyin dual channel**: pure HTTP by default (the L1 signature-free detail API). Once it returns 403 `ArgusSecurityPlugin` (L1 risk-controlled), the service automatically downgrades to the browser — it opens the video page and intercepts the `/aweme/v1/web/aweme/detail/` XHR that the page itself issues from the response stream; the `via` field honestly reports `browser`. Downgrade counts land in `channel_downgrade_total`.
- **Transient retries**: `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR` (network-layer and upstream 5xx) are retried once at the orchestration layer with exponential backoff (500ms→1s), bounded by the 15s request ceiling. `RISK_CONTROL`, content errors and input errors are never retried (retrying risk control means more risk control). Counts land in `parse_retry_total`.
- **Browser concurrency gate**: all browser channels share one semaphore — at most 2 concurrent pages, the rest queue, and queueing aborts immediately when the request is cancelled (AbortSignal) — so concurrency cannot exhaust memory (roughly 30–110 MB per Chrome page).
- **Honest risk-control classification**: Xiaohongshu error pages such as `error_code=300012` (IP at risk) map to `RISK_CONTROL` (503, human-readable message) instead of posing as an upstream redesign.

## Platform Status

| Platform | Channel | Content | Browser |
|---|---|---|---|
| Douyin | HTTP first (detail API + play direct links); auto-downgrades to the browser (intercepting the detail XHR) when the L1 endpoint is risk-controlled | Video (four tiers: 540p/720p/1080p/original), photo albums, live photos | Fallback (automatic on risk control) |
| Xiaohongshu | Browser fetches the main document HTML → `__INITIAL_STATE__` | Note images, video | Required (TLS-fingerprint allowlist) |
| Kuaishou | Pure HTTP (short-link 302 + share page INIT_STATE) | Video, multiple qualities | No |
| Bilibili | Pure HTTP (view + playurl try_look) | Video, multi-part, DASH audio/video split | No |

At runtime `GET /platforms` is the source of truth (platforms self-describe).

## API

All JSON responses use one unified envelope:

```json
{ "success": true, "data": { ... } }
{ "success": false, "data": null, "error": { "code": "RISK_CONTROL", "message": "..." } }
```

### POST /parse (or GET /parse?url=)

The main endpoint. `Content-Type: application/json`, body `{"url": "<share link>"}`. Share short links are supported (v.douyin.com, xhslink.com, v.kuaishou.com, b23.tv, … — expanded automatically).

`data` (ParseResult) core fields:

| Field | Description |
|---|---|
| `platform` / `id` / `kind` | Platform, platform-native id, `video` \| `album` |
| `title` / `description` / `tags` / `author` | Metadata |
| `assets[]` | Resource list, see below |
| `expiresAt` | Earliest expiry among all direct links (Unix seconds) — the basis for caching and re-fetching |
| `via` | Parsing channel: `http` or `browser` |

`assets[]` (MediaAsset): `type` (video/image/audio/cover), `url` (**direct link** — request it without a Referer header), `variants[]` (other qualities of the same asset; Douyin returns all four tiers), `width` / `height` / `durationMs` / `size`, `backups[]` (backup CDNs), `liveClipUrl` (the 5s video of a live photo). Bilibili video assets additionally carry `audioUrl` (the DASH audio track — fetch it separately and mux it with the video).

Error codes and HTTP status: `INVALID_URL`(400), `UNSUPPORTED_PLATFORM`(422), `CONTENT_NOT_FOUND`(404), `CONTENT_RESTRICTED`(403), `RISK_CONTROL`(503), `UPSTREAM_ERROR` / `UPSTREAM_CHANGED`(502), `UPSTREAM_TIMEOUT`(504), `RATE_LIMITED`(429), `MEDIA_*` (see below), `INTERNAL`(500).

### GET /media?u=&exp=&sig= (optional, off by default)

Streaming relay with three uses: forcing a download filename (Content-Disposition), covering containers that force a Referer (WeChat's built-in browser and the like), and transparent re-fetching after a link expires.

> [!NOTE]
> Set `PROXY_SECRET` to enable (without it the endpoint returns 501; the direct-link main path is unaffected).

- `sig` = first 32 hex chars of HMAC-SHA256(`PROXY_SECRET`, `"<url>\n<exp>"`), valid for 600 seconds; expired → 410, tampered → 403.
- Upstream domain allowlist (platform share domains + CDN domains), re-validated on every 302 hop (SSRF protection); concurrency capped at 2; Range / HEAD supported.

### GET /health

Liveness probe: 200 `{"status":"ok","uptime":...}` as long as the process is alive, without touching external dependencies (so external blips can't trigger a restart storm). Docker HEALTHCHECK hits this.

### GET /ready

Readiness probe: 200 only when all platform adapters are registered, 503 otherwise.

### GET /platforms

Registered platforms, self-described (name, description, recognized domains, capability declarations).

### GET /metrics

Prometheus text format (hand-rolled renderer, no prom-client):

| Metric | Type | Description |
|---|---|---|
| `parse_total{platform,code}` | counter | Parse count; code is `ok` or a business error code |
| `parse_duration_ms` | histogram | Parse latency distribution (milliseconds, by platform) |
| `cache_hit_total` | counter | Cache hit count |
| `upstream_error_total{platform,reason}` | counter | Upstream failure / risk-control count |
| `channel_downgrade_total{platform,from,to}` | counter | Automatic channel downgrades (e.g. Douyin http→browser) |
| `parse_retry_total{platform}` | counter | Transient-error (timeout / 5xx) retry count |

## Observability

- **Structured logs**: pino, one JSON line per request. Every request generates/propagates `x-request-id` (echoed in the response header, log field `reqId`); access logs carry method, path, status and duration; platform parse events additionally carry platform / id / duration.
- **Secret scrubbing**: all log output goes through deep redaction — URL query values are masked wholesale (so credentials like `xsec_token` never reach the logs), inline links in message text get the same treatment, and Error instances plus detail fields are redacted recursively. Parameter names are kept; values become `REDACTED`.
- Log level is controlled by `LOG_LEVEL` (default `info`).

## Local Development

```bash
bun install
bun dev          # dev (--watch), default port 7777
bun test         # unit tests (fully offline, fixture-based)
bun run test:status  # one command for the full state: prettier / tsc / tests / coverage / CI
bun run typecheck
```

> [!TIP]
> The Xiaohongshu channel needs Chrome on the machine (Puppeteer manages it automatically); every other platform is pure HTTP.

`docs/status.html` is a zero-dependency status page — an overall banner, service health, per-platform status, usage counters and a live parse demo on one page. Open it straight from disk (file://, then fill in the service address), or after deploying visit `http://<server>:7777/status` in a browser — nothing extra to run.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 7777 | Listen port |
| `LOG_LEVEL` | info | fatal/error/warn/info/debug/trace |
| `PROXY_SECRET` | unset | Signing secret for the /media relay; unset → /media returns 501 |
| `PUPPETEER_EXECUTABLE_PATH` | — | Pinned to `/usr/bin/chromium` inside the container (set in the Dockerfile) |

See `.env.example`. The production `.env` stays on the server (chmod 600), never in the repo.

## Deployment

### Image

Multi-stage build: `oven/bun:alpine` compiles a single binary → `alpine:3.22` + chromium runtime (the Xiaohongshu channel needs a real browser engine). Runs as non-root (uid 10001), tini reaps zombies, HEALTHCHECK hits /health.

Measured size (built locally 2026-10-25): **830MB → 495MB** (-335MB, -40%), meeting the <700MB goal. Layer breakdown: alpine base 8.5MB + runtime layer 386MB (721MB before slimming) + bun single binary 100MB.

Slimming here means "delete the files headless parsing never needs, in the same layer that installs them", and each deletion was kept only after real Xiaohongshu links still parsed inside the container (video + album, browser channel actually running):

| Removed | Size | Rationale |
|---|---|---|
| mesa/LLVM software-rendering stack (libLLVM, libgallium, gallium-pipe drivers) | 247MB | No GPU in headless; not in chromium's dynamic dependency closure |
| System ICU data + libicu | 30MB | chromium ships its own ICU and never reads the system data |
| mime libraries, icon themes, gtk data, typelib, pci.ids, pipewire plugins etc. | 38MB | Data files headless parsing never touches |
| ANGLE/SwiftShader (libEGL / libGLESv2 / libvulkan) | 7MB | Xiaohongshu browser channel unchanged after removal |
| locales (kept zh-CN / en-US), extra font weights, 2x UI assets | 4MB | |

What could not be cut: chromium itself at 233MB, plus the ffmpeg family it hard-depends on (x265 / aom / SvtAv1Enc and friends at ~40MB are chromium dynamic dependencies — delete them and the binary won't start), nss / freetype / harfbuzz / fontconfig, ca-certificates; the bun single binary at 100MB is left as is (--minify is already on).

The apk mirror defaults to Aliyun (measured during the build: `dl-cdn.alpinelinux.org` crawled at 14KB/s vs Aliyun at 1.4MB/s). To use the official mirror: `docker build --build-arg ALPINE_MIRROR=dl-cdn.alpinelinux.org .`

Post-build acceptance: `/health` 200 inside the container, `/ready` reports 4 platforms, real Xiaohongshu links (video + album) and real Douyin links parse successfully, `bun test` all green (100), `tsc --noEmit` zero errors.

```bash
docker build -t short-video-extractor:v2 .
docker run -d --name short-video-extractor -p 7777:7777 \
  --env-file .env --memory 800m --restart unless-stopped short-video-extractor:v2
curl http://127.0.0.1:7777/health
```

Or just compose (`7777:7777`, `restart: unless-stopped`, `mem_limit 800m`, `env_file: .env`, log rotation 10m×3):

```bash
docker compose up -d
```

### Upgrading

Rebuild the image, then `docker compose up -d`. Verify `/health`, `/ready` and one real link per platform — rollback is just running the previous image tag. Run `docker image prune` occasionally to clear build cache.

### Status Page

The service ships its own status page: open `http://<server>:7777/status` in a browser to see whether the service is up, per-platform status, parse success/failure counters and recent platform-side failures — auto-refreshed every 10 seconds (toggleable). The same page works from disk over file:// (enter the service address manually). The page is embedded in the service binary: no extra dependencies, no monitoring stack.

## CI

`.github/workflows/test.yml`: on push (main) and PRs it runs `bun run typecheck` + `bun test`, with `PUPPETEER_SKIP_DOWNLOAD: "true"` so CI never downloads a browser.

## Design Documents

- `docs/research/` — platform API research and measured notes
