# 05 · 海外平台 2026 可行性调研（YouTube / Instagram / 视频号 / TikTok）+ 出站代理架构

> 调研时间：**2026-10-26 00:30–01:30 CST**
> 目标：为海外平台扩展判定每个平台能否做、代价多大、走什么通道，并给出出站代理基础设施的可落地设计。
> 标注约定：**【实测】**= 本文调研时真实发请求得到的返回；**【源码】**= 读了对应开源仓库源码/官方文档；**【未核验】**= 只有二手资料或本机环境无法复现，落地前需自测。
> 与 02 号的关系：02 号是 2026-10-24 的国内平台调研，其 YouTube/IG/视频号结论在本文被**复测与修正**（IG 翻案）。

---

## 0. 评级总表

| 平台 | 评级 | 一句话 | 必需条件 |
|---|---|---|---|
| YouTube / Shorts | **能做**（纯 API） | `IOS` client 免 PO Token 免 cookie 直出明文直链；`ANDROID_VR` 可冲 4K 但被 bot 检查概率性拦截 | 出站代理 + `/media` 服务端中转（直链绑 IP） |
| Instagram Reels | **能做**（纯 API，免登录！） | 旧结论「基本不可行」**翻案**：匿名 GraphQL `doc_id` 口子 2026-10-26 实测通，无需任何 cookie | 出站代理 + `doc_id` 配置化（会轮换） |
| 微信视频号 | **不能做** | 旧结论维持：结构性封死，近半年新工具全是「抓客户端+解密」或「扫码登录」 | — |
| TikTok | **能做**（走第三方/自托管通道） | tikwm 免费接口实测通（无水印直链 206）；官方 web 端对机房 IP 出 WAF 挑战页 | 出站代理 + 第三方服务依赖（或自托管 Evil0ctal） |

---

## 0.1 实测环境与方法

| 项 | 值 |
|---|---|
| 时间 | 2026-10-26 00:30–01:30 CST |
| 出口 | 本机 Clash **TUN 模式**（全局接管，环境变量设不设出口都是同一 IP），显式本地代理（端口已脱敏）；香港机房出口（IP 已脱敏） |
| 工具 | `curl` 8.x、`bun` 1.3.10、`python3`（JSON 解析）、自建 40 行 CONNECT 代理（验证 Bun 代理行为用） |
| 判断手段 | HTTP 状态码 + 响应 JSON 键 + 直链 Range 下载验字节（`file` 确认 ISO MP4），不做视觉比对 |
| 重要提醒 | 本机 TUN 全局接管 → **「设代理/不设代理」在本机测不出差异**（unset 环境变量后 curl 出口 IP 仍相同）。凡「代理是否生效」类结论都用自建 CONNECT 代理打点验证，结论可迁移到无 TUN 的部署机 |

---

## 1. YouTube + Shorts（重点）

### 1.1 评级

**能做**。纯 API、免 cookie、免 PO Token（截至 2026-10-26），但有两条硬约束：**直链绑出口 IP 且 6 小时过期**（必须服务端中转），以及 **bot 检查按 client/视频组合概率性触发**（需要回退链）。

### 1.2 innertube client 现状实测（2026-10-26）

全部为 `POST https://www.youtube.com/youtubei/v1/player`，body `{"context":{"client":{...}},"videoId":"<id>","contentCheckOk":true,"racyCheckOk":true}`。

