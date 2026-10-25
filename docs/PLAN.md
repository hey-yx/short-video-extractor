# 重构规划 v1（2026-10-24）

> 调研依据：`docs/research/01-douyin-tiktok-api.md`、`02-platforms.md`、`03-architecture.md`（全部为 2026-10-24 实测/源码核对）
> 现状问题清单：`docs/STATUS.md`

---

## 一、结论：可以做，而且收益比预期大

三组**我本机亲手复跑**的数据（Bun 1.3.10，非转述）：

| 验证项 | 结果 |
|---|---|
| 抖音详情接口，只带 `Origin: https://open.douyin.com` | **200 / 42 KB / 290 ms**，`aweme_detail` 完整，4 档码率 |
| 同一请求去掉 `Origin` | 403 `Blocked by ArgusSecurityPlugin Uifid Not Found` |
| 抖音 CDN 下载（带 vs 不带 Referer） | **206 / 91 ms** vs **403** |
| 图集（40 图） | 200 / 232 ms，`media_type=2` 完整 |
| 8 并发同一接口 | 8/8 成功，**平均 66 ms/次** |

对比现状：现方案开 headless Chrome 拦截，1–3 s，常驻 200–400 MB 内存，图集降级路径最坏 40 s+。

**核心判断：抖音可以彻底去掉浏览器。** 这是整个重构的支点。

---

## 二、目标与非目标

### 目标（v1）

1. 四个平台可用：**抖音、小红书、快手、B 站**（其中 3 个纯 HTTP，零浏览器）
2. 统一数据模型：视频多清晰度 / 图集 / 实况照片 / 封面 / 作者 / 过期时间
3. 中转下载端点：解决防盗链与跨域，Range/HEAD 支持（否则前端拿到链接也播不动）
4. 插件式平台层：**加平台 = 加一个目录 + registry 一行**，解析函数纯函数化，可离线单测
5. 可用性：限流、超时预算、通道降级、健康检查、结构化日志、指标
6. 全新 API（2026-10-25 决定：**完全重构，与旧版无关**，不保留 `/pv`、`/public/parseVideo` 旧契约）

### 非目标（明确不做，附理由）

| 不做 | 理由 |
|---|---|
| TikTok | 需海外出口 + X-Gnarly/X-Dynosaur 四参数签名，SDK 2–3 个月一升版，工程量是抖音一个数量级 |
| 微信视频号 | 无公开播放页、取流绑微信会话、文件本身加密（前 128 KB 用 Isaac64 密钥流），结构性不可行 |
| Instagram | 匿名全登录墙，只能「用户自带 cookie」，不适合公共服务 |
| Web 前端 | 当前是 API 服务，前端另议 |
| Redis / 多副本 | v1 单机，接口层预留，Redis 作为 v2 第一项 |

---

## 三、平台方案（每个平台的确定路线）

| 平台 | 通道 | 关键做法 | 验证状态 | 浏览器 |
|---|---|---|---|---|
| **抖音** | 纯 HTTP | detail 接口 + `Origin: open.douyin.com`；`video.play_addr`=无水印 1080p，`download_addr`=带水印 720p；图集看 `images[]`，实况看 `images[i].live_photo_type===1` | ✅ 我实测 | 不需要（降级才用） |
| **小红书** | 浏览器抓 HTML | 一次导航抓**主文档原始 HTML** → 解析 `window.__INITIAL_STATE__` → `noteDetailMap`；彻底废弃 DOM 翻页/资源嗅探 | ⚠️ 字段已由调研确认（yt-dlp 同路径），**待 spike 用真实分享链接验证** | 需要（原因见下） |
| **快手** | 纯 HTTP | `v.kuaishou.com` 302 → `v.m.chenzhongtech.com/fw/photo/{id}` → 页面内嵌 `INIT_STATE` → `manifest.adaptationSet` 多清晰度 | ✅ 调研实测 | 不需要 |
| **B 站** | 纯 HTTP | `x/web-interface/view` + `x/player/playurl?try_look=1` 拿 1080P，DASH 音视频分离 | ✅ 调研实测 | 不需要 |
| 微博 | 纯 HTTP | 访客票据 `genvisitor2`→`visitor` + `statuses/show` | ✅ 调研实测 | v2（需票据刷新机制） |

