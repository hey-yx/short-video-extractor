# 02 · 各平台「不启浏览器」解析可行性调研

> 调研时间：**2026-10-24**
> 目标：为插件式多平台架构判定每个平台能否用纯 HTTP 完成解析，以及必须付出什么代价（cookie / 签名 / TLS 伪装 / 浏览器）。
> 标注约定：**【实测】**= 本文调研时用 curl / curl_cffi 对线上接口真实发请求得到的返回；**【源码】**= 读了对应开源仓库源码；**【未核验】**= 只有二手资料或未能复现，落地前需自测。

---

## 0. 评级总表

| 平台 | 评级 | 一句话 | 必需条件 |
|---|---|---|---|
| 小红书 | **纯 HTTP 可行**（有条件） | 详情页 HTML 里的 `__INITIAL_STATE__` 仍完整可用，无需 cookie | `xsec_token` + **浏览器级 TLS 指纹** |
| 快手 | **纯 HTTP 可行**（最省事） | 手机分享页 `v.m.chenzhongtech.com/fw/photo/{id}` 内嵌 `INIT_STATE`，无签名无 cookie | 仅需 photoId |
| B 站 | **纯 API 可行** | `x/web-interface/view` + `x/player/playurl` 两条接口直接出 dash/durl | 无（`try_look=1` 可拿 1080P） |
| 微博视频 | **需 cookie（访客即可）**（【勘误 2026-10-28】m 站 `statuses/show` 匿名可取，仅 `weibo.com/ajax` 与 fid 直链页 `tv/api/component` 需访客 `SUB/SUBP`，见 §4） | 访客票据 `SUB/SUBP` + Referer 后 `statuses/show` 可取 `media_info` | 访客 cookie，无需登录 |
| 微信视频号 | **基本不可行** | 无公开 Web 播放页；取流地址绑微信会话且文件本身加密 | 微信登录态或买数据 |
| YouTube / Shorts | **纯 API 可行**（走 innertube 客户端伪装） | `ANDROID_VR` client 免 PO Token、免 cookie 直接给 formats | 出口 IP 与下载 IP 必须一致 |
| Instagram Reels | **需 cookie，匿名基本不可行**（【勘误 2026-10-28】已翻案：匿名 GraphQL doc_id 通道可用，见 05 §2.3） | 网页侧全登录墙，Graph API 只能读自有专业号 | 登录 cookie（寿命短） |
| X / Twitter | **纯 API 可行（单条粒度）** | `cdn.syndication.twimg.com/tweet-result` 免 token | 只能按 id 单条取 |

---

## 0.1 实测环境与方法

| 项 | 值 |
|---|---|
| 时间 | 2026-10-24 15:50–16:10 CST |
| HTTP 客户端 | `curl` 8.x（系统自带）+ `curl_cffi` 0.13.0（`impersonate="chrome"` / `"safari"`） |
| 出口 | 本机经本地代理（端口已脱敏），香港机房出口（IP 已脱敏）；浏览器另有一次云出口 |
| UA | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| 判断手段 | 看 HTTP 状态码 + 响应体积 + 是否含目标 JSON 键（如 `noteDetailMap`/`mainMvUrls`），不做 OCR/视觉比对 |

---

## 1. 小红书（重点）

### 1.1 评级

**纯 HTTP 可行**，但有两个硬门槛：`xsec_token` 和 **TLS/HTTP2 指纹伪装**。不需要登录，不需要 `a1`/`web_session`。

### 1.2 实测证据

| 请求方式 | 结果 |
|---|---|
| 普通 `curl` + 浏览器 UA + Referer + 完整 cookie，带 `xsec_token` | **302 → `/login?redirectPath=...`** 【实测】 |
| `curl_cffi` `impersonate="chrome"`，**零 cookie**，带 `xsec_token` | **200，67 KB HTML，`__INITIAL_STATE__` 存在且 `noteDetailMap` 有数据** 【实测】 |
| `curl_cffi` + 完整匿名 cookie（a1/webId/gid/websectiga…） | 200，95 KB（页面更完整） 【实测】 |
| `curl_cffi` 带 token 但与笔记 id 不匹配 | 302 → `/404/sec_xxxx?error_code=300031&error_msg=当前笔记暂时无法浏览` 【实测】 |
| 完全不带 `xsec_token` | 302 → 同上 300031 【实测】 |
| 机房/云 IP（云浏览器执行 `goto('/explore')`） | 2~3 次请求后跳到 `/website-login/error?...error_code=300012&error_msg=IP at risk. Switch to a secure network and retry.` 【实测】 |
| 同一台机器经本地代理（香港机房出口）走 `curl_cffi` | 200 正常 【实测】 |

> 结论 1：**决定生死的是 TLS 指纹，不是 cookie**。同一组 header 用 curl 就是 302 登录，用 curl_cffi 冒充 Chrome 就是 200。
> 结论 2：**`xsec_token` 是必需项**，本次所有不带 token 的请求都落到 300031 安全页；生态里的实现（yt-dlp 测试用例、XHS-Downloader、parse-video）也都以带 token 的分享链接为前提。
> 结论 3：**IP 风险（300012）是信誉评分，不是硬规则**：云浏览器那次出口被判定为高危直接拦，而香港机房 IP 走 HTTP 客户端反而正常。但机房 IP 命中率明显更高，**部署时出口 IP 质量是仅次于 TLS 指纹的第二个变量**。