| client | 测试视频 | 结果 |
|---|---|---|
| `ANDROID_VR`（`1.62.27`，`androidSdkVersion: 32`） | `dQw4w9WgXcQ` | **OK，26 条 adaptiveFormats 全明文 url（0 条 signatureCipher），最高 2160p**【实测】 |
| `ANDROID_VR` | `9bZkp7q19f0` / `kJQP7kiw5Fk` / `JGwWNGJdvx8` / `pjWY5NkjsrY`（Shorts） | **LOGIN_REQUIRED「Sign in to confirm you're not a bot」**，重试 4 次 + 带 visitorData 均拦【实测】 |
| `IOS`（`20.32.4`，`deviceModel: iPhone16,2`，`osVersion: 18.5.22F76`） | `9bZkp7q19f0` | **OK，18 条 adaptiveFormats 全明文 url，最高 1080p**（137 avc1 + 139/140 mp4a 音轨）【实测】 |
| `IOS` | `pjWY5NkjsrY`（Shorts） | **OK，22 条全明文 url**【实测】 |
| `WEB` | `dQw4w9WgXcQ` | UNPLAYABLE / "Video unavailable"【实测】（02 号结论一致） |
| `MWEB` | `9bZkp7q19f0` | UNPLAYABLE / "The page needs to be reloaded."【实测】 |
| `WEB_EMBEDDED_PLAYER` | `9bZkp7q19f0` | ERROR / "This video is unavailable"【实测】 |
| `ANDROID` / `TVHTML5_SIMPLY_EMBEDDED_PLAYER` | `9bZkp7q19f0` | 无 playabilityStatus 的空响应【实测】 |

关键结论：

1. **`IOS` 是当前最稳的免 PO Token client**（本卡 4 条样本全过，含 Shorts）；**`ANDROID_VR` 能过部分视频且能给到 4K**（`dQw4w9WgXcQ` 4 条重试全过），被拦时是 bot 检查不是永久封。
2. 与 cobalt 社区情报有出入：2026-09-28 有人报告 ANDROID_VR 的**媒体直链**被 403（见 §6 cobalt PR #1581），而本卡 2026-10-26 实测 ANDROID_VR 直链下载 **206 正常**【实测】。说明这是持续动态攻防，实现卡必须做到：**client 可配置 + 失败自动换 client 重试**，不要把单 client 写死。
3. `POST /youtubei/v1/player` 的 `key=` 查询参数**可省略**（不带 key 实测 200）【实测】——比 02 号记录少一个要维护的常量。
4. youtubei.js 用 `generate_session_locally: true` 生成的上下文会触发 ANDROID_VR bot 检查（IOS 不受此影响）【实测】，用默认远端生成 session 则正常——见 §1.5。

### 1.3 直链与 IP 一致性、与 /media 中转的配合

实测拿到的直链（`streamingData.adaptiveFormats[].url`）特征：

- URL 内含 `ip=<解析出口 IP>&expire=<unix 秒>` —— **绑定解析时的出口 IP + 约 6 小时过期**（响应体 `expiresInSeconds: 21540`）【实测】。
- 同一出口 IP Range 下载：`206 video/mp4`，1 MB/2.9 s，ISO MP4 字节头正确【实测】。
- 跨 IP 下载失败（403）是 yt-dlp/cobalt 社区共识【未核验】（本机 TUN 无法制造异 IP 场景），但 `ip=` 参数是 URL 里可见的事实，架构上按「绑 IP」对待没有风险。

配合 `/media` 中转的硬规则：

1. **解析请求与中转下载必须走同一个代理出口**——googlevideo 校验的是「下载方 IP == URL 里 ip=」。`src/services/media-proxy.ts` 的 `fetchUpstream()` 拉流时必须用与解析 adapter 相同的 proxy（见 §5.2 env 设计）。
2. 直链**不下发给客户端**（客户端下载 IP 与解析 IP 不一致必然 403）。现有 `/media` 签名中转正好是这个角色。
3. `allowedHosts()` 白名单需加 `*.googlevideo.com`。
4. 现有 `expiresAt`（Unix 秒）字段直接可用：取 `expire` 参数或 `parsedAt + expiresInSeconds`，缓存 TTL 取其一半。

### 1.4 格式拿法（DASH / mp4）

`dQw4w9WgXcQ` 的 ANDROID_VR 档位表（节选）：