**小红书为什么还留着浏览器**：决定放行的是 TLS/HTTP2 指纹（同一组 header，`curl` → 302 登录页，`curl_cffi impersonate=chrome` → 200）。Bun 的 `fetch` 无法伪造 JA3/JA4。可选方案两个：

- **A（v1 选它）**：Puppeteer 一次导航，从 response 事件截主文档 HTML 取 `__INITIAL_STATE__`。约 1–2 s，但一次拿全（标题/作者/全部图片/视频多清晰度/实况），比现在点翻页 + 嗅探快一个量级。
- B（v2 备选）：`curl-impersonate` / `curl_cffi` 边车进程，纯 HTTP 但多一个二进制依赖和进程管理。

选 A 的理由：不引入新运行时依赖，现网已验证可行，且解析改动本身就把速度从 10 s+ 降到 1–2 s；把 B 留成 `HttpClient` 的一个实现即可切换。

---

## 四、目标架构

```
src/
├── index.ts                      # startServer()
├── config.ts                     # env 校验，启动 fail-fast
├── bootstrap/{app,server}.ts     # createApp() 可被测试直接调用；优雅关闭
├── routes/
│   ├── parse.routes.ts           # POST /parse  GET /parse?url=
│   ├── media.routes.ts           # GET|HEAD /media（中转）
│   ├── ops.routes.ts             # /health /ready /metrics
│   └── legacy.routes.ts          # /pv、/public/parseVideo（兼容旧契约）
├── services/
│   ├── parse.service.ts          # 编排：缓存 → 限流 → 通道降级 → 信封
│   ├── media-proxy.service.ts    # 流式中转 + HMAC 签名 + SSRF 防护
│   └── cache.ts                  # lru-cache + expiresAt 语义 + 负缓存
├── platforms/
│   ├── types.ts                  # PlatformAdapter / MatchResult / FetchCtx
│   ├── registry.ts               # match / dispatch（含短链委托、防环）
│   ├── douyin/{adapter,fetch,parse}.ts
│   ├── xhs/{adapter,fetch,parse}.ts
│   ├── kuaishou/{adapter,fetch,parse}.ts
│   └── bilibili/{adapter,fetch,parse}.ts
├── core/{errors,envelope,url}.ts
└── infra/{http,browser,logger,metrics}.ts
```

**三条硬约束（写进 review checklist）**：

1. `platforms/**` 不许 `import { Elysia }`，不许读 env，不许 `console.log`
2. `fetch()` 是平台层唯一允许 IO 的方法；`parse()` 必须是纯函数（同输入同输出）
3. `routes/**` 不许出现 `if (platform === 'douyin')`

第 2 条是可测试性的前提：解析逻辑 100% 可离线回归，平台改版时看到的是「单测红」，不是「线上悄悄返回空数组」。

### 统一数据模型（对外最小集）

```ts
interface MediaAsset {
  type: 'video' | 'image' | 'audio' | 'cover';
  url: string;
  expiresAt?: number;      // 直链自身过期时刻（Unix 秒）
  width?: number; height?: number; durationMs?: number; size?: number;
  watermark?: boolean;     // 抖音 download_addr 显式标记带水印
  backups?: string[];      // 备用 CDN
  /** 同一资源的不同档位直链（抖音：540p/720p/1080p/origin） */
  variants?: { ratio: string; url: string; size?: number }[];
  proxyHeaders?: { referer?: string | null; userAgent?: string };
  quality?: string;        // 1080p / 720p / normal_1080_0
}

interface ParseResult {
  platform: 'douyin' | 'xhs' | 'kuaishou' | 'bilibili';
  id: string;
  title: string;
  author: { name: string; avatar?: string; id?: string };
  assets: MediaAsset[];
  expiresAt?: number;      // 所有资源里最早过期的那个
  parsedAt: number;
  via: 'http' | 'browser';
}
```

> 现有 `resources: {type, urls[]}[]` 丢掉了过期时间、备份域、代理头、尺寸——恰好是中转与缓存必需的。**`resources` 保留为派生兼容字段，内部一律用 `assets`。**

---

