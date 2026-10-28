<div align="center">

<img src="assets/cover.png" alt="short-video-extractor 封面" width="840" />

# short-video-extractor

**[简体中文](README.md) | [English](README.en.md)**

*短视频解析 API：给一条分享链接，返回无水印视频 / 图集直链。*

[![CI](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml/badge.svg)](https://github.com/hey-yx/short-video-extractor/actions/workflows/test.yml)
[![Coverage](https://img.shields.io/coveralls/github/hey-yx/short-video-extractor/main?style=flat-square&label=Coverage)](https://coveralls.io/github/hey-yx/short-video-extractor)
[![Bun](https://img.shields.io/badge/Bun-1.2%2B-000000?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)

[快速开始](#快速开始) • [架构](#架构) • [平台状态](#平台状态) • [API](#api) • [可观测性](#可观测性) • [本地开发](#本地开发) • [环境变量](#环境变量) • [部署](#部署) • [CI](#ci) • [设计文档](#设计文档)

</div>

> [!WARNING]
> 该项目正在重构整改，接口与行为可能随时调整，接入前请先确认最新实现。

短视频解析 API：给一条分享链接，返回无水印视频 / 图集直链。v2.1 现支持 9 个平台：抖音、小红书、快手、B 站、微博、X/Twitter、YouTube、Instagram Reels、TikTok。默认返回直链（客户端请求时不带 Referer 即可下载），服务器零带宽；`/media` 中转作为可选增强。

- 9 个平台统一 JSON 信封，直链无水印
- 纯 HTTP 主通道，默认零浏览器依赖；风控自动降级浏览器兜底
- 缓存、限流、结构化日志、Prometheus 指标开箱即用
- 一条命令 Docker 部署，镜像 495MB 起

> [!NOTE]
> 本项目只做链接解析：收一条分享链接，返回直链地址，不存储、不转存任何内容。请仅解析自己有权访问的内容（自己的作品或已获授权的素材），使用行为由使用者自行负责。文中平台名称与商标归其各自所有者。

## 快速开始

前置：装好 [Bun](https://bun.sh)（1.2+）。

```bash
git clone https://github.com/hey-yx/short-video-extractor.git
cd short-video-extractor
bun install
bun dev          # 启动开发服务，默认端口 7777
curl http://127.0.0.1:7777/health   # 服务起来了会返回 {"status":"ok",...}
```

拿一条分享链接就能解析：

```bash
curl -X POST http://127.0.0.1:7777/parse \
  -H 'Content-Type: application/json' \
  -d '{"url": "<分享链接>"}'
```

返回统一信封（见 [API](#api)），`data.assets[].url` 就是无水印直链，直接下载即可（不带 Referer）。不想装环境可以直接 `docker compose up -d`，见[部署](#部署)。

更多场景（选清晰度、图集、YouTube 中转、错误码处置、限流）见 [`docs/调用案例.md`](docs/调用案例.md)。

## 架构

请求流程：**match（识别平台）→ 缓存 → dispatch（短链展开）→ fetch（平台适配层）→ parse（纯函数）→ 统一信封返回**。

```
src/
├── index.ts                  # 入口
├── bootstrap/{app,server}.ts # createApp()（测试可直接调）、监听与优雅关闭
├── routes/
│   ├── parse.routes.ts       # POST|GET /parse（限流、缓存、指标打点）
│   ├── media.routes.ts       # GET|HEAD /media（可选流式中转）
│   ├── ops.routes.ts         # /health /ready /platforms /metrics
│   └── status.routes.ts      # /status 检测站页面（构建期内嵌进二进制）
├── services/
│   ├── parse.service.ts      # 编排：match → 缓存 → dispatch → fetch → parse
│   ├── cache.ts              # LRU + expiresAt 语义 + 负缓存 + singleflight
│   ├── limiter.ts            # 按 IP 令牌桶限流
│   └── media-proxy.ts        # HMAC 签名 + SSRF 白名单 + 手动跟 302 + Range 透传
├── platforms/                # 插件式平台层：加平台 = 加目录 + app.ts 注册一行
│   ├── douyin/  xhs/  kuaishou/  bilibili/  weibo/  twitter/  youtube/  instagram/  tiktok/
│   └── registry.ts  hosts.ts
├── core/                     # 错误码、统一信封、URL 工具
├── infra/                    # pino 日志、指标、Puppeteer 浏览器网关
└── types/platform.ts         # 统一数据模型（MediaAsset / ParseResult / FetchCtx）
```

平台层三条硬约束：`platforms/**` 不 import Elysia、不读 env、不 console.log；`parse()` 是纯函数（同输入同输出），用 fixture 离线回归；IO 只经 `fetch()` 和注入的 `FetchCtx`。平台改版时表现是「单测先红」，不是线上悄悄返回空结果。

技术栈：Bun + Elysia。运行时依赖只有 elysia、@elysiajs/cors、lru-cache、pino、puppeteer（仅浏览器兜底路径需要：抖音风控降级、小红书降级兜底；纯 HTTP 主通道零浏览器依赖）。

## 稳定性

- **抖音三级降级链（L1 → L2 → L3）**：默认纯 HTTP L1（零签名 detail 接口）；L1 被风控（403 `ArgusSecurityPlugin`）时先降级 L2 纯 HTTP 签名通道（标准指纹参数 + `uifid`/`timestamp`/`x-secsdk-web-signature` 签名 + `ttwid` cookie，身份由身份池自动铸造，也可用 `DOUYIN_UIFID` 固定；配方与实测见 `docs/research/01` §12），L2 也失效（403 / 200 空 body）才进 L3 浏览器兜底：打开作品页截页面自己发出的 detail XHR JSON。`via` 字段如实标注 `http` / `http-l2` / `browser`，降级计数见 `channel_downgrade_total`（from/to 按 `http-l1`→`http-l2`→`browser` 逐级标注）。L1 风控信号（`RISK_CONTROL`）与 L2 签名失效（`UPSTREAM_CHANGED`）在错误码与打点上分开，便于区分「口子被堵」和「签名过期要重铸 uifid」。
- **熔断粘性**：HTTP 通道连续 2 次命中风控后，该平台 60s 内固定走浏览器，不再每个请求先吃一次 403 再冷启动浏览器（省 1-3s 延迟，也不加重风控画像）；60s 探针窗口到点放一个请求回 HTTP 试探，试探成功即回到纯 HTTP。状态见 `channel_breaker_open{platform}` gauge。
- **uifid 身份池**：`DOUYIN_UIFID` 不配时自动铸造并池化复用访客身份（每个 uifid 就是一个「访客」）：签名失效怀疑身份用废先冷却重试一次、再废退休换新；铸造全局节流（最小间隔 60s、失败指数退避到 1h 上限），避免「一秒冒出多个新访客」本身成为风控信号。计数见 `uifid_mint_total`、`uifid_retired_total`。
- **风控止血**：无浏览器兜底可用（或 `BROWSER_FALLBACK=off`）时，最终风控会让该平台进入 45s 止血窗口：窗口内所有请求直接 503，不再全额撞上游（重试风控=加重风控）；缓存命中与负缓存不受窗口影响。有兜底时降级在 adapter 内部消化，不进窗口；开关切回 on 后窗口立即失效，恢复降级链。
- **纯 HTTP 部署开关**：`BROWSER_FALLBACK=off` 时不注入浏览器能力，风控如实 503；适合不想跑 Chrome 的部署（省 400-600 MB 常驻内存，puppeteer 依赖可移除）。
- **瞬态重试**：`UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR`（网络层与上游 5xx）在编排层重试 1 次，指数退避（500ms→1s），总耗时受请求 15s 上限约束；`RISK_CONTROL`、内容类与参数类错误一律不重试（重试风控=加重风控）。计数见 `parse_retry_total`。
- **浏览器并发闸**：所有浏览器通道共享一个信号量，最多 2 个并发 page，超出的排队，排队期间随请求取消（AbortSignal）立即退出，防止并发打满内存（Chrome 每页约 30-110 MB）。
- **风控如实分类**：小红书 `error_code=300012`（IP at risk）等错误页归 `RISK_CONTROL`（503，带可读文案），不冒充改版。笔记页 200 但只拿到壳页/笔记数据为空时不硬判改版：有浏览器就交浏览器验证（壳页与已删除只有浏览器分得清），无浏览器时按纯 HTTP 解析如实分类；网络层失败归一成 `UPSTREAM_TIMEOUT`，与其他平台共用同一套瞬态重试。

## 平台状态

9 个平台全部接入统一 `ParseResult` 信封；通道与能力以各 adapter 的 `capabilities` 声明 + `docs/research/` 实测记录为准：

| 平台 | 通道 | 支持内容 | 清晰度档位 | 直链绑 IP |
|---|---|---|---|---|
| 抖音 | 三级降级链：L1 零签名 detail 接口（主）→ L2 纯 HTTP 签名通道（有浏览器就自动铸身份，零配置启用；`DOUYIN_UIFID` 可固定身份）→ 浏览器截 detail XHR（兜底）；play 直链 | 视频、图集、实况照片 | 540p/720p/1080p/原片四档（另附 720p 水印档） | 否（play 直链空 Referer 可下） |
| 小红书 | 纯 HTTP 主通道（请求头三件套放行，见下）+ 风控/登录墙自动降级浏览器兜底 | 笔记视频、图集图片 | 视频出 master 流（h264 优先）；图片原图 | 否 |
| 快手 | 纯 HTTP（短链 302 取 photoId + 移动端分享页 INIT_STATE，零 cookie） | 视频、图集 | 服务端返回的全部分辨率（按高度排序，最高档为主 URL） | 否 |
| B 站 | 纯 HTTP（view + playurl try_look=1） | 视频（多 P 逐个出 asset）、DASH 音视频分离 | 360P-4K 按 DASH id 映射（120=4K、116=1080P60、80=1080P…） | 否 |
| 微博 | 纯 HTTP（statuses/show 匿名 JSON；视频直链页 fid 换 mid；t.cn 短链 302 展开） | 视频、图集 | 1080P/720P/480P 等服务端给的档位（component 档位比 show 全） | 否 |
| X/Twitter | 纯 HTTP（cdn.syndication.twimg.com/tweet-result，token=0 免签名） | 单条推文视频、GIF、图集 | mp4 按 bitrate 多档 + HLS 备选 | 否（twimg 直链不校验出口 IP） |
| YouTube / Shorts | 纯 API（innertube /player，ANDROID_VR→IOS 失败自动换 client，免 PO Token 免 cookie） | 视频、Shorts | 144p-2160p 按源返回（ANDROID_VR 可到 4K），DASH 音视频分离 + 合并档 | **是**（googlevideo 直链绑解析出口 IP，约 6h 过期，直链须经 `/media` 服务端中转，中转与解析走同一代理出口） |
| Instagram Reels | 纯 HTTP（匿名 GraphQL `doc_id` 口子，免登录免 cookie，需配 `IG_GRAPHQL_DOC_ID`） | Reels、Post、IGTV 视频、图文图集 | mp4 按源返回 | 否（fbcdn 直链无 ip= 绑定） |
| TikTok | 纯 HTTP（tikwm 公开接口：无水印直链/图集/音乐；解析出站走代理） | 视频、图集、音乐 | 无水印 play/hdplay 双档 | 否（tiktokcdn 直链不绑 IP） |

代理：国内平台直连不走代理；海外平台（YouTube 等）经 `PROXY_<PLATFORM>` / `HTTPS_PROXY` 出站代理（见[环境变量](#环境变量)）。

## API

所有 JSON 响应走统一信封：

```json
{ "success": true, "data": { ... } }
{ "success": false, "data": null, "error": { "code": "RISK_CONTROL", "message": "..." } }
```

### POST /parse（或 GET /parse?url=）

主接口。`Content-Type: application/json`，body `{"url": "<分享链接>"}`。支持分享短链（v.douyin.com、xhslink.com、v.kuaishou.com、b23.tv、t.cn、youtu.be 等，自动展开）。

`data`（ParseResult）核心字段：

| 字段 | 说明 |
|---|---|
| `platform` / `id` / `kind` | 平台、平台内 ID、`video` \| `album` |
| `title` / `description` / `tags` / `author` | 元数据 |
| `assets[]` | 资源列表，见下 |
| `expiresAt` | 所有直链里最早过期的时刻（Unix 秒），缓存与重取依据 |
| `via` | 解析通道：`http` / `http-l2`（抖音签名通道）/ `browser`（取数语义，全平台统一） |

`assets[]`（MediaAsset）：`type`（video/image/audio/cover）、`url`（**直连地址**，客户端请求时不要带 Referer；YouTube 除外：googlevideo 直链绑解析出口 IP，必须经 `/media` 服务端中转下载）、`variants[]`（同资源的其他档位，抖音给全四档）、`width` / `height` / `durationMs` / `size`、`backups[]`（备用 CDN）、`liveClipUrl`（实况照片的 5s 视频）。B 站与 YouTube 视频另带 `audioUrl`（DASH 音轨，需与视频分别拉取后合成）。

错误码与 HTTP 状态：`INVALID_URL`(400)、`UNSUPPORTED_PLATFORM` / `UNSUPPORTED_CONTENT`(422)、`CONTENT_NOT_FOUND`(404)、`CONTENT_RESTRICTED`(403)、`AUTH_REQUIRED`(424)、`RISK_CONTROL`(503)、`UPSTREAM_ERROR` / `UPSTREAM_CHANGED`(502)、`UPSTREAM_TIMEOUT`(504)、`RATE_LIMITED`(429)、`MEDIA_*` / `CONFIG_MISSING`(501)、`INTERNAL`(500)。完整表见 [`docs/调用案例.md`](docs/调用案例.md) §7。

### GET /media?u=&exp=&sig=（可选，默认关闭）

流式中转，三种用途：强制下载文件名（Content-Disposition）、兜底会强制带 Referer 的容器（微信内置浏览器等）、由服务端带正确请求头代取（含手动跟 302）。签名过期不透明重取，返回 410 后重新 `/parse` 取新链接。

调用 `/parse` 的客户端用不到这个接口：正常情况直链拿来就能用，无需任何配置。它只服务两类场景：YouTube 直链绑 IP 必须经服务端中转（见[平台状态](#平台状态)）；自部署的维护者想要上面三种增强能力。

> [!NOTE]
> 配置 `PROXY_SECRET` 后启用（未配置返回 501，直链主路径不受影响）。

- `sig` = HMAC-SHA256(`PROXY_SECRET`, `"<url>\n<exp>"`) 前 32 位十六进制，有效期 600 秒；过期 410、篡改 403。
- 上游域名白名单（平台分享域 + CDN 域），302 每跳重新校验（SSRF 防护）；并发上限 2；支持 Range / HEAD。

### GET /health

存活探针：进程活着即 200 `{"status":"ok","uptime":...}`，不查外部依赖（防外部抖动引发连环重启）。Docker HEALTHCHECK 打这里。

### GET /ready

就绪探针：平台适配器注册齐才 200，否则 503。

### GET /platforms

已注册平台自描述（名称、说明、识别的域名、能力声明）。

### GET /metrics

Prometheus 文本格式（自写渲染，未引 prom-client）：

| 指标 | 类型 | 说明 |
|---|---|---|
| `parse_total{platform,code}` | counter | 解析计数，code 为 `ok` 或业务错误码 |
| `parse_duration_ms` | histogram | 解析耗时分布（毫秒，按 platform） |
| `cache_hit_total` | counter | 缓存命中次数 |
| `upstream_error_total{platform,reason}` | counter | 上游失败/风控次数 |
| `channel_downgrade_total{platform,from,to}` | counter | 解析通道自动降级次数（抖音 `http-l1`→`http-l2`→`browser`；小红书 `http`→`browser`） |
| `parse_retry_total{platform}` | counter | 瞬态错误（超时/5xx）重试次数 |
| `channel_breaker_open{platform}` | gauge | 通道熔断粘性状态（1 = 该平台 HTTP 通道熔断中，固定走浏览器） |
| `uifid_mint_total{result}` | counter | 抖音 uifid 铸造次数（`ok` / `fail`；身份池自动铸造） |
| `uifid_retired_total{reason}` | counter | 抖音 uifid 退休次数（`suspect` 用废 / `evicted` 池满淘汰） |

## 可观测性

- **结构化日志**：pino，一行一请求 JSON。每请求生成/透传 `x-request-id`（响应头回写，日志字段 `reqId`），访问日志含 method、path、status、耗时，平台解析事件另带 platform / id / 耗时。
- **敏感信息脱敏**：所有日志输出经深度 redact，URL 的 query 值整体打码（防 `xsec_token` 等凭据进日志），消息文本里的内联链接同样处理，Error 实例与 detail 递归脱敏。参数名保留，值一律 `REDACTED`。
- 日志级别由 `LOG_LEVEL` 控制（默认 `info`）。

## 本地开发

```bash
bun install
bun x --no-install puppeteer browsers install chrome  # 首次测试前安装测试用 Chrome
bun dev          # 开发（--watch），默认端口 7777
bun test         # 离线回归，含真实 Chromium 浏览器测试
bun run test:status  # 一条命令看全状态：格式 / 类型 / 单测 / 覆盖率 / CI
bun run typecheck
```

`docs/status.html` 是零依赖检测站：状态总览、服务健康、平台状态、使用计数与解析演示一页全有。file:// 直接打开（手动填服务地址），部署后浏览器访问 `http://<服务器>:7777/status` 即看。

> [!TIP]
> 浏览器兜底路径（抖音风控降级、小红书降级兜底）需要本机有 Chrome（Puppeteer 自动管理）；纯 HTTP 通道无此要求。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 7777 | 监听端口 |
| `LOG_LEVEL` | info | fatal/error/warn/info/debug/trace |
| `BROWSER_FALLBACK` | on | 浏览器兜底总开关；设 `off` 时全平台纯 HTTP，风控如实 503（免 Chrome 常驻内存） |
| `DOUYIN_UIFID` | 未配置 | 抖音 L2 签名通道的 `uifid` 访客身份。不配时自动走身份池：有浏览器能力就自动铸造并复用（铸造有节流，用废自动换），零配置启用 L2；显式配置则固定用该身份，失效时按 `docs/research/01` §12 重铸 |
| `DOUYIN_TTWID` | 未配置 | 抖音 L2 的 `ttwid`（可选；与 `DOUYIN_UIFID` 同一次铸造带出最稳）；缺省自动向 ttwid.bytedance.com 注册一个 |
| `IG_GRAPHQL_DOC_ID` | 未配置 | Instagram 匿名 GraphQL 的 `doc_id`；不配时 IG 链接返回 `CONFIG_MISSING`(501)。平台发版会轮换这个值，跟踪 instaloader / gallery-dl 的更新 |
| `PROXY_SECRET` | 未配置 | /media 中转签名密钥；不配则 /media 返回 501 |
| `PUPPETEER_EXECUTABLE_PATH` | - | 容器内固定 `/usr/bin/chromium`（Dockerfile 已设） |
| `PROXY_<PLATFORM>` | 未配置 | 按平台出站代理（如 `PROXY_YOUTUBE`），优先级最高 |
| `HTTPS_PROXY` | 未配置 | 出站代理兜底（`PROXY_<PLATFORM>` 未设时生效）。解析顺序：`PROXY_<PLATFORM>` → `HTTPS_PROXY`；国内平台不受影响（代理只注入海外平台的 fetch 与对应 `/media` 中转） |

参考 `.env.example`。生产 `.env` 放服务器本地（chmod 600），不进仓库。

## 部署

### 镜像

多阶段构建：`oven/bun:alpine` 编译单二进制 → `alpine:3.22` + chromium 运行时（浏览器兜底路径需要真实浏览器内核）。非 root（uid 10001）运行，tini 收僵尸进程，HEALTHCHECK 打 /health。实测体积：arm64 **495MB**、amd64 **527MB**（初始 830MB）；裁剪明细、构建后验收清单与 apk 镜像源切换见 `docs/image-build-notes.md`。apk 源默认走阿里云镜像（官方源实测仅 14KB/s），换官方源：`docker build --build-arg ALPINE_MIRROR=dl-cdn.alpinelinux.org .`

```bash
docker build -t short-video-extractor:v2 .
docker run -d --name short-video-extractor -p 7777:7777 \
  --env-file .env --memory 800m --restart unless-stopped short-video-extractor:v2
curl http://127.0.0.1:7777/health
```

或直接 compose（`7777:7777`、`restart: unless-stopped`、`mem_limit 800m`、`env_file: .env`、日志轮转 10m×3）：

```bash
docker compose up -d
```

### 升级

重新构建镜像后 `docker compose up -d`，确认 `/health`、`/ready` 与每平台一条真实链接解析通过即完成，回滚就是换回旧镜像 tag。偶尔跑一次 `docker image prune` 清构建缓存。

### 检测站

服务自带状态页：浏览器打开 `http://<服务器>:7777/status`，一眼看到服务是否正常、各平台状态、解析成功/失败计数与最近的平台侧故障，每 10 秒自动刷新（可停）。同一张页 file:// 直开也能用（手动填服务地址）。页面内嵌在服务二进制里，没有额外依赖，也不引入监控组件。

## CI

仓库用 GitHub Actions 做持续集成：push 到 main 或提交 PR 时，GitHub 自动拉起干净环境运行 `bun run typecheck` 和全部测试，README 顶部的 CI 徽章显示结果（绿色 = 通过）。测试包含真实 Chromium 的文档读取、XHR 截取和 cookie 等待，不访问真实平台。测试同时统计行覆盖率并上传到 Coveralls，Coverage 徽章显示 main 分支最近一次成功上传的结果，点进去可看逐文件明细。配置在 `.github/workflows/test.yml`：依赖安装时设置 `PUPPETEER_SKIP_DOWNLOAD: "true"`，随后单独安装测试用 Chrome。

## 设计文档

- `docs/调用案例.md`：面向调用方的场景示例（最简调用、图集、选清晰度、DASH 合成、YouTube 中转签名、错误码处置、限流）
- `docs/开发者指南.md`：本地开发、目录导览、代码约定、加平台步骤、测试写法与维护手册（改代码前从这里开始）
- `docs/research/`：平台 API 调研与实测记录（01 抖音/TikTok API、02 国内平台、03 架构、04 小红书 HTTP 通道、05 海外平台与出站代理）
- `docs/image-build-notes.md`：镜像裁剪明细与构建验收清单