| itag | 分辨率 | 编码 | 大小 | 说明 |
|---|---|---|---|---|
| 401 / 313 | 2160p | av01 / vp9 | 240M / 358M | 4K，仅 ANDROID_VR 给 |
| 137 / 248 | 1080p | avc1.640028 / vp9 | 80M / 30M | **1080p avc1 是理想档** |
| 136 | 720p | avc1 | 26M | |
| **18** | 360p | avc1 + mp4a（合并） | — | **音视频已合，免转码直出** |
| 140 / 251 | 音频 | mp4a.40.2 / opus | — | DASH 伴音轨 |

- **全部明文 `url`，0 条 `signatureCipher`**（ANDROID_VR 26 条、IOS 18/22 条）【实测】——**不需要 nsig/signature 解扰**，这是 2026-10 现状对本项目最友好的一点。
- 高清走 DASH 音视频分离（video 137 + audio 140），下载端合成——项目 `MediaAsset.audioUrl` 字段已有（B 站 DASH 同款用法），架构现成。
- itag 18（360p 合并档）ANDROID_VR 有、IOS 本次未见【实测】——低清场景可免合成。
- Shorts 与普通视频走同一接口，URL 形态（`/shorts/<id>`）只影响 `match()` 提取 videoId。

### 1.5 youtubei.js（LuanRT/YouTube.js）在 Bun 下的评估

| 项 | 实测/核验结果 |
|---|---|
| 版本与 License | `youtubei.js@18.3.0`，MIT（LuanRT/YouTube.js，⭐5391，2026-10-23 活跃） |
| 依赖重量 | **零运行时依赖**；包体 22 MB（含 web/react-native 预构建 bundle），`bun add` 后全部 node_modules 61 MB |
| Bun 兼容性 | **直接可用**，`Innertube.create()` + `getBasicInfo()` 在 Bun 1.3.10 实测 OK【实测】 |
| 代理配置 | **`SessionOptions.fetch?: FetchFunction` 注入点**——包一层 `fetch(input, init)` 加 Bun 的 `{ proxy }` 选项即全量代理，实测经自建 CONNECT 代理出站成功【实测】 |
| client 切换 | `getBasicInfo(id, { client: 'ANDROID_VR' \| 'IOS' })`（`GetVideoInfoOptions{client, po_token}`）【源码+实测】 |
| 速度 | 一次 create + getBasicInfo ≈ 1.5–3.8 s（远端生成 session） |
| PO Token 支持 | `SessionOptions.po_token` / per-request `po_token` 已预留【源码】——将来 bot 检查收紧时有接 BotGuard token 的位置 |
| 附赠 | session 的 `clientVersion` 自动跟进新版（实测拿到 `WEB 2.20261023.01.00`）；`retrieve_player: false` 可跳过 JS player 拉取提速 |

**坑**（都是实测踩出来的）：

1. `getBasicInfo` 第二参是 **options 对象**，传裸 client 字符串会静默走默认 WEB client → 恰好得到 UNPLAYABLE（和 WEB 的 bot 墙长得一样，很容易误判）。
2. `generate_session_locally: true` + `ANDROID_VR` 会触发 bot 检查；默认远端生成 session 正常。要提速别动这个开关，先用 `retrieve_player: false`。
3. 它自带 fetch 封装——必须显式注入 proxy fetch，否则代理环境变量靠 Bun 的默认 fetch 行为兜底（能工作，但注入后可做到「按平台走不同出口」）。

### 1.6 youtubei.js vs 手写 innertube（cobalt 路线）怎么选

| 维度 | youtubei.js | 手写 innertube |
|---|---|---|
| 最小工作量 | 2 行 create + 1 行 getBasicInfo | 约 100 行（两个 POST + 字段提取） |
| 依赖成本 | 22 MB 包，零运行时依赖，MIT | 零依赖 |
| client version 维护 | 社区跟新（实测已跟到 2026-10） | 自己盯 yt-dlp/cobalt 动态 |
| PO Token / attestation 演进 | 已有挂载点 | 自己接 |
| signatureCipher 兜底 | 自带 decipher（本次没用上） | 自己接 JS 解扰 |
| 「fetch() 唯一 IO」约束 | 可保住（fetch 注入） | 天然保住 |
| Bun 兼容 | 实测 OK | 实测 OK（curl/bun fetch 直接 POST 即可） |