## 五、对外 API

| 接口 | 说明 |
|---|---|
| `POST /parse` `{url}` | 主接口，返回 `{success, data: ParseResult, error?}` |
| `GET /parse?url=` | 同上的调试形态 |
| `GET\|HEAD /media?u=&exp=&sig=` | **可选**中转：强制下载文件名（Content-Disposition）、兜底不支持 no-referrer 的客户端、链接过期后重取；HMAC 签名 + SSRF 白名单 + 限速 |
| `GET /health` `/ready` `/platforms` | 存活 / 就绪 / 已注册平台自描述 |

`data.assets[].url` 是**直连地址**（默认主路径，服务器零带宽）。抖音视频给的是 `play/?video_id=&ratio=1080p` 形态，客户端**不带 Referer** 即可下载（实测 200 / 1.75 MB / 1.9 s）。每个 asset 另带 `downloads` 字段，列齐 540p/720p/1080p/原片四种档位。`/media` 中转只在需要「强制下载文件名」或客户端无法去掉 Referer 时使用。

---

## 六、分阶段计划（每阶段独立可上线、可验收）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P0 止血**（0.5 天） | 删 `PuppeteerManager`（明文账号密码那段死代码）；下线或鉴权 `/public/cache/*`；错误响应改 JSON | `grep` 无凭据残留；错误响应是 JSON；改密已提醒 |
| **P1 骨架 + 抖音**（1.5 天） | `core/errors`、`envelope`、`platforms/types`、`registry`、`config`；抖音 adapter（`fetch` + `parse` 拆分）；旧接口兼容 | 抖音视频/图集/实况 fixture 单测通过；`POST /parse` 实链 200；P95 < 500 ms |
| **P2 小红书**（1.5 天） | Spike 验证 `__INITIAL_STATE__` 取数（先跑通再写 adapter）；弃 DOM 翻页；保留浏览器通道 | 真实分享链接解析出全部图片 + 视频；P95 < 2.5 s；fixture 回归 |
| **P3 快手 + B 站**（1 天） | 两个纯 HTTP adapter；B 站多 P / DASH 音视频分离 | 各 3 条真实链接解析成功；单测覆盖 parse |
| **P4 直链分发 + 可选中转 + 缓存 + 限流**（1.5 天） | 直链拼装（抖音 `play/?video_id=&ratio=`）、`variants` 档位、`/media` 增强（Range/HEAD/302/SSRF/限速）、lru-cache + `expiresAt` + 负缓存、限流 + 熔断 | 客户端不带 Referer 直下四平台成功；`/media` 也返回 206；缓存里不出现死链 |
| **P5 可观测**（0.5 天） | pino 结构化日志（redact）、`/metrics`、`/health`、`/ready`；每日探活脚本 | 日志能定位单次请求；探活任务跑通 |
| **P6 自建镜像 + 灰度**（1.5 天） | Dockerfile（多阶段、非 root、健康检查）、compose、服务器 clone 构建、并行起 16004、反代切流、观察 | 新容器四平台实链通过；旧容器保留可秒级回滚；内存峰值 < 800 MB |

**总计约 8 个工作日**（含自验、fixture、联调、灰度观察）。

### 每阶段的「完成」定义

- 代码写了 **且** `bun test` 绿 **且** 用真实链接跑通一次（贴出实际响应摘要）
- 阶段结束时 `git commit`（中文信息），不累积成大坨

---

## 七、风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| **抖音 L1 口子被堵**（只需加一个 header 校验） | 主力通道失效 | 监控 403 比例 > 5% 告警；保留 L2 签名通道与 L3 浏览器兜底代码；本次只测了 30 次 / 2 个 IP，日级配额未知 |
| 小红书 IP 风控（机房 IP 易触发 `300012 IP at risk`） | 解析失败率上升 | 保留浏览器通道（真实 UA + 指纹更像人）；上线后按 IP 打点；必要时加住宅代理 |
| 平台改版导致字段变化 | 静默返回空结果 | parse 纯函数 + fixture 回归，改版时单测先红；`UPSTREAM_CHANGED` 错误码 + 告警 |
| 中转被当免费 CDN 刷 | 带宽成本 | HMAC 签名短时效（10 min）+ host 白名单 + IP 限流 + 单次请求体积上限 |
| 直链 TTL 短（抖音视频约 3 小时） | 缓存里拿到死链 | 不缓存直链本身；缓存元数据 + `expiresAt`，过期重取；视频直链缓存 ≤ 30 min |

