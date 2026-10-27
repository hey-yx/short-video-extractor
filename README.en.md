<div align="center">

<img src="assets/cover.png" alt="short-video-extractor cover" width="840" />

# short-video-extractor

**[简体中文](README.md) | [English](README.en.md)**

*Short-video parsing API: paste a share link, get watermark-free video / photo-album direct links.*

[![CI](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml/badge.svg)](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml)
[![Bun](https://img.shields.io/badge/Bun-1.2%2B-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)

[Quick Start](#quick-start) • [Architecture](#architecture) • [Platform Status](#platform-status) • [API](#api) • [Observability](#observability) • [Local Development](#local-development) • [Environment Variables](#environment-variables) • [Deployment](#deployment) • [CI](#ci) • [Design Documents](#design-documents)

</div>

> [!WARNING]
> This project is being refactored: APIs and behavior may change at any time. Check the latest implementation before integrating.

Short-video parsing API: give it a share link, get watermark-free video / photo-album direct links back. v2.1 supports 9 platforms: Douyin, Xiaohongshu (RedNote), Kuaishou, Bilibili, Weibo, X/Twitter, YouTube, Instagram Reels and TikTok. The default response is direct links (the client downloads without a Referer header), so the server carries zero bandwidth; the `/media` relay is an optional add-on.

- One unified JSON envelope for all 9 platforms, direct links with no watermark
- Pure HTTP primary channels, zero browser dependency by default; browser fallback kicks in on risk control
- Caching, rate limiting, structured logs and Prometheus metrics out of the box
- One-command Docker deployment, image from 495MB

> [!NOTE]
> This project only resolves links: it takes a share link and returns direct-link addresses, storing or re-hosting nothing. Only parse content you have the right to access (your own works or licensed material); you are responsible for how you use it. Platform names and trademarks belong to their respective owners.

## Quick Start

Prerequisite: [Bun](https://bun.sh) 1.2+.

```bash
git clone https://github.com/hey-yx/short-video-extractor.git
cd short-video-extractor
bun install
bun dev          # start the dev server, port 7777 by default
```

Point it at any share link:

```bash
curl -X POST http://127.0.0.1:7777/parse \
  -H 'Content-Type: application/json' \
  -d '{"url": "<share link>"}'
```

You get the unified envelope (see [API](#api)); `data.assets[].url` is the watermark-free direct link, ready to download (without a Referer). No local setup? Run `docker compose up -d` instead, see [Deployment](#deployment).

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
│   ├── douyin/  xhs/  kuaishou/  bilibili/  weibo/  twitter/  youtube/  instagram/  tiktok/
│   └── registry.ts  hosts.ts
├── core/                     # error codes, unified envelope, URL utilities
├── infra/                    # pino logging, metrics, Puppeteer browser gateway
└── types/platform.ts         # unified data model (MediaAsset / ParseResult / FetchCtx)
```

Three hard rules for the platform layer: `platforms/**` never imports Elysia, never reads env, never calls console.log; `parse()` is a pure function (same input, same output) covered by fixture-based offline regression tests; IO goes only through `fetch()` and the injected `FetchCtx`. When a platform changes its pages/APIs, the symptom is "the unit test goes red first", not silently empty results in production.

Tech stack: Bun + Elysia. The only runtime dependencies are elysia, @elysiajs/cors, lru-cache, pino, and puppeteer (needed only on the browser-fallback paths: the Douyin risk-control downgrade and the Xiaohongshu fallback; the pure HTTP primary channels have zero browser dependency).

## Stability

- **Douyin dual channel**: pure HTTP by default (the L1 signature-free detail API). Once it returns 403 `ArgusSecurityPlugin` (L1 risk-controlled), the service automatically downgrades to the browser: it opens the video page and intercepts the `/aweme/v1/web/aweme/detail/` XHR that the page itself issues from the response stream; the `via` field honestly reports `browser`. Downgrade counts land in `channel_downgrade_total`.
- **Transient retries**: `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR` (network-layer and upstream 5xx) are retried once at the orchestration layer with exponential backoff (500ms→1s), bounded by the 15s request ceiling. `RISK_CONTROL`, content errors and input errors are never retried (retrying risk control means more risk control). Counts land in `parse_retry_total`.
- **Browser concurrency gate**: all browser channels share one semaphore, at most 2 concurrent pages, the rest queue, and queueing aborts immediately when the request is cancelled (AbortSignal), so concurrency cannot exhaust memory (roughly 30-110 MB per Chrome page).
- **Honest risk-control classification**: Xiaohongshu error pages such as `error_code=300012` (IP at risk) map to `RISK_CONTROL` (503, human-readable message) instead of posing as an upstream redesign.

## Platform Status

All 9 platforms produce the same unified `ParseResult` envelope. Channels and capabilities follow each adapter's `capabilities` declaration plus the measured notes under `docs/research/`:

| Platform | Channel | Content | Quality tiers | Direct link IP-bound |
|---|---|---|---|---|
| Douyin | HTTP primary (signature-free detail API + play direct links); auto-downgrades to the browser (intercepting the detail XHR) when L1 is risk-controlled | Video, photo albums, live photos | Four tiers 540p/720p/1080p/original (plus a 720p watermarked tier) | No (play links download with an empty Referer) |
| Xiaohongshu (RedNote) | Pure HTTP primary (admitted by the three-header combo, see below) + automatic browser fallback on risk control / login walls | Note videos, album images | Video serves the master stream (h264 preferred); images at original size | No |
| Kuaishou | Pure HTTP (short-link 302 for the photoId + mobile share page INIT_STATE, zero cookies) | Video, albums | All resolutions the server returns (sorted by height, top tier as the main URL) | No |
| Bilibili | Pure HTTP (view + playurl try_look=1) | Video (each part becomes an asset), DASH audio/video split | 360P-4K mapped from DASH ids (120=4K, 116=1080P60, 80=1080P…) | No |
| Weibo | Pure HTTP (anonymous statuses/show JSON; video direct-page fid exchanged for a mid; t.cn short links expanded via 302) | Video, albums | 1080P/720P/480P as served (the component tier list is richer than show) | No |
| X/Twitter | Pure HTTP (cdn.syndication.twimg.com/tweet-result, token=0, signature-free) | Single-tweet video, GIF, albums | mp4 tiers by bitrate + HLS fallback | No (twimg direct links don't check the egress IP) |
| YouTube / Shorts | Pure API (innertube /player, automatic ANDROID_VR→IOS client fallback, no PO Token, no cookies) | Video, Shorts | 144p-2160p as returned by the source (ANDROID_VR reaches 4K), DASH audio/video split plus merged tiers | **Yes** (googlevideo direct links are bound to the resolving egress IP, ~6h expiry; download via the `/media` server relay, whose egress must match the resolver's) |
| Instagram Reels | Pure HTTP (anonymous GraphQL `doc_id` channel, no login/cookies; requires `IG_GRAPHQL_DOC_ID`) | Reels, post and IGTV videos, photo albums | mp4 as returned | No (fbcdn links carry no ip= binding) |
| TikTok | Pure HTTP (tikwm public API: watermark-free links, albums, music; parsing goes through the egress proxy) | Video, albums, music | Watermark-free play/hdplay tiers | No (tiktokcdn links are not IP-bound) |

Proxying: domestic platforms connect directly and never use a proxy; overseas platforms (YouTube etc.) go through the `PROXY_<PLATFORM>` / `OUTBOUND_PROXY` / `HTTPS_PROXY` egress proxy (see [Environment Variables](#environment-variables)).

## API

All JSON responses use one unified envelope:

```json
{ "success": true, "data": { ... } }
{ "success": false, "data": null, "error": { "code": "RISK_CONTROL", "message": "..." } }
```

### POST /parse (or GET /parse?url=)

The main endpoint. `Content-Type: application/json`, body `{"url": "<share link>"}`. Share short links are supported (v.douyin.com, xhslink.com, v.kuaishou.com, b23.tv, t.co, youtu.be, etc., expanded automatically).

`data` (ParseResult) core fields:

| Field | Description |
|---|---|
| `platform` / `id` / `kind` | Platform, platform-native id, `video` \| `album` |
| `title` / `description` / `tags` / `author` | Metadata |
| `assets[]` | Resource list, see below |
| `expiresAt` | Earliest expiry among all direct links (Unix seconds), the basis for caching and re-fetching |
| `via` | Parsing channel: `http` or `browser` (fetch semantics, uniform across platforms) |

`assets[]` (MediaAsset): `type` (video/image/audio/cover), `url` (**direct link**: request it without a Referer header; YouTube is the exception: googlevideo links are bound to the resolving egress IP and must be downloaded through the `/media` server relay), `variants[]` (other qualities of the same asset; Douyin returns all four tiers), `width` / `height` / `durationMs` / `size`, `backups[]` (backup CDNs), `liveClipUrl` (the 5s video of a live photo). Bilibili and YouTube video assets additionally carry `audioUrl` (the DASH audio track, fetch it separately and mux it with the video).

Error codes and HTTP status: `INVALID_URL`(400), `UNSUPPORTED_PLATFORM`(422), `CONTENT_NOT_FOUND`(404), `CONTENT_RESTRICTED`(403), `RISK_CONTROL`(503), `UPSTREAM_ERROR` / `UPSTREAM_CHANGED`(502), `UPSTREAM_TIMEOUT`(504), `RATE_LIMITED`(429), `MEDIA_*` (see below), `INTERNAL`(500).

### GET /media?u=&exp=&sig= (optional, off by default)

Streaming relay with three uses: forcing a download filename (Content-Disposition), covering containers that force a Referer (WeChat's built-in browser and the like), and transparent re-fetching after a link expires.

If you call `/parse`, you don't need this endpoint: direct links work as-is with no configuration. It only serves two cases: YouTube links are IP-bound and must go through the server relay (see [Platform Status](#platform-status)), and self-hosters who want any of the three enhancements above.

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
| `channel_downgrade_total{platform,from,to}` | counter | Automatic channel downgrades (Douyin / Xiaohongshu http→browser) |
| `parse_retry_total{platform}` | counter | Transient-error (timeout / 5xx) retry count |

## Observability

- **Structured logs**: pino, one JSON line per request. Every request generates/propagates `x-request-id` (echoed in the response header, log field `reqId`); access logs carry method, path, status and duration; platform parse events additionally carry platform / id / duration.
- **Secret scrubbing**: all log output goes through deep redaction: URL query values are masked wholesale (so credentials like `xsec_token` never reach the logs), inline links in message text get the same treatment, and Error instances plus detail fields are redacted recursively. Parameter names are kept; values become `REDACTED`.
- Log level is controlled by `LOG_LEVEL` (default `info`).

## Local Development

```bash
bun install
bun dev          # dev (--watch), default port 7777
bun test         # unit tests (fully offline, fixture-based)
bun run test:status  # one command for the full state: prettier / tsc / tests / coverage / CI
bun run typecheck
```

`docs/status.html` is a zero-dependency status page: overall banner, service health, per-platform status, usage counters and a live parse demo on one page. Open it straight from disk (file://, then fill in the service address); after deploying, visit `http://<server>:7777/status` in a browser.

> [!TIP]
> The browser-fallback paths (Douyin risk-control downgrade, Xiaohongshu fallback) need Chrome on the machine (Puppeteer manages it automatically); the pure HTTP channels have no such requirement.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 7777 | Listen port |
| `LOG_LEVEL` | info | fatal/error/warn/info/debug/trace |
| `PROXY_SECRET` | unset | Signing secret for the /media relay; unset → /media returns 501 |
| `PUPPETEER_EXECUTABLE_PATH` | - | Pinned to `/usr/bin/chromium` inside the container (set in the Dockerfile) |
| `PROXY_<PLATFORM>` | unset | Per-platform egress proxy (e.g. `PROXY_YOUTUBE`); highest priority |
| `OUTBOUND_PROXY` | unset | Default egress proxy for overseas platforms (used when `PROXY_<PLATFORM>` is unset) |
| `HTTPS_PROXY` | unset | Egress-proxy fallback (used when neither of the above is set). Resolution order: `PROXY_<PLATFORM>` → `OUTBOUND_PROXY` → `HTTPS_PROXY`; domestic platforms are unaffected (the proxy is injected only into overseas platforms' fetches and the matching `/media` relay) |

See `.env.example`. The production `.env` stays on the server (chmod 600), never in the repo.

## Deployment

### Image

Multi-stage build: `oven/bun:alpine` compiles a single binary → `alpine:3.22` + chromium runtime (the browser-fallback paths need a real browser engine). Runs as non-root (uid 10001), tini reaps zombies, HEALTHCHECK hits /health. Measured size: **495MB** on arm64, **527MB** on amd64 (from an initial 830MB); the full slimming breakdown, the post-build acceptance checklist and the apk mirror switch live in `docs/image-build-notes.md`. The apk source defaults to the Aliyun mirror (the official source measured at just 14KB/s); to use the official one: `docker build --build-arg ALPINE_MIRROR=dl-cdn.alpinelinux.org .`

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

Rebuild the image, then `docker compose up -d`. Verify `/health`, `/ready` and one real link per platform; rollback is just running the previous image tag. Run `docker image prune` occasionally to clear build cache.

### Status Page

The service ships its own status page: open `http://<server>:7777/status` in a browser to see whether the service is up, per-platform status, parse success/failure counters and recent platform-side failures, auto-refreshed every 10 seconds (toggleable). The same page works from disk over file:// (enter the service address manually). The page is embedded in the service binary: no extra dependencies, no monitoring stack.

## CI

The repo uses GitHub Actions for continuous integration: on every push to main and every PR, GitHub spins up a clean environment and runs `bun run typecheck` plus the full test suite; the CI badge at the top of this README shows the result (green = passing). The workflow lives at `.github/workflows/test.yml`, with `PUPPETEER_SKIP_DOWNLOAD: "true"` so CI never downloads a browser.

## Design Documents

- `docs/research/`: platform API research and measured notes (01 Douyin/TikTok API, 02 domestic platforms, 03 architecture, 04 Xiaohongshu HTTP channel, 05 overseas platforms and the egress proxy)
- `docs/image-build-notes.md`: image slimming breakdown and build acceptance checklist