**结论**：两条路线在 2026-10 现状下都成立，按依赖策略选：

- **有「能不引就不引」洁癖 → 手写 innertube 完全可行**：当前全明文直链、零 decipher、免 PO Token，手写就是两个 POST（本文实测形态见 §1.2），约 100 行，MIT 式零依赖。
- **要留攻防余量 → youtubei.js 为主**：长期风险不是「发两个 POST」，而是 YouTube 端 attestation/PO Token 演进，client 表和 decipher 兜底交给社区维护更划算；MIT + 零运行时依赖不破坏单二进制（能否顺利 `bun build --compile` 打包本次未跑【未核验】）。
- 无论选谁，**把 client 切换（ANDROID_VR↔IOS）做成配置 + 失败回退**，这是实测里最大的确定性风险点。

---

## 2. Instagram Reels（结论翻案：免登录可行）

### 2.1 评级

**能做，且零账号风险**。旧结论「需 cookie、匿名基本不可行」在 2026-10-26 **不成立**：gallery-dl 社区 2026-07 发现的匿名 GraphQL `doc_id` 通道今天实测仍通，一条 POST 拿到完整媒体 JSON，直链匿名可下。

### 2.2 旧口子复测：仍然全封（与 02 号一致）

| 请求 | 结果 |
|---|---|
| `instagram.com/reel/<code>/?__a=1&__d=dis` | 404，20.9 KB 登录页 HTML【实测】 |
| `api.instagram.com/oembed/?url=...` | 302 跳登录【实测】 |
| `instagram.com/reel/<code>/embed/captioned/` | 200 但 503 KB 页面满屏 login 文案、无 `video_url`【实测】 |
| `api/v1/users/web_profile_info/?username=`（匿名 profile listing） | **401**【实测】——连匿名列表都关了，02 号时代「匿名还能看 profile」的说法也已过期 |

### 2.3 新口子：匿名 GraphQL `doc_id`（重点发现）

出处：gallery-dl issue #9564（2026-08-06 关闭，声称 2026-07 测试通过）；instaloader PR #2706（2026-06 因旧 doc_id 废弃切换到同一 doc_id）。**本卡 2026-10-26 独立实测复现成功**【实测】：

```
# 第一步：拿 csrftoken（匿名，无任何登录）
GET https://www.instagram.com/        → Set-Cookie: csrftoken=<token>

# 第二步：POST GraphQL，按 shortcode 拿媒体
POST https://www.instagram.com/graphql/query
  Cookie: csrftoken=<token>
  X-IG-App-ID: 936619743392459
  X-CSRFToken: <token>
  doc_id=27128499623469141
  variables={"shortcode":"<code>","__relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider":false}
```

实测真实 reel（`C9z1OIUi8Yh`）：**200 / 27 456 B / `errors: null`**，拿到 `media_type: 2`、`product_type: "clips"`（Reels）、作者 `just.rawphotos`、caption、`video_versions` 3 档（640×360，type 101/102/103）。

**字段路径**（2026-10 现状）：

```
data.xdt_api__v1__media__shortcode__web_info.items[0]
  ├─ media_type (1=图 2=视频 8=图集) / product_type ("clips"=Reels)
  ├─ caption.text / user.{username, full_name, profile_pic_url} / taken_at
  ├─ video_versions[]        # [{url, width, height, type}] ← 视频直链
  ├─ image_versions2.candidates[]  # 封面/图片
  └─ carousel_media[]        # 图集（各子项再有 video_versions/image_versions2）
```

**直链匿名下载实测**：`scontent-hkg4-1.cdninstagram.com/...` 不带任何 cookie Range 下载 **206 `video/mp4`，ISO MP4 字节头正确**【实测】。