**法律/合规提醒**（不替你决定，只说明事实）：这类服务依赖平台未公开接口，B 站 2026-01 已对 API 文档站发律师函；公开对外提供、商业化或有规模流量时存在被追责的可能。个人自用/小范围工具风险低，但对公网开放要自己评估。

---

## 八、已确认的决定（2026-10-24）

1. **平台范围**：抖音、小红书、快手、B 站做 v1；微博放 v2。
2. **鉴权**：不强制 API Key。保持 `CORS: *` + 按 IP 宽松限流，`API_KEYS` 作为可选开关（配了就校验，不配就放行）。
3. **部署环境**：上海腾讯云 `shanghai-tencent`（腾讯云服务器（已脱敏）），已实地查清，见下节。

---

## 九、部署现状（2026-10-24 实测查清）

| 项 | 事实 |
|---|---|
| 机器 | `shanghai-tencent` 腾讯云服务器（已脱敏），腾讯云轻量·上海四区，Ubuntu 22.04 |
| 容器 | `video-parser`，镜像 **`yassine778/video-parser:latest`**（Docker Hub 上别人构建的，digest `a5086c86…`，877 MB，镜像创建于 2026-02-09） |
| 运行方式 | 原生 `docker run -p 16003:7777`，`unless-stopped`，**无挂载、无 compose、服务器上没有代码目录** |
| 入口 | 1Panel openresty 反代 `sve-api.itcox.cn` → 127.0.0.1:16003，443 正常 |
| 资源 | 容器内存 ~307–470 MB / 3.3 GB；CPU <1.5%；磁盘 **33 G / 40 G（86%，剩 5.5 G）** |
| 使用量 | 5 周日志共 574 行，约 **38 次成功解析** —— 低频自用 |
| 现网性能 | 抖音解析实测 **4.4–4.5 s**（内网直连与外网各测一次，结果一致） |
| 历史失败 | 60 条 `Error: NOT_FOUND`（Puppeteer 打开失效链接直接抛错，没有业务错误码） |
| 服务器环境 | 有 docker / git，**没装 bun** |

三个由此得出的判断：

1. **线上跑的不是你本地代码**，是 Docker Hub 上别人推的镜像。重构后必须改成「自己构建 + 自己推」，这是部署路径的变更。
2. **低频（5 周 38 次）→ 可以放心并行灰度**，不用停机窗口。
3. **磁盘只剩 5.5 G**，旧镜像 877 MB，新镜像若带 Chromium 也是 800 MB 级 → 构建前先清旧镜像，且不要保留多份构建缓存。

---

## 十、迁移与回滚（并行双容器，零停机）

| 步 | 动作 | 回滚点 |
|---|---|---|
| 1 | 服务器上 `git clone` 仓库到 `/root/short-video-extractor`，`.env` 单独放（chmod 600） | — |
| 2 | 构建镜像 `video-parser:v2`，起容器名 `video-parser-v2`，端口 **16004**，旧容器不动 | 无影响 |
| 3 | 直接 `curl 127.0.0.1:16004` 跑四平台验证 | 无影响 |
| 4 | 1Panel 反代改指向 16004（一条配置） | 改回 16003 即秒回 |
| 5 | 观察 3–7 天（日志、失败率、内存） | 同上 |
| 6 | `docker stop video-parser`（**不删**），确认一周无回退需求后再删镜像 | 重启旧容器 |

反代改配置是唯一有感知的动作，且可秒级回退；其余步骤都不影响现网。

---

## 十一、下载策略：直连优先，中转只做增强（已实测修正上一版）

> 上一版我写「必须服务端中转」，**是错的**。漏测了一种形态：`play/?video_id=` 这条接口 302 出去的冷存储节点**不校验 Referer**，客户端不带 Referer 就能直接下。

### 11.1 实测矩阵（全部我本机跑过）