### 1.3 字段路径（2026-10 现状）

```
HTML 内联脚本：window.__INITIAL_STATE__ = {...}      ← 单行 JSON，注意里面有 undefined，需先转 null

note.noteDetailMap[<noteId>].note
  ├─ noteId / type ("normal" | "video") / title / desc
  ├─ time / lastUpdateTime / ipLocation / xsecToken
  ├─ user { userId, nickname, avatar, xsecToken }
  ├─ interactInfo { likedCount, collectedCount, commentCount, ... }
  ├─ tagList[]
  ├─ imageList[]           # 图集（type=normal 时 1~18 张；视频笔记也有，是封面/首帧）
  │    ├─ urlDefault      # 有 style 后缀的默认图
  │    ├─ urlPre         # 预览小图
  │    ├─ infoList[]     # [{ imageScene: "WB_PRV" | "WB_DFT", url }]  ← WB_DFT 为最佳
  │    ├─ width / height / fileId / livePhoto
  │    └─ stream          # 实况图相关
  ├─ video               # 仅 type=video
  │    ├─ media.stream.{h264|h265|av1|h266}[]   # 数组，可能为空
  │    │     ├─ masterUrl      # 直链（带 b/csig/oi/sign 签名参数）
  │    │     ├─ backupUrls[]   # 备用 CDN
  │    │     ├─ width/height/duration/videoBitrate/avgBitrate/fps
  │    │     ├─ qualityType ("HD") / streamDesc ("X264_MP4") / format
  │    │     └─ size / videoCodec / audioCodec / hdrType / rotate
  │    ├─ media.video { videoId, duration, md5, drmType, streamTypes }
  │    ├─ mediaV2       # 字符串（疑似 HLS/manifest 序列化），本次未解析
  │    ├─ image { firstFrameFileid, thumbnailFileid }   # 只有 fileId，没有 URL！
  │    └─ consumer      # yt-dlp 读 consumer.originVideoKey 拿"原片"；本次两条样本均为 null
  └─ comments（同级 wrapper 里另有 noteDetailMap[id].comments）
```

- `type` 的取值实测只有 `normal`（图文）与 `video`；`__INITIAL_STATE__.note` 下另有 `commentTarget`、`currentNoteId` 等 UI 状态，与解析无关。
- 视频封面只有 `fileId`，没有可直接下载的 URL —— 需要自己拼 `sns-webpic` 地址或用 `imageList[0]`，**【未核验】** 拼法。

### 1.4 图集 URL 规则（重要）

实测样本：

```
http://sns-webpic-qc.xhscdn.com/202610241601/<md5>/notes_uhdr/<fileId>!nd_dft_wlteh_jpg_3
http://sns-webpic-qc.xhscdn.com/202610241601/<md5>/notes_pre_post/<fileId>!nc_n_webp_mw_1
```

| 测试 | 结果 |
|---|---|
| 原样下载（不带 Referer） | **200 `image/jpeg` 145 KB** 【实测】 |
| 原样下载（带 `Referer: https://www.xiaohongshu.com/`） | 200，字节数完全相同 【实测】 |
| 去掉 `!nd_dft_wlteh_jpg_3` 后缀 | **403** 【实测】 |
| 后缀换成 `!nd_dft_wlteh_webp_3` / `_jpg_2` / `_jpg_1` / `!nd_prv_wlteh_jpg_3` | **全部 403** 【实测】 |
| 老办法 `https://ci.xiaohongshu.com/<fileId>?imageView2/2/w/0/format/jpg` | **404，已失效** 【实测】 |

> 结论：**style 后缀是 URL 路径签名的一部分，一个字符都不能改**。所以「拿原图」= 用服务端给的 `WB_DFT` 原样 URL，不要试图改尺寸/格式参数。域名可能出 `sns-webpic-qc` / `sns-webpic` / `ci.xiaohongshu.com`，按返回原样使用即可。
> 无水印问题：笔记里的图本身**不带水印**，水印是 App 内「保存图片」时叠加的，所以走 HTML 路径天然无水印。

### 1.5 视频直链与防盗链

```
masterUrl: http://sns-video-v4.xhscdn.com/stream/79/110/258/<hash>_258.mp4?b=..&csig=..&oi=..&sign=..
backupUrls: http://sns-bak-v1.xhscdn.com/stream/...（同参数 + trid）
```

| 测试 | 结果 |
|---|---|
| 无 Referer 直连 | **200 `video/mp4` 26,239,449 B** 【实测】 |
| 带 `Referer: https://www.xiaohongshu.com/` | 同上，无差异 【实测】 |

> 小红书**不做 Referer 防盗链**（图片、视频都不做）。但直链带 `sign`/`csig`/`oi` 参数，属于**时效签名**，缓存时必须存 `expires_at`（经验 24h 量级，**【未核验】** 确切 TTL），过期要重新拉详情页。

### 1.6 官方/半官方 API（`/api/sns/web/v1/feed`）

```
POST https://edith.xiaohongshu.com/api/sns/web/v1/feed
Content-Type: application/json
x-s / x-t / x-s-common / a1 cookie            ← 缺一不可
body: {"source_note_id":"<id>","image_formats":["jpg","webp","avif"],
       "extra":{"need_body_topic":"1"}}
```