**失败态判别**：shortcode 无效/已删时也返回 200，但带 `errors: [{message: "execution error", path: ["xdt_api__v1__media__shortcode__web_info"]}]`（实测两个无效 code 均如此）【实测】——实现层必须按 `errors` + `items` 双判，别把 execution error 当成通道挂了。

### 2.4 代价与风险

| 风险 | 说明 | 应对 |
|---|---|---|
| `doc_id` 轮换 | IG 前端发版会换 doc_id（2026-06 废弃过一次旧值） | doc_id 配置化（env `IG_DOC_ID`，默认 `27128499623469141`），挂 instaloader/galley-dl 的更新节奏；当前值经 instaloader 主干（2026-10-24 更新）核对仍在用【源码】 |
| 机房 IP 风控 | 本机香港机房 IP 实测通；中国大陆云机房 IP 表现未知【未核验】 | 解析走代理出口（§5） |
| 分辨率档位少 | 实测这条只有 640×360 三档（源片低清）；高清源应有更多档 | 取 `video_versions` 全列表，按 width/height 出 variants |
| 账号风险 | **零**——全程无账号无 cookie，不存在封号问题 | 保持「不收用户 cookie」的产品线即可 |

**值不值得做：值得。** 对比 02 号的「只能用户自带 cookie」判断，现在是「无凭据、单 POST、字段干净」的通道，维护成本只剩 doc_id 轮换一件事。**不要做 cookie 模式**（账号风险与运维成本都高一档，且已无必要）。

---

## 3. 微信视频号（维持旧结论：不能做）

对 GitHub 近半年（2026-04-26 之后创建）的「wechat channels video」类仓库做了全量搜索（31 个结果）并抽查最新的两个【实测/源码】：

| 仓库 | 创建 | 路线 |
|---|---|---|
| `changtimwu/wechat-video-downloader` | 2026-10-16 | mitmproxy 从**桌面客户端**抓 feed → Isaac64 密钥流解密前 131072 字节（`decodeKey`）；URL 与 `urlToken` 每次响应一起轮换 |
| `MuZiJin701/wechat-channels-downloader` | 2026-10-21 | **扫码登录** + 粘贴分享链接 |
| `Evil0ctal/WeChat-Channels-Video-File-Decryption` | 常青 | 只做解密不取流（⭐394，MIT，2026-06-10） |

- 02 号记录的结构性封死（无公开 Web 播放页、流地址绑微信会话、文件加密）**无任何变化**：新工具全部依赖登录态/客户端抓包，`decode_key` 机制原样。
- 免登录取流仍然只有付费聚合 API（TikHub 等）一条路。

**结论：不做。** 确定性封死，排期不进任何版本。

---

## 4. TikTok（能做：走第三方/自托管通道）

### 4.1 官方 web 端：不建议走

`https://www.tiktok.com/@charlidamelio` 从机房 IP 请求返回 **1 462 B 的 slardar WAF 挑战页**【实测】。官方 web API 对数据中心 IP 挑战严格，签名/验证演进快，与抖音 web API 同款麻烦且更甚——不推荐直接对接。

### 4.2 tikwm（第三方免费接口）：实测通

```
GET https://www.tikwm.com/api/?url=https://www.tiktok.com/@nasa/video/7665075736742530317
→ 200, {"code":0,"msg":"success","data":{ title, author.unique_id, play, duration:25, size:3356735, cover, music, ... }}
```

- `data.play` 是**无水印直链**（`v16m.tiktokcdn-us.com/...`），Range 下载 **206 `video/mp4`，ISO MP4**【实测】。
- 同时给 wmplay（带水印）、封面、音乐、时长、大小。
- **代价与风险**：第三方免费服务，无 SLA、有限流（社区口径约 1 r/s【未核验】）、随时可能关停或收费；中国大陆云服务器直连 tikwm 的可达性【未核验】——按走代理规划。

### 4.3 Evil0ctal/Douyin_TikTok_Download_API（自托管路线）