| 平台/形态 | 空 Referer | 带本站 Referer | 带平台 Referer | 结论 |
|---|---|---|---|---|
| 抖音 `play/?video_id=&ratio=1080p` | **200** | 403 | 302→可下 | **直连可行** |
| 抖音 `play_addr.url_list`（web 播放节点） | 403 | 403 | 206 | 只能中转或换 play 接口 |
| 抖音图片 `url_list` | 200 | 200 | 200 | 直连，任何 Referer 都行 |
| 小红书视频 `masterUrl` | 200 | **403** | 200 | 直连可行（客户端不带 Referer） |
| 小红书图片 | 200 | 200 | 200 | 直连 |
| 快手 `mainMvUrls` | 206 | 206 | 206 | 直连，连 UA 都不挑 |
| B 站 `dash` | 206 | 206 | 206 | 直连 |

### 11.2 抖音 play 接口的 ratio 实测

`https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>&ratio=<R>&line=0`，空 Referer：

| ratio | 拿到什么 | 体积 | 耗时（本机） |
|---|---|---|---|
| `default` | **原片**（QuickTime 容器） | 27.4 MB | 6.0 s |
| `1080p` | 转码 1080p | 1.75 MB | 1.9 s |
| `720p` | 转码 720p | 1.08 MB | 0.78 s |
| `540p` | 转码 540p | 0.99 MB | 0.63 s |

### 11.3 结论：默认返直链，服务器零带宽

1. **API 默认返回直链**（`assets[].url`），不经过服务器。
2. 抖音视频必须给 `play/?video_id=<uri>&ratio=` 形态，**不能给 `play_addr.url_list` 里那个 web 节点直链**（空 Referer 也 403）。
3. 客户端要求：**请求时不带 Referer**。
   - 浏览器：`<a referrerpolicy="no-referrer" rel="noreferrer" target="_blank">`、`fetch(..., {referrerPolicy:'no-referrer'})`
   - App/脚本：自己控制请求头即可
4. 每个 asset 同时返回 `downloads` 字段（各 ratio 的直连地址），一次给全，调用方自己挑。

### 11.4 中转 `/media` 保留，但降级为「增强」

只在三种情况下用，不是主路径：

| 用途 | 为什么需要 |
|---|---|
| 强制下载 + 正确文件名 | 跨域 `<a download>` 的文件名不生效，只有 `Content-Disposition` 能控制 |
| 不支持 no-referrer 的容器 | 微信内置浏览器/部分小程序 webview 会强制带 Referer → 403 |
| 链接过期后透明重取 | 抖音视频直链约 3 h 过期，中转层可以按 `key` 重新签名再回源 |

带宽约束依然存在（服务器上传 2.7 Mbps ≈ 332 KB/s），所以中转必须限速 + 并发上限 2；但因为默认不走它，这个天花板不再是主要矛盾。

### 11.5 同行怎么做的（回答「多参考同行」）

| 项目 | 分发形态 | 为什么 |
|---|---|---|
| **cobalt**（45k★, AGPL） | **纯流式代理**，README 原话「never caches any content, works like a fancy proxy」 | 它主战场是 YouTube，`googlevideo` URL 绑定请求 IP + 短时效，不代理必然失败 |
| **Evil0ctal v5**（20.8k★, Apache-2.0） | 解析接口给直链 + 独立的 `/api/v1/downloads` 服务端下载任务（落盘后再给文件 URL） | 两种用户都要：开发者拿直链，普通用户点「下载」 |
| **parse-video**（1.07k★, MIT, Go） | **纯直链** + CLI 可选下载 | 22 平台，最轻；不做存储也不做代理 |
| **yt-dlp**（201k★） | 直链 + formats 列表，下载完全交给调用方 | 同上 |

启示：**直链派适合「给开发者 API」，代理派适合「给终端用户一键下载」**。我们两者都给，默认直链，`/media` 作为可选项——这正好符合你要的「存链接，不搬字节」。

### 11.6 如果以后真要对外提供服务

现在服务器上传 2.7 Mbps，纯直链方案下不算瓶颈（服务器只出 JSON）。要扩的话按这个顺序：Cloudflare Worker 反代 → 升带宽 → 对象存储+CDN。

---