- 实测**不带签名**直接 POST：`HTTP 406`，body `{"code":-1,"success":false}` 【实测】。这就是"签名缺失"的标准表现。
- 需要的 header：`x-t`（毫秒时间戳）、`x-s`（对 `method + uri + 参数串 + a1` 做 xhs 自定义 base64 + CRC32 得到）、`x-s-common`（浏览器环境指纹 JSON 的 base64，含 `x9`/`x10` 平台的 `window._webmsxyw` 检测值）、`a1` cookie。
- 公开实现：
  - **[Cloxl/xhshow](https://github.com/Cloxl/xhshow)** —— MIT，纯算法复现 `x-s`/`x-s-common`/`xsc`，Python，`sign_headers_post(uri, cookies, payload)` 一行出全套 header。创建于 2024-09，约 100 commits，**【未核验】** star 数。**这是目前最干净的参考实现。**
  - **[NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)** `media_platform/xhs/xhs_sign.py`（6.7 KB，JS 算法移植，内含自定义 base64 表 + 完整 CRC32 表）+ `playwright_sign.py`（调 `xhshow` 生成，注释明确写"依赖 xhshow>=0.2.0"）。**它同时保留了 Playwright 注入签名作为兜底** —— 这个双轨设计值得抄。
  - **[ReaJason/xhs](https://github.com/ReaJason/xhs)** —— MIT，2.2k star，**最后提交 2025-07-01**（已 15 个月未更新，`x-s` 算法大概率已漂移，只能当文献读）。
- **但**：如果只做「单条笔记解析」，**完全不需要这个 API**。HTML 路径已经够用，且省掉签名维护。feed 接口的价值在批量/信息流，对去水印服务不是刚需。

### 1.7 短链展开

- 域名：`xhslink.com`、`xhslink.cn`（XHS-Downloader 的 `manager.py` 里就是这两个后缀做匹配）【源码】
- 实测 3 条**陈旧**短链：`HTTP 307` → `Location: http://www.xiaohongshu.com`（无 id 参数 = 已失效）【实测】
- **有效**短链的跳转目标 **【未核验】**：按 yt-dlp 测试用例与生态共识，应为 `https://www.xiaohongshu.com/explore/<id>?xsec_token=...&xsec_source=pc_share`。落地时用「跟随 302/307，从 Location 里正则抠 `(?:explore|discovery/item)/([0-9a-f]{24})` 与 `xsec_token`」即可，不需要额外接口。
- 注意：展开也必须走 TLS 伪装，普通 curl 会被导向登录页。

### 1.8 坑（按踩坑概率排序）

1. **`window.__INITIAL_STATE__` 会在 hydration 后被删掉**。在真实浏览器里 `page.goto()` 完成后再 `page.evaluate` 读它，拿到的是 `undefined` 【实测】。必须在 `response` 事件里截原始 HTML，或用 CDP 在 document 阶段抢快照。**这也是旧 Puppeteer 方案读不到 state、只能靠拦截 `.xhscdn.com` 请求的根因。**（已过时：现行实现是纯 HTTP 直抓 `__INITIAL_STATE__`，浏览器兜底用 HTML 快照，不再拦截 xhscdn 请求。）
2. **Bun/Node 原生 fetch 做不了 TLS 伪装**。同样 header，`curl` 302 登录、`curl_cffi(impersonate=chrome)` 200 —— 差别只在 TLS/HTTP2 指纹。Bun 的 `fetch`/`undici` 无法伪造 JA3/JA4，所以小红书要么上 `curl_cffi` / `curl-impersonate` 边车进程，要么保留浏览器。**这是本次调研对架构影响最大的一条。**
3. 机房 IP → `error_code=300012 IP at risk`，与签名无关，换 header 无用。
4. JSON 里混 `undefined`（非法 JSON），解析前 `replace("undefined","null")`（yt-dlp 用 `js_to_json` 做同样的事）。
5. `xsec_token` 有归属：token 与 noteId 必须配对，串了就是 300031。

---

## 2. 快手

### 2.1 评级

**纯 HTTP 可行，且是本次调研里最省事的平台**：无签名、无 cookie、无 Referer；UA 有讲究：桌面浏览器 UA 会被 302 到 SPA 空壳，无 UA、curl 默认 UA 与移动 UA 可出完整 HTML（实现固定移动 UA，见 `src/platforms/kuaishou/adapter.ts` 注释，2026-10-25 实测）。

### 2.2 实测链路

```
① 短链展开：GET https://v.kuaishou.com/<code>
   → 302  Location: https://v.m.chenzhongtech.com/fw/photo/<photoId>?cc=share_copylink&...
                     &shareToken=X-...&shareResourceType=PHOTO_OTHER&...      【实测，无需 cookie/UA】
② 分享页：GET https://v.m.chenzhongtech.com/fw/photo/<photoId>
   → 200，163 KB HTML，内嵌 window.INIT_STATE = {...}
     ★ 连 shareToken 等参数都可以全部省略，只要 photoId                    【实测，纯 curl 无 UA】
③ 桌面页 https://www.kuaishou.com/short-video/<id>
   → 200 但只是 76 KB 的 SPA 空壳，无任何视频数据（走 GraphQL 才出）        【实测】
```

### 2.3 字段路径

`window.INIT_STATE` 是个大对象，**外层 key 做了 ASCII+1 混淆**：

```
"tusjoh.0sftu0xe0tztufn0tubsuvq@lqg"      ← 每个字符 -1 → "string./rest/wd/system/startup@jpg"
```

但**内层 photo JSON 的 key 是明文**，所以直接按子串定位即可：

```
photo.mainMvUrls[]            # 无水印主播放地址（数组，多 CDN 冗余）
  └─ { cdn: "txmov2.a.kwimgs.com",
       url: "https://txmov2.a.kwimgs.com/upic/2025/07/28/22/<hash>_b_<md5>.mp4
             ?clientCacheKey=<photoId>_b.mp4&tt=b&di=<8hex>&bp=10000" }

photo.manifest.adaptationSet[].representation[]     # 多清晰度全集，优先用这个
  └─ { url, backupUrl[], qualityType ("720p"), width, height, fileSize,
       videoId, comment: "ttExplain=HEVC_Turbo2_720P_高码率", hidden }

photo.coverUrls[] / photo.duration / photo.width / photo.height
photo.likeCount / viewCount / commentCount / timestamp
photo.photoId / photo.caption
```

- `_b_` + `tt=b` 即「无水印流」；带 `bs2/photo-video-mz/..._hd15.mp4?pkey=` 的那类是**带 pkey 签名的转码流**，也常见于页面里，但优先用 `mainMvUrls` / `representation`。
- 图集（图文笔记）走 `shareResourceType=BROWSE_SLIDE_PHOTO`，图片在 `photo.picUrls` 一类字段里 **【未核验】** 具体名（本次样本是视频）。

### 2.4 防盗链

| 测试 | 结果 |
|---|---|
| `Range: 0-2000` 直连 kwaicdn，无 Referer、无 UA | **206 `video/mp4`** 【实测】 |

→ 不做 Referer 校验。

### 2.5 签名要求

- **分享页这条路：零签名**。
- 桌面 web 的 `POST https://www.kuaishou.com/graphql`（`operationName: visionVideoDetail`，变量 `photoId`）需要 `did` cookie + `__NS_sig3` 请求签名，社区实现：[gaozhenqiang/kwai-ns_sig3](https://github.com/gaozhenqiang/kwai-ns_sig3)（JS，`kuaiShoSignCore.js`）。**没必要走这条**，分享页已经能拿到全部清晰度。
- yt-dlp **没有快手 extractor**（master 树内 `kuaishou` 命中 0 次）【源码】，所以这块必须自研，但也简单。

---

## 3. B 站

### 3.1 评级

**纯 API 可行，最干净的平台**。两条接口 + 一个 `try_look=1` 参数就能拿 1080P，不需要 SESSDATA。

### 3.2 实测

```
① 元信息（免 cookie，实测 code:0）
GET https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7
  → data.cid（默认 P1）/ data.pages[].cid|.part（分P）/ title / pic / duration / dimension
  → data.videos = 分P 数；多 P 必须逐 P 用 pages[i].cid 再取流

② 取流
GET https://api.bilibili.com/x/player/playurl?bvid=<bv>&cid=<cid>&qn=80&fnval=4048&fnver=0&fourk=1&try_look=1
  → data.dash.video[].{base_url, id, codecs, bandwidth, width, height}   # 键名 base_url（snake）为主，baseUrl 双写兼容（src/platforms/bilibili/parse.ts）
  → data.dash.audio[].{base_url, id}      # 30216≈64k / 30232≈132k / 30280≈192k
  → 或 fnval=0&platform=html5 → data.durl[0].url（单文件 MP4，format "mp4720"）
```

| 请求 | dash 实际给的清晰度 id |
|---|---|
| `fnval=4048&qn=80`（无 cookie） | 仅 `[32,32,32,16,16,16]`（480P/360P）【实测】 |
| 同上 **`&try_look=1`** | `[80,80,80,64,64,64,32,32,32,16,16,16]`（12 条，同档位多种编码，条数随抓取波动，以 `tests/fixtures/bilibili/playurl-dash.json` 为准）→ **含 1080P/720P，且该 masterUrl 实测 206 可下** 【实测】 |
| `fnval=0&platform=html5` | 返回 `durl` 单文件（`format: mp4720`）【实测】 |

- `data.quality=64` 与 `accept_description` 只是「可选档位声明」，**真实清晰度只看 `dash.video[].id`**。
- `qn` 在 DASH 下无效，改它不会变清晰度。
- **WBI 签名**：`view` 与 `x/player/playurl` 当前**不加 `w_rid`/`wts` 仍返回 `code:0`** 【实测】。但 WBI 属风控手段，随时可能收紧；实现成本低（`md5(query + wbi_key)`），建议预留。

### 3.3 防盗链

| 节点 | 无 Referer | 带 Referer |
|---|---|---|
| `*.mcdn.bilivideo.cn:8082`（PCDN） | **206** | 206 【实测】 |
| `cn-zjjh-ct-04-05.bilivideo.com` | **206** | 206 【实测】 |
| `upos-sz-estgoss.bilivideo.com`（durl） | 曾出现 **403**（疑似 URL 时效） | 也 403 【实测】 |

> 当前多数节点**不校验 Referer**，但社区长期报告 upos 会拦，且 `upos-sz-estgoss` 本次确实 403。**结论：统一带 `Referer: https://www.bilibili.com` 与浏览器 UA，成本为零（只在自己的下载请求上加），不要赌。**

### 3.4 竖屏 / Story

与普通视频**同一套接口**，差别只是 `dimension.width < height`。所谓「竖屏 feed 专用接口」**未核验**，不要凭猜写路径。

### 3.5 坑

- **`SocialSisterYi/bilibili-API-collect` 已于 2026-01-30 被作者归档（archived），标记 deprecated**。README 原文：2026-01-28 收到 B 站委托律所律师函，指控"系统性收集非公开 API 及其调用逻辑、参数结构、访问控制与安全认证机制并向公众传播"，随即停止维护并删除文档。【实测抓取】→ 文档只能靠镜像/存档，且说明**B 站开始用法律手段处理 API 文档站**，这个信号对同类项目都成立。
- 多 P 视频必须按 `pages[]` 逐个取 cid，只取 `data.cid` 会漏 P。

---

## 4. 微博视频

### 4.1 评级

**需 cookie，但访客 cookie 就够，不需要账号登录。**

### 4.2 实测链路（三步，全部验证通过）

```
① POST https://passport.weibo.com/visitor/genvisitor2
   body: cb=gen_callback&fp={"os":"1","browser":"Safari",...}
   → {"retcode":20000000,"data":{"tid":"01AQ...","sub":"_2Ak...","subp":"0033..."}}

② GET https://passport.weibo.com/visitor/visitor?a=incarnate&t=<tid>&w=2&c=095&gc=&cb=cross_domain&from=weibo&_rand=0.1
   → Set-Cookie: SUB / SUBP / SRF / SRT / SVB

③ GET https://m.weibo.cn/statuses/show?id=<mid>        # 或 weibo.com/ajax/statuses/show?id=<mid>
   Header: Referer: https://m.weibo.cn/  +  X-Requested-With: XMLHttpRequest
   → 200 {"ok":1,"data":{...}}
```

| 测试 | 结果 |
|---|---|
| 仅 UA、无 Referer / 无 cookie | **403** 【实测】 |
| 访客 cookie + `Referer` + `X-Requested-With` | **200，`ok:1`** 【实测】 |
| `weibo.com/ajax/statuses/show` 同条件 | 200，17.5 KB（无 `ok` 包裹，字段更全）【实测】 |

【勘误 2026-10-28】上表的 403 结论限定 `weibo.com/ajax` 通道。实测（2026-10-26，见 `src/platforms/weibo/adapter.ts` 注释）：`m.weibo.cn/statuses/show` 匿名可取（仅 UA + `Referer` + `X-Requested-With`，无 cookie）；`weibo.com/ajax/statuses/show` 与 fid 直链页的 `tv/api/component`（fid 换 mid）才需要访客 `SUB/SUBP`。

### 4.3 字段路径（实测返回）

```
data.page_info.type = "video"
data.page_info.object_type = 11
data.page_info.media_info.stream_url_hd   ← 主直链
data.page_info.media_info.stream_url
data.page_info.media_info.duration        ← 秒，62.9
data.page_info.page_url / url_ori / page_pic / video_orientation / play_count
data.page_info.urls                       ← 字段存在，内容需按视频类型判断（老教程里的 urls["mp4_720p_mp4"] 不可依赖）
```

### 4.4 防盗链

| 测试 | 结果 |
|---|---|
| `f.video.weibocdn.com/...mp4` 无 Referer | **206 `video/mp4`** 【实测】 |
| 带 `Referer: https://weibo.com/` | 206，字节一致 【实测】 |

> **与流行说法相反：当前微博 CDN 不校验 Referer。** 仍建议带上（零成本），但不要为了防盗链去做服务端中转。
> 顺带修正一个流传很广的说法：`page_info.urls` 并非一律为 null，本次样本里该 key 存在。

### 4.5 坑

- `getIndex?containerid=102803`（信息流）确实要真登录；`statuses/show` 不要。别把两者混在一起判断「微博要不要登录」。
- 短链 `t.cn/xxx`：直接 `curl -I` 看 302 `Location` 即可展开，不需要接口。
- 访客 cookie 有效期短（小时级），要做好自动刷新 + 失败重试。

---

## 5. 微信视频号（结论：基本不可行）

### 5.1 评级

**基本不可行** —— 不是"还没人写库"，是结构性封死：

1. **没有公开 Web 播放页**。`weixin.qq.com/sph/...` 分享页匿名访问只返回标题/作者/封面，**不返回视频 URL**。公开项目（如 `Qrzzzz/wechat-channels-downloader`）用 `MetadataOnly` 状态显式标注这一限制。
2. **取流地址与微信会话绑定**。真实响应形如：
   ```
   data.object_desc.media[0].url = https://finder.video.qq.com/251/20302/stodownload?encfilekey=...&token=...
   ```
   `encfilekey`/`token` 由客户端会话派生，且**每次请求 url 与 `decode_key` 都会变**，必须同一次响应的两者配对。
3. **文件本身是加密的**。前 131072 字节用 Isaac64 PRNG 密钥流 XOR，种子就是 `decode_key`（示例 `2136343393`）。字段：`data.object_desc.media[0].{decode_key, file_size, spec[].file_format, width, height}`。
4. `wxv_` 分享参数需要客户端环境；公开实现一律要求「扫码登录后再解析」。

**现存开源方案的定位**：`Evil0ctal/WeChat-Channels-Video-File-Decryption` 只做**解密**（输入 decode_key + 已下载的加密 mp4），不负责取流；`Qrzzzz/wechat-channels-downloader` 取流必须扫码登录（Windows、登录态存 DPAPI）。免登录取流目前只有付费聚合 API（如 TikHub 的 `wechat_channels/fetch_video_detail`）。

> 工程结论：**不要把它排进 v1**。等价于「要么维护微信登录态 + 解密链，要么买数据」。产品上建议直接不支持，或引导用户上传本地文件后只做解密/转码。

---

## 6. YouTube / Shorts

### 6.1 评级

**纯 API 可行**（无需浏览器、无需 cookie、无需 PO Token），但**出口 IP 与下载 IP 必须一致**。

### 6.2 实测（关键发现）

| 客户端 | 实测结果 |
|---|---|
| `WEB` `POST /youtubei/v1/player` | `UNPLAYABLE` / "Video unavailable"，`streamingData` 为空 【实测】 |
| `TVHTML5` | `UNPLAYABLE` / "The page needs to be reloaded." 【实测】 |
| **`ANDROID_VR`**（`clientVersion: 1.62.27`, `androidSdkVersion: 32`） | **`OK`，26 条 `adaptiveFormats`，全部带明文 `url`（0 条 `signatureCipher`）** 【实测】 |

```
POST https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8
{"context":{"client":{"clientName":"ANDROID_VR","clientVersion":"1.62.27","androidSdkVersion":32}},
 "videoId":"<id>","contentCheckOk":true,"racyCheckOk":true}

→ streamingData.adaptiveFormats[].{url, itag, mimeType, bitrate, width, height,
                                    qualityLabel, contentLength, approxDurationMs}
   + streamingData.expiringPlaybackFormat（短效广播流）
```

- 直链实测：`-L` 跟随 302 → **206 `video/mp4`** 【实测】。
- 直链里带 `ip=<解析出口 IP>&expire=<unix 秒>` → **URL 绑定请求方 IP 且会过期**。所以「解析出链接丢给前端直下」对 YouTube **必然失败**，必须服务端中转。

### 6.3 官方 Data API

只能拿元数据，拿不到直链。配额：默认 **10,000 units/天**（`search.list` 单独 100 次/天）。Shorts 无独立端点，只能靠 URL 含 `/shorts/` 或时长判断。→ 对去水印服务价值为零。

### 6.4 坑

- `WEB`/`ANDROID` 客户端现在普遍要 **PO Token**（且 token 与 videoId 绑定、一次性）。yt-dlp 的现状表：`web`/`mweb` 必须 GVS PO Token，`tv`/`web_embedded`/`android_vr` **不需要**。
- 机房 IP 会触发 "Sign in to confirm you're not a bot"；住宅 IP 明显更稳。
- `nsig`/`signatureCipher` 仍存在于部分客户端，`ANDROID_VR` 本次未触发。若换客户端就需接 JS 解扰（yt-dlp 的 `youtube/jsc/` 已把这层做成可插拔运行时）。

---

## 7. Instagram Reels

### 7.1 评级

**需 cookie；匿名路径基本不可行。**

### 7.2 实测

| 请求 | 结果 |
|---|---|
| `instagram.com/p/<code>/?__a=1&__d=dis` | **404**，返回 20.9 KB HTML（登录页）【实测】 |
| `api.instagram.com/oembed/?url=...` | **302**（跳登录）【实测】 |
| `i.instagram.com/api/v1/media/<id>/info/` | 302 到登录（多方一致） |

- **Graph API 只覆盖自有/代运营的专业号**（发布、评论、洞察），读不了任意公开账号的 Reels。
- `gallery-dl` 的 `supportedsites.md` 里 Instagram 条目认证方式明确写 **Cookies**。
- `instaloader` 4.13+ 登录态请求普遍 401（"Please wait a few minutes before you try again"），基本不可用于稳定生产。

### 7.3 坑

已登录 cookie 寿命短（数天~数周）、复用易触发 checkpoint 验证；同一 IP 高频抓取会直接锁号。→ 只能做「用户自带 cookie」模式，别做公共池。（【勘误 2026-10-28】已翻案：匿名 GraphQL doc_id 通道可用，见 05 §2.3，需配置 `IG_GRAPHQL_DOC_ID`。）

---

## 8. X / Twitter

### 8.1 评级

**纯 API 可行（单条粒度）**，零 token、零 cookie。

### 8.2 实测

```
GET https://cdn.syndication.twimg.com/tweet-result?id=<tweet_id>&token=0
→ 200，2005 B JSON
  { text, created_at, favorite_count, conversation_count,
    user { screen_name, name, avatar_url },
    entities { media[] }, mediaDetails[] }
```

- `token` **服务端不校验**（填 `0` 即可；另有 `((id/1e15)*Math.PI).toString(36)` 的公式派，同样有效）。
- 视频直链在 `mediaDetails[].type == "video"` 时取 `video_info.variants[].{url, bitrate, content_type}`（原标**【未核验】**，调研时 4 个视频推文 id 均已删除；后由 `tests/fixtures/twitter/tweet-video.json` 实证：多档 mp4 + HLS 备选）。

### 8.3 坑

- 只能按单 id 取，**没有列表能力**（旧 `timeline/profile?screen_name=` 现返回 200 空体，疑似下线）。
- 已删除/受保护推文返回 404 的 **HTML 错误页**而不是 JSON，必须判 `Content-Type` 再解析。
- 备选 `x.com/i/api/graphql/<queryId>/TweetDetail` 需要 `auth_token`+`ct0` cookie + bearer，且 queryId 随前端发版变化，维护成本高，不建议。
- 长线程/media 元数据可能缺字段，覆盖率不如官方 API。

---

## 9. 开源项目对标

star 数为 2026-10-24 抓取，其中标 ◆ 的是本次用 GitHub API 直接读到精确值。

| 项目 | 链接 | star | 最近提交 | License | 平台 | 实现方式 |
|---|---|---|---|---|---|---|
| **yt-dlp** | github.com/yt-dlp/yt-dlp | **201,165** ◆ | 2026-10-23 | Unlicense | 1700+；含 B站/微博/小红书/抖音/YouTube/IG/X；**无快手** | 每站一个 extractor 类，纯 HTTP；HTML 解析 / 站内 API / JS challenge 混合 |
| **MediaCrawler** | github.com/NanmiCoder/MediaCrawler | **67,982** ◆ | 2026-10-15 | 非商用学习许可 1.1 | 小红书/抖音/快手/B站/微博/贴吧/知乎 | Playwright 保登录态 + 站内 API/CDP |
| **Douyin_TikTok_Download_API** | github.com/Evil0ctal/Douyin_TikTok_Download_API | ~21k | 2026-10-21 | Apache-2.0 | 抖音/TikTok/B站 | 纯 Python 签名层（abogus/xbogus/websign/wbi）+ browser-rpc 兜底 + 身份池 |
| **TikTokDownloader** | github.com/JoeanAmier/TikTokDownloader | **17,077** ◆ | 2026-09-22 | GPL-3.0 | 抖音/TikTok | 自建签名层（a_bogus/X-Bogus/msToken/ttWid），cookie 必填；README 已声明加密算法不再维护 |
| **XHS-Downloader** | github.com/JoeanAmier/XHS-Downloader | **13,103** ◆ | 2026-10-23 | GPL-3.0 | 小红书 | `curl_cffi` + `impersonate="chrome146"` 抓 HTML，解析 `__INITIAL_STATE__`；cookie 可选（影响画质） |
| **parse-video** | github.com/wujunwei928/parse-video | **1,076** ◆ | 2026-08-21 | MIT | 22 视频 + 4 图集平台（含快手/小红书/B站/微博） | Go，域名映射表 + 每平台 parser，自带 HTTP 服务 |
| **xhshow** | github.com/Cloxl/xhshow | 【未核验】 | 活跃（~100 commits） | MIT | 小红书签名库 | 纯算法复现 `x-s`/`x-s-common`/`xsc` |
| f2 | github.com/Johnserf-Seed/f2 | ~2.7k | 2026-10-19 | Apache-2.0 | 抖音/TikTok/微博/YouTube/IG/X/B站/小红书 | 每平台 app 包 + JS 算法（execjs） |

### 9.1 yt-dlp 的 extractor 架构（可直接借鉴）

- 基类 `yt_dlp/extractor/common.py` 的 `InfoExtractor`；扩展点是 `_VALID_URL`（字符串或正则序列）、`_match_valid_url()`、`suitable()`、`_match_id()`、`extract()`（负责初始化/重试/异常包装），子类只实现 `_real_extract()`。
- **没有 `_extract_formats` 这个方法** —— format 以 dict 列表挂在 `info_dict['formats']` 返回；辅助函数叫 `_extract_m3u8_formats_and_subtitles` / `_extract_mpd_formats_and_subtitles`。
- 注册表是显式 import 清单 `yt_dlp/extractor/_extractors.py`；插件走 `yt_dlp/plugins.py` 的 `yt_dlp_plugins` 命名空间包。
- 各平台落点：

| 平台 | 文件 | 类 | 方式 |
|---|---|---|---|
| 小红书 | `extractor/xiaohongshu.py`（109 行 ◆） | `XiaoHongShuIE` | HTML：`__INITIAL_STATE__` → `('note','noteDetailMap',id,'note')`；视频 `('video','media','stream',...,...)` 取 `masterUrl`/`backupUrls`；另有 `('video','consumer','originVideoKey')` 求原片；图集取 `imageList[].urlDefault/urlPre`。**无 cookie 逻辑** |
| B站 | `extractor/bilibili.py` | `BiliBiliIE` | 内部 API + 自实现 `_sign_wbi()`（`md5(query+key)` → `w_rid`，key 来自 `x/web-interface/nav` 的 `wbi_img`，缓存 30s）；播放走 `/x/player/wbi/playurl`；SESSDATA 可选 |
| 微博 | `extractor/weibo.py` | `WeiboIE`/`WeiboVideoIE`/`WeiboUserIE` | 自动访客 cookie（`genvisitor`→`/visitor`）+ `weibo.com/ajax/statuses/show` |
| YouTube | `extractor/youtube/_video.py` | `YoutubeIE` | innertube player + PO token；n/sig 解密抽成 `youtube/jsc/` 可插拔 JS 运行时 |
| Instagram | `extractor/instagram.py` | `InstagramIE` | 内部 graphql/api/v1，**必须 cookie** |
| Twitter/X | `extractor/twitter.py` | `TwitterIE` | GraphQL 为主，legacy + syndication 兜底；未登录走 guest token |
| 快手 | —— | —— | **不存在**（master 树 0 命中） |

> 交叉验证价值：yt-dlp 读的字段与我实测的 XHS 字段**完全一致**，说明这条 HTML 路径是被主流工具长期验证过的，只是它没处理 `xsec_token` 与 TLS 指纹，所以经常解析失败。

### 9.2 架构启示（对插件化最重要）

1. **签名必须是注入依赖，不是 extractor 的私有方法**。TikTokDownloader 把签名拆成 `src/encrypt/` 独立包；Evil0ctal 更进一步——签名后端可替换（native / browser-rpc）、可按端点灰度、可影子比对（A-Bogus 含两个毫秒时钟无法逐字节比，只能结构比对）。yt-dlp 只有 YouTube 做到这一点，B站 WBI 是硬编码在 extractor 里的私有方法。
2. **浏览器应该降级成"兜底与标尺"**。MediaCrawler 全量浏览器（稳但重）→ Evil0ctal 只在漂移时用浏览器签名 → XHS-Downloader 干脆用 TLS 指纹冒充浏览器（最轻）。**三档成本应由配置决定，而不是由代码结构决定。**
3. **cookie 三种模型**：单账号文件（yt-dlp cookiefile）、手动粘贴（TikTokDownloader/XHS-Downloader）、身份池（Evil0ctal）。多平台长期跑，身份池 + 失效探测绕不开。
4. **注册表双轨**：yt-dlp 用显式 import 清单（保证打包与懒加载），parse-video 用域名映射表。建议 entry_points 自动发现 + 内置静态清单兜底。

---

## 10. 防盗链与中转结论汇总

| 平台 | 图片直链 | 视频直链 | 需要 Referer? | 需要服务端中转? |
|---|---|---|---|---|
| 小红书 | `sns-webpic-qc.xhscdn.com` 无 Referer 200 | `sns-video-v4.xhscdn.com` 无 Referer 200 | **否**（实测） | **否**，但链接有时效签名 |
| 快手 | `p23.a.yximgs.com` | `*.kwaicdn.com` 206 无 Referer | **否**，连 UA 都不要 | 否 |
| B 站 | `i0.hdslb.com` | `mcdn/cn-*.bilivideo` 206 无 Referer；upos 曾 403 | **建议带**（零成本） | 否 |
| 微博 | — | `f.video.weibocdn.com` 206 无 Referer | **否**（与传言相反） | 否 |
| YouTube | — | `*.googlevideo.com`，URL 内含 `ip=` | 否 | **是（必须）**：URL 绑 IP + 短时效 |
| Instagram | 需 cookie 才拿得到 | 同 | — | 是（cookie 不应暴露给前端） |
| X | `pbs.twimg.com` 公开 | 需按 variants 取 | 否 | 视业务（链接公开但会失效） |

**统一结论**：国内四家（小红书/快手/B站/微博）**都不做 Referer 防盗链**，直链可以直接给前端；真正需要服务端中转的只有 **YouTube**（IP 绑定 + 时效）和 **IG/视频号**（凭据不能下发）。但所有直链都带时效签名，**解析层必须返回 `expires_at`**，不能把 URL 当稳定资源缓存。

---

## 11. 对本项目（Bun + Elysia）的落地建议

| 平台 | 建议实现 | 依赖 |
|---|---|---|
| 小红书 | 抓 HTML → `__INITIAL_STATE__`，从 `noteDetailMap` 一次拿全（图集+视频+作者+标题），**彻底替代现在的 DOM 翻页** | **必须能伪造 TLS 指纹** → `curl_cffi`/`curl-impersonate` 边车，或保留 Puppeteer |
| 快手 | `v.kuaishou.com` 302 拿 photoId → GET 分享页 → `INIT_STATE.mainMvUrls` | 纯 `fetch` 即可 |
| B站 | `view` + `playurl(try_look=1)` | 纯 `fetch` |
| 微博 | 访客票据 + `statuses/show` | 纯 `fetch`（cookie jar） |
| YouTube | `ANDROID_VR` innertube → 服务端流式中转 | 纯 `fetch` + 代理 |
| X | syndication | 纯 `fetch` |
| IG | 只做「用户自带 cookie」（【勘误 2026-10-28】已翻案：匿名 GraphQL doc_id 通道，见 05 §2.3） | 纯 `fetch` |
| 视频号 | 不做 | — |

**extractor 接口最小集**（综合各家）：

```ts
match(url): { platform, id, kind: 'video'|'note'|'live'|'playlist', subId?, token? } | null
auth: { level: 'none'|'optional'|'required', cookieKeys?: string[], note?: string }
capabilities: { images: bool, video: bool, paging: bool, tlsImpersonation: bool }
fetchMetadata(ctx): { title, author, duration, cover, stats }
fetchResources(ctx): [{ url, type, quality, size, headers?: {Referer, UA}, expiresAt? }]
errors: AuthRequired | RiskControl | GeoBlocked | Unsupported
```

`tlsImpersonation: true` 与 `expiresAt` 是本调研新增的两个必要字段——前者决定该平台能否走共享的 HTTP 客户端，后者决定缓存策略。

---

## 12. 未能核验 / 后续待办

- 小红书**有效短链**的跳转目标（只实测了失效链 307→首页）
- 小红书视频封面从 `firstFrameFileid` 拼 URL 的规则
- 小红书视频直链的精确 TTL
- 快手**图集**笔记的图片字段名
- X 视频推文的 `video_info.variants` 实际返回
- `xhshow` 的 star 数；`Evil0ctal/WeChat-Channels-Video-File-Decryption`、`Qrzzzz/wechat-channels-downloader` 的 star/提交时间（GitHub API 触发限流）
- B 站「竖屏 feed 专用接口」是否存在
- Bun 环境下 TLS 指纹伪装的具体方案（`node-tls-client` / `cycletls` / 边车进程）需单独 spike