- `Evil0ctal/Douyin_TikTok_Download_API`，⭐20894，Apache-2.0，2026-10-21 仍在更【实测 API】。定位：自托管数据 API（Douyin/TikTok/Bilibili），**自维持身份池**（cookie/设备池），REST + MCP + Web 控制台。
- 比 tikwm 重（要跑服务、维护身份池），但不依赖第三方存续。Apache-2.0 可引用其接口实现思路。

### 4.4 与抖音 adapter 共用架构的可行性

**可行，且改动很小**：

- `PlatformAdapter` 接口（`match/resolve/fetch/parse`，fetch 唯一 IO）天然容纳 TikTok：新 `Platform` 枚举值 + `hosts` 白名单（`www.tikwm.com` 或自托管域名）即可。
- tikwm 路线的 `parse()` 就是 JSON 字段映射（title/author/play/cover/music → `ParseResult`），与抖音 adapter 的形态同构。
- **架构决策留给实现卡**：TikTok 走「第三方聚合」而非平台直连，与现有四个国内平台的「直连平台 API」模式不同——`via` 字段建议区分归因（如 `'api'` 外新增 `'third-party-api'` 或并入 `RawPayload.via` 的语义）。
- 时效：tikwm 直链是 tiktokcdn 签名 URL，会过期——照 YouTube 套路回填 `expiresAt`。

---

## 5. 出站代理基础设施

### 5.1 Bun fetch 的代理行为（实测 bun 1.3.10 + 官方文档【源码】）

| 机制 | 行为 | 验证 |
|---|---|---|
| 环境变量 | 全局 `fetch()` **每次调用时**读 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（大小写皆可）：`http://` 目标用 `HTTP_PROXY`，`https://` 用 `HTTPS_PROXY`，未设 scheme 专用时 `ALL_PROXY` 兜底 | **【实测】**：自建 CONNECT 代理日志出现 `CONNECT checkip.amazonaws.com:443`，脚本内纯 `fetch()` 零代理代码 |
| per-request | `fetch(url, { proxy: 'http://host:port' })` **覆盖环境变量**；`proxy: false` 强制直连 | **【实测】**：`{proxy}` 请求 200；googlevideo 流式下载经 `{proxy}` 206 |
| NO_PROXY | `NO_PROXY`/`no_proxy` 列表绕过（逗号/空格分隔）；`respectNoProxy: false` 可强制走代理 | 【源码：Bun 文档】 |
| socks5 | **不支持**——值为 `socks5://` 会被忽略 | 【源码：Bun 文档】 |
| 运行时切换 | `process.env` 改动对**下一次** fetch 生效 | 【源码：Bun 文档】 |

对照：Node 的 fetch **不**读这些环境变量（Bun 与 curl 一致、与 Node 不同）——Bun 部署形态下不用 undici ProxyAgent 之类的包装。

### 5.2 按平台走不同出口（env 形态建议，实现卡照抄）

```bash
# ---- .env（部署机）----
# 默认出站：海外平台（YouTube / Instagram / TikTok）走这里
OUTBOUND_PROXY=http://<user>:<pass>@proxy-host:port

# 按平台覆盖（可选；缺省回落 OUTBOUND_PROXY）
PROXY_YOUTUBE=http://<user>:<pass>@yt-proxy:port
PROXY_INSTAGRAM=
PROXY_TIKTOK=

# 保底（不设 OUTBOUND_PROXY 时 Bun 自己也会读）
# HTTPS_PROXY=http://...
```

解析顺序（单函数，全局唯一）：

```ts
// src/infra/proxy.ts（建议新增，10 行内）
export function resolveProxy(platform: Platform): string | undefined {
  const byPlatform = process.env[`PROXY_${platform.toUpperCase()}`];
  return byPlatform || process.env.OUTBOUND_PROXY || process.env.HTTPS_PROXY;
}
```

配套硬规则：