## 十二、未知点（明确列出来，不装懂）

### A. 需要你提供 / 决定

| # | 未知点 | 为什么需要 | 不解决的后果 |
|---|---|---|---|
| A1 | **1–3 条小红书真实分享链接**（App 里复制的带 `xsec_token` 那种） | 调研只确认了字段路径，**没有跑通过一次真实解析**；token 与 noteId 强绑定，且短链展开规则未实测 | P2 无法验证，小红书方案只能算「理论可行」 |
| A2 | 域名：继续用 `sve-api.itcox.cn` 还是新开 | 影响证书、反代、调用方改地址 | 用旧域名则调用方零改动（推荐） |
| A3 | 是否需要 Web 页面 | 当前纯 API | 默认不做 |
| A4 | 失败告警发到哪里（邮件/企微/Telegram） | 「抖音口子被堵」需要第一时间知道 | 只能靠你手动发现 |

### B. 实施时必须实测（我会在对应阶段做完再报）

| # | 未知点 | 何时查 |
|---|---|---|
| B1 | **小红书在腾讯云上海 IP 能否放行**（机房 IP 有 `300012 IP at risk` 先例） | P2 第一天；不通就要加代理兜底，会改变 P2 工作量 |
| B2 | 小红书 `__INITIAL_STATE__` 在 hydration 后会被删，取 HTML 的时机要抢在哪一步 | P2 |
| B3 | 快手**图集**字段名（调研只验证了视频） | P3 |
| B4 | B 站 upos 节点偶发 403 是否靠 Referer 解决 | P3 |
| B5 | 抖音 4 档码率里哪几档可下、体积多大 | P1 |
| B6 | 浏览器池在小红书场景的内存峰值（决定池大小） | P2 |
| B7 | 中转在 Bun 下的背压实测（大文件是否稳） | P4 |

### C. 外部不可控（只能监控，消除不了）

1. **抖音 L1 通道随时可能被堵**。它的原理是「借用官方嵌入播放器 `open.douyin.com` 的 Origin 白名单」，不是协议承诺。堵了就是全量 403。缓解：L2 签名通道 + L3 浏览器兜底 + 每日探活告警。目前只测了 30 次/2 个 IP，**日级配额完全未知**。
2. 抖音视频直链约 3 小时过期（实测 `cdn_url_expired` 剩 2.4–3.4 h），图片 30 天。
3. 小红书 TLS 指纹规则、`xsec_token` 强校验、IP 信誉随时收紧。
4. 平台改版导致字段漂移。
5. 合规：B 站 2026-01 已对 API 文档站发律师函。你的用量是低频自用，风险低；一旦公开或商业化，风险自担。

### D. 我不确定、但影响设计的假设

- **假设：小红书浏览器通道能稳定拿到 HTML**。现在线上就靠 Puppeteer，理论上可行；但「抓主文档 HTML」和「嗅探资源」是两种操作，改法能否一次成，P2 第一天就知道。
- **假设：抖音 L1 在服务器上长期可用**。我已实测服务器侧 3/3 成功（TTFB 0.26–0.44 s），但只代表此刻。

---

## 十三、密钥与配置

- 需要新引入：`PROXY_SECRET`（中转签名）、可选 `API_KEYS`、`RATE_LIMIT_*`、`BROWSER_POOL_SIZE`。
- 存放：服务器本地 `.env`（chmod 600），仓库只放 `.env.example`。
- 现有 `.env.development` 是明文且进过 git，重构时一并改成 example 模式。

## 十四、监控与每日体检

单机自用没有 Prometheus 栈，v1 用三层：

1. `/health`（进程活）+ `/ready`（能发外部请求）
2. `/metrics`（Prometheus 文本格式，先只暴露关键计数）
3. **每日探活**：用 Hermes 定时任务每天跑四条真实链接（四平台各一），任一失败就通知。这是「口子被堵」最快的发现方式，比指标告警更直接。

## 十五、工作量修正

加入部署、灰度、带宽治理后：**约 8 个工作日**（原估 7 天 + 自建镜像与灰度 1 天）。

---

回复「按这个来」我就从 P0 开工。A1（小红书真实链接）最好一并给我，P2 会卡在那里。