1. **海外 adapter 的所有 fetch 显式传 `{ proxy: resolveProxy(platform) }`**——不依赖进程级环境变量（国内平台同进程直连会被误带入代理）。`FetchCtx` 可以加一个 `proxy?: string` 由 infra 注入，保持「平台层 fetch() 是唯一 IO」不变。
2. **`/media` 中转必须用解析该资源的同一 proxy**（YouTube 硬要求，见 §1.3）。`/media` 签名载荷里**带上 platform**（或直接带解析时的 proxy 标识），`fetchUpstream()` 据此选出口——两处出口不一致是纯浪费带宽的 403。
3. **国内四平台显式直连**：`{ proxy: false }` 或不传（部署机不设全局 `HTTPS_PROXY` 时即直连）。推荐在 `resolveProxy` 返回 `undefined` 时显式 `proxy: false`，把「直连」变成显式行为，避免运维误设全局变量把抖音流量也送进代理。
4. 代理认证走 URL 内嵌 `user:pass@`（Bun 原生支持【源码】）；**密钥走 env/secret 注入，不进仓库、不进日志**。

### 5.3 puppeteer 的代理注入点（infra/browser.ts）

当前 `src/infra/browser.ts` 的 `getBrowser()`：

```ts
puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})
```

注入点就在这 `args`：追加 `--proxy-server=${BROWSER_PROXY}`（env 可选；浏览器通道目前只服务小红书 TLS 指纹，与 fetch 代理独立配置）。注意：

- Chrome 的 `--proxy-server` **不吃 URL 内嵌认证**，带账密代理要走 `page.authenticate({ username, password })`【未核验：实际注入效果】。
- 浏览器通道与海外三平台无关（YouTube/IG/TikTok 全部纯 fetch，不用浏览器）——别把 `BROWSER_PROXY` 和 `resolveProxy()` 混成一个变量，出口 IP 信誉要求不同（小红书要住宅感 IP）。

### 5.4 部署侧提醒

- 部署目标是中国云服务器：googlevideo / instagram / tiktok 直连不通或极慢，**出站代理是硬前提**，不是优化项。
- 本机开发的 Clash 是 TUN 全局接管，环境变量设不设出口相同（实测两者出口 IP 相同）——本地验证「代理生效」要像本卡一样自建打点代理，别用「设了 env 能不能下载」当判据。
- IP 一致性约束（解析 IP=下载 IP）在 TUN 下被天然满足（同一出口），**部署机上才是真考点**：解析与 `/media` 中转的代理出口必须同一，且该出口的 IP 信誉影响 bot 检查命中率（YouTube）。

---

## 6. 参考开源实现

| 仓库 | License | 最近更新 | 对本项目的用法 |
|---|---|---|---|
| `LuanRT/YouTube.js`（npm `youtubei.js`） | MIT | 2026-10-23（⭐5391） | **主推**：YouTube 解析（§1.5），fetch 注入代理 |
| `yt-dlp/yt-dlp` | Unlicense | 2026-10-23（⭐201969） | client/PO Token 攻防情报源（client 现状表），不引入 |
| `imputnet/cobalt` | **AGPL-3.0** | 默认分支 2026-04-06（⭐45437；活跃开发在兼容分支 `zImPatrick/cobalt`） | 手写 innertube 路线参考；ONESIE/动态 PoToken 方案参考。**AGPL 传染，只读思路不抄码** |
| `mikf/gallery-dl` | GPL-2.0 | 2026-10-25（⭐20236） | IG GraphQL `doc_id` 发现源（issue #9564，2026-07 测试通过） |
| `instaloader/instaloader` | MIT | 2026-10-24（⭐13679） | IG `doc_id` 当前值跟踪（`structures.py` 仍用 `27128499623469141`【源码】） |
| `Evil0ctal/Douyin_TikTok_Download_API` | Apache-2.0 | 2026-10-21（⭐20894） | TikTok 自托管路线参考（§4.3） |
| `Evil0ctal/WeChat-Channels-Video-File-Decryption` | MIT | 2026-06-10（⭐394） | 视频号解密参考（不排期） |
| tikwm（`tikwm.com/api`） | —（第三方服务） | — | TikTok 快速通道（§4.2） |

情报补充【未核验】：cobalt issue #1475 评论区（2026-09-28）称 ANDROID_VR 媒体直链被 403、其 PR #1581 改用 `VISIONOS`/默认 `IOS`；`zImPatrick/cobalt` 用 `TV_SIMPLY` + 动态 PoToken + ONESIE。与本卡 2026-10-26 ANDROID_VR 直链 206 的实测并存——按动态攻防对待（§1.2 结论 2）。

---

## 7. 给实现卡的落地清单（可执行结论）

**YouTube 卡**：

1. 依赖 `youtubei.js@^18`；`Innertube.create({ fetch: proxiedFetch })`，`proxiedFetch` 注入 `{ proxy: resolveProxy('youtube') }`。
2. 解析链：`getBasicInfo(id, { client: 'ANDROID_VR' })` 失败（LOGIN_REQUIRED/UNPLAYABLE）→ 换 `{ client: 'IOS' }`；两条都挂才报错。client 顺序做成配置。
3. 输出：1080p 优先映射到 `MediaAsset.variants`（137 avc1 + 140 mp4a 音轨用 `audioUrl`）；itag 18 判定为「已合并」直接出单 URL；`expiresAt = parsedAt + 21540`（以响应 `expiresInSeconds` 为准）。
4. **直链绝不下发**：只走 `/media` 签名中转；`allowedHosts()` 加 `*.googlevideo.com`；中转 `fetchUpstream()` 用同一 proxy。

**Instagram 卡**：

1. 两步流：GET `/` 收 `csrftoken` → POST `/graphql/query`（`X-IG-App-ID: 936619743392459` + `X-CSRFToken` + Cookie），`doc_id` 从 env `IG_DOC_ID` 读（默认 `27128499623469141`）。
2. `parse()` 映射：`video_versions[]` → variants；`image_versions2.candidates[]` → 图/封面；`carousel_media[]` → 图集；`media_type` 判 kind。
3. 错误判别按 `errors` + `items` 双判（无效 shortcode 也 200 + execution error）。
4. 不做 cookie 模式；`hosts` 白名单加 `www.instagram.com`、`scontent-*.cdninstagram.com`。

**TikTok 卡**：

1. v1 走 tikwm：`GET /api/?url=` 一次出全；限速 ≤1 r/s；失败提示「通道暂时不可用」。
2. `hosts` 白名单加 `www.tikwm.com`、`*.tiktokcdn-*.com`；直链回填 `expiresAt`。
3. v2 备选：Evil0ctal 自托管（Apache-2.0），留架构位不排期。
4. 平台枚举、`RawPayload.via` 归因语义在本卡定夺后写死。

**代理基建（可并入上面三张或独立小卡）**：

1. 新增 `src/infra/proxy.ts` 的 `resolveProxy()`（§5.2 原样）；`FetchCtx` 增加 `proxy?: string` 注入。
2. `/media` 签名载荷带 platform；`fetchUpstream()` 按 platform 选出口。
3. 国内平台显式 `proxy: false`。
4. `infra/browser.ts` launch args 追加可选 `--proxy-server=${BROWSER_PROXY}`（独立变量）。

---

## 8. 未能核验 / 后续待办

- ANDROID_VR 媒体直链 403（cobalt 2026-09 报告）与本卡 206 实测的差异触发条件；`VISIONOS` client 的表现（本次未测）
- IG `doc_id` 轮换频率统计；中国大陆云机房 IP 下 IG GraphQL / TikTok tikwm 的风控与可达性
- youtubei.js 的 PO Token 挂载点实际接 BotGuard 后的效果（本次全程未用 PO Token）
- YouTube 会员/年龄限制视频在 IOS/ANDROID_VR 的 playability
- puppeteer 带账密代理的实际注入效果（§5.3）
- tikwm 限流的准确数值（社区口径约 1 r/s）
