# 04 · 小红书纯 HTTP 通道：TLS 指纹伪装在 Bun 下的 2026 可行方案

> 调研时间：**2026-10-26 00:40–01:35 CST**
> 目标：为「小红书改纯 HTTP 通道」找 Bun/TS 进程内的 TLS 指纹伪装方案，回答：推荐通道与集成形态、失败模式与降级信号、Docker 镜像瘦身空间、影响面清单。
> 标注约定：**【实测】**= 本文调研时用真实请求得到的返回；**【源码】**= 读了对应开源仓库/包内容；**【推断】**= 由实测数据推出的解释，未直接验证；**【未核验】**= 二手资料或未复现，落地前需自测。

---

## 0. 结论速览

**核心发现（推翻 02 §1 的前提）：小红书的放行门不是 TLS 指纹，是三个请求头。** 2026-10-26 实测，普通系统 curl（JA3 是 curl 自己的，不是 Chrome）只要带上「浏览器形态 User-Agent + Accept（非 `*/*`）+ Accept-Language」三件套，`/explore` feed 页和 note 详情页就 200 返回完整 `__INITIAL_STATE__`；反过来，Chrome 级 TLS 指纹客户端（impit）**不带**这三个头照样 302 登录墙。02 §1.2 当年「curl 302、curl_cffi 200」的对照，混淆变量是请求头不是握手指纹——curl_cffi 模拟 Chrome 时会带出浏览器默认请求头集（**【推断】**，未直接复验 curl_cffi）。

| 问题 | 答案 |
|---|---|
| ① 推荐通道 | **Bun 原生 `fetch` + 三件套头 + `xsec_token` 原样**。零依赖、零原生二进制、arm64/linux 天然可用。若要留指纹保险（防小红书重新收紧），加装 **impit**（进程内、预编译二进制、linux-musl 有包可进 alpine） |
| ② 失败模式 | 302→`/login`（头/UA 被拒）、302→300031（token 失效或不配对）、302→300012（IP 风控，与指纹无关）、200 无 `__INITIAL_STATE__`（结构变化）。任一风控信号连续 2 次 → `ctx.browser` 兜底 |
| ③ Docker 瘦身 | 指纹库本身几乎不占体积；真正的问题是「浏览器兜底还要不要」。全去掉 → 镜像约 **260MB 量级**（495−233，**【推断】**未构建实测）；保守方案是 HTTP 主通道 + 浏览器兜底双通道并存，镜像不动 |
| ④ 影响面 | `xhs/adapter.ts`（fetch 改 HTTP）、`xhs/parse.ts` 不动、`infra/browser.ts` 保留作兜底、Dockerfile 仅在决定删兜底时动、`/media` 的 `UPSTREAM_HEADERS` **不需要**新 referer 矩阵（xhscdn 不带 Referer 的规则已实测，与通道无关） |

---

## 1. 实测环境与方法

| 项 | 值 |
|---|---|
| 时间 | 2026-10-26 00:40–01:35 CST |
| 机器 | macOS 15.7.7（arm64），Bun 1.3.10，Node v26.7.0，系统 curl 8.7.1（SecureTransport/LibreSSL） |
| 出口 | 直连 + 本地代理（端口已脱敏，香港出口）。两个出口行为一致 |
| 测试靶子 | ① `/explore` feed 页；② 8 条真实 note 链接（feed 里现取的带 `xsec_token` 配对链接，视频/图文混合）；③ 3 条真实 `xhslink` 短链（2026-09/10 公开分享链） |
| 判断手段 | HTTP 状态码 + Location + body 是否含 `__INITIAL_STATE__` / `noteDetailMap[id].note` 真数据（与 02 §0.1 同标准） |
| 对照组 | 系统 curl 裸请求 → 302 登录墙（02 的判定标准）【实测】 |

---

## 2. 核心发现：放行门 = 请求头三件套，不是 TLS 指纹

### 2.1 头二分矩阵（`/explore`，每格 3–5 次重复，全部稳定同结果）【实测】

| 请求头 | UA 形态 | 结果 |
|---|---|---|
| 裸 curl（无自定义头） | curl | **302** 登录墙 |
| 仅 UA（Chrome 形态） | 浏览器 | **302** |
| UA + `Accept: text/html…` | 浏览器 | **302** |
| UA + `Accept-Language` | 浏览器 | **302** |
| UA + `Upgrade-Insecure-Requests: 1` | 浏览器 | **302** |
| UA + Accept + UIR | 浏览器 | **302** |
| UA + Accept + Accept-Language | 浏览器 | **200**，feed HTML 178KB，29 条带 token 笔记链接 |
| 无 UA（curl 默认） + Accept + AL | curl | **302** |
| UA=`MyBot/1.0` + Accept + AL | 非浏览器 | **302** |
| UA=`python-requests/2.31` + Accept + AL | 非浏览器 | **302** |
| UA + `Accept: */*` + AL | 浏览器 | **302** |
| UA + `Accept: application/json` + AL | 浏览器 | **200** |
| UA + Accept + `Accept-Language: en-US` | 浏览器 | **200** |

门的精确刻画：**UA 必须是浏览器形态（Chrome 字样），Accept 必须在场且不是 `*/*`，Accept-Language 必须在场**；Accept/AL 的值不挑；`Upgrade-Insecure-Requests`、`Sec-Fetch-*`、Referer、Cookie 全部无关。Note 详情页（带配对 token）的二分结果与 feed 页完全一致【实测】。

### 2.2 TLS 指纹无关的决定性反例【实测】

| 请求 | TLS 指纹 | 头 | 结果 |
|---|---|---|---|
| 系统 curl（JA3=curl 自己的） | 非 Chrome | 三件套全 | **200 DATA** |
| Bun 原生 fetch（uSockets/BoringSSL，非 Chrome） | 非 Chrome | 三件套全 | **200 DATA** |
| impit `browser:'chrome'` | Chrome 级 | **只给 UA，无 Accept/AL** | **302 登录墙** |

同一批链接、同一个出口，指纹好但头缺 = 拦，指纹差但头齐 = 过。**握手指纹不参与放行判定**（至少当前如此）。

### 2.3 与 02 §1 记录的差异复盘

- 02 §1.2 实测「普通 curl + 浏览器 UA + Referer + 完整 cookie，带 token → 302」——该请求**没有** Accept/Accept-Language，与本文「UA + Accept + AL → 200」完全相容：当年被拦是头不齐。
- 02 §1.2 实测「curl_cffi impersonate=chrome 零 cookie → 200」——curl_cffi 模拟 Chrome 时会发出浏览器默认请求头集（含 Accept/Accept-Language 一类）**【推断】**；变量是头不是 JA3。
- 结论「决定生死的是 TLS 指纹」应更正为：**决定生死的是浏览器形态请求头三件套**；TLS 指纹是 curl_cffi 实验里的混淆变量。
- 时效警告：小红书的门槛显然会动态调整（02 时代 vs 本文时代已不同）。若日后重新上 TLS 指纹校验，本文 §3 的指纹库就是保险方案。

### 2.4 其余边界（全部【实测】）

- **`xsec_token` 仍是硬门槛**：note 链接不带 token → 302 → `/404/sec_…?error_code=300031`；token 与 noteId 必须配对（沿用 02 结论，本文复验了「无 token」一支）。
- **短链展开比 02 §1.7 记录的更宽松**：真实 `xhslink.com` / `xhslink.cn` 短链**裸 curl** 就 302 → `https://www.xiaohongshu.com/discovery/item/<id>?…&xsec_token=…`（Location 带完整 token）。「展开必须走 TLS 伪装」不再成立；落地页本身仍要三件套头。短链域名两种都真实有效（.com 桌面分享 / .cn iOS 分享）。
- **IP 风险（300012）是独立维度**：本机直连与代理出口全程未触发；本次用云浏览器打开 `/explore` 撞到一次 `300012 IP at risk`。与 02 结论一致：指纹/头过了但 IP 被风控也是「通道可行」，分开判定。
- 首次访问速度：curl/fetch 单次 note 页 **0.2–0.5s**，浏览器通道 12s 超时预算（02/现状实现），HTTP 通道快 1–2 个数量级。

---

## 3. 候选库逐个实测（Bun 1.3.10，真实 note 链接）

统一测试：`GET /explore/<id>?xsec_token=…` + 三件套头，看 200 后 body 里 `noteDetailMap[id].note` 是否有真数据（DATA）。安装走 npm（国内镜像）。

| # | 候选 | 安装 | Bun 下运行 | 结果 | 体积/二进制 | 跨平台 |
|---|---|---|---|---|---|---|
| 1 | **impit** 0.14.7（Apify，[apify/impit](https://github.com/apify/impit)） | ✅ 8 包 120s | ✅ | **200 DATA**（feed 202ms） | optionalDependencies 预编译原生二进制（每个平台约 2–5MB 级 **【未核验】**精确值） | darwin/linux(win) × x64/arm64 × gnu/**musl** 全覆盖（README 兼容表【源码】） |
| 2 | **node-tls-client**（bogdanfinn tls-client 的绑定，[Sahil1337/node-tls-client](https://github.com/Sahil1337/node-tls-client)） | ✅ | ✅ | **200 DATA**（首跑 52s：解压 Go 共享库；之后常规） | 拖 per-platform Go 共享库（自动解压到缓存） | 包内共享库覆盖主流平台【源码】 |
| 3 | **impers** 0.x（lexiforest，curl-impersonate 的 Koffi 绑定，[lexiforest/impers](https://github.com/lexiforest/impers)，151★） | ✅ | ❌ **Bun 进程崩溃** | 未测到 | Koffi + curl-impersonate dylib | 未核验 |
| 4 | **wreq-js** 3.2.0（Rust wreq 绑定，[sqdshguy/wreq-js](https://github.com/sqdshguy/wreq-js)，414★） | ✅ | ✅ 不崩 | **302 登录墙**（headers 三种传法均如此，原因未定位；疑似其 profile/默认头覆盖自定义头） | napi-rs 预编译原生模块 | 未核验 |
| 5 | **ja3-client** 1.3.1（Go `libja3-client` 经 Koffi，2026-10-18 发布） | ✅（首用拉预编译 dylib 16s） | ✅ 不崩 | **200 但落登录/风控页**（36KB SPA，无 `noteDetailMap`）——等效被拦 | Koffi + Go dylib（首用下载） | 未核验 |
| 6 | **node-curl-impersonate** 1.5.4（curl-impersonate 二进制包装） | ✅ | ✅ 不崩 | **冒烟无响应**（response 空、headers 空） | 自带 curl-impersonate 二进制：**只有 darwin-x86 / linux-x86 / linux-aarch64，无 darwin-arm64**【源码】 | 缺 arm64 mac |
| 7 | **tls-client** 0.0.5（npm「Node-TLS-Client」，ffi-napi） | ❌ **装不上**：ffi-napi 构建脚本 exit 1 | — | — | ffi-napi 原生编译 | — |
| 8 | **cycletls** 2.0.5（Danny-Dasilva/CycleTLS，JS+Go） | ⏳ **安装卡死**：postinstall 拉 Go 引擎 10 分钟+未完成（网络/墙） | — | — | 依赖 postinstall 下载 Go 引擎 | 未核验 |
| 9 | **tls-impersonate**（httptoolkit，[httptoolkit/node-tls-impersonate](https://github.com/httptoolkit/node-tls-impersonate)） | ✅（postinstall 被 bun 拦） | 未实测：要求 Node ≥ 24.15 的 `node:tls` SecureContext，Bun 的 node:tls 不满足 **【未核验】** | — | native 预编译 | Node-only 嫌疑 |

补充观察：

- impers 的崩溃是 Bun 侧硬伤：Koffi NAPI 模块调用 `uv_poll_init_socket`，Bun 1.3.10 直接 panic（[bun#18546](https://github.com/oven-sh/bun/issues/18546)）【实测】。Koffi 系（impers、ja3-client）里 ja3-client 能跑是因为它避开 poll 路径——这类库在 Bun 下的稳定性只能逐个试。
- wreq-js/ja3-client 虽然没过，但注意：**它们的失败与指纹无关**（curl 无指纹都过）；过不过取决于有没有把三件套头发对。它们在此表里是「Bun 集成可用性」答案，不是「小红书答案」。
- 2026 年新方案检索（npm/GitHub "tls fingerprint fetch bun" 等）：值得记录的有 **impit**（Apify，2026-10-22 仍在发版）、**wreq-js**（Chrome 149 档）、**ja3-client**（2026-10-18 上线）、**impers**（curl_cffi 的 TS 移植）、[httptoolkit/node-tls-impersonate](https://github.com/httptoolkit/node-tls-impersonate)（任意 ClientHello 重放）。Go 侧 [sardanioss/httpcloak](https://github.com/sardanioss/httpcloak)（1.3k★）活跃但需 sidecar/编译内嵌【未核验】。

### 3.1 sidecar 容器方案（只评估，不实测）

yifeikong/curl_cffi（Python）HTTP 包装成内部服务：功能最稳（02 §1 已实测 curl_cffi 过小红书），但代价是**多一个进程/容器 + Python 运行时 + 进程间 HTTP 开销 + 健康检查/重启策略**，且 Docker 镜像省下的 233MB 被 Python 运行时吃回去一截。在「Bun 进程内已有两条能跑的路」（fetch / impit）面前，sidecar 属于最后兜底选项，不推荐。

---

## 4. 结论与建议

### ① 推荐通道与集成代码形态

**主推：Bun 原生 `fetch`，零依赖。** 集成形态（`xhs/adapter.ts` 的 fetch 里替换 `ctx.browser.getDocumentHtml`）：

```ts
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const res = await fetch(url.href, {
  redirect: 'manual',
  headers: {
    'user-agent': UA, // 必须浏览器形态（curl/python 形态 UA 会 302）
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', // 必须在场且非 */*
    'accept-language': 'zh-CN,zh;q=0.9', // 必须在场
  },
  signal: ctx.signal,
});
// 302 Location 判定见 §4.2；200 后 body 直接喂 parseNote（__INITIAL_STATE__ 路径不变）
```

- **不拖任何原生二进制**；arm64 / linux / musl 天然可用（Bun fetch 是运行时自带）。
- 短链 `xhslink.com/.cn`：同样裸 fetch 跟 302 从 Location 抠 `(?:explore|discovery/item)/([0-9a-f]{24})` 与 `xsec_token` 即可（现行 `match()` 的 `needsResolve` 分支可顺带补上 `resolve()`）。
- **指纹保险（可选）**：`bun add impit`，`import { Impit } from 'impit'`，`new Impit({ browser: 'chrome' })` 后 `impit.fetch(url, { redirect: 'manual', headers })`——API 与 fetch 同形，同样请求头下 200 DATA【实测】。它带 per-platform 预编译二进制（含 linux-musl arm64/x64，alpine 可用），darwin arm64/x64 也有。只在「小红书重新上 TLS 校验」时才有价值，**现在装属于买保险**。

### ② 失败模式与降级判定信号

| 信号 | 判定 | 处置 |
|---|---|---|
| 302 → `/login?redirectPath=…` | 头/UA 被拒（或日后指纹收紧） | 重试 1 次（换连接）仍如此 → 切 `ctx.browser` 兜底，`channel_downgrade_total` |
| 302 → `/404/sec_…?error_code=300031` | token 失效 / 与 noteId 不配对 | 不重试；短链重新展开拿新 token 一次；仍失败返回 NOT_FOUND 类错误 |
| 302 → `/website-login/error?…error_code=300012` | **IP 风控**，与指纹/头无关 | 归 RISK_CONTROL（与 t_7e949351 分类对齐）；换出口无效时降级无意义，直接报错 |
| 200 但无 `__INITIAL_STATE__` 或 `noteDetailMap[id].note` 空 | 页面结构变化 / 拿到壳页 | 归 UPSTREAM_CHANGED，切浏览器兜底验证 |
| 连接层错误（DNS/超时/RESET） | 网络抖动 | 现有重试策略 |

降级判定建议：**HTTP 通道连续 2 次命中前三类信号 → 浏览器兜底**；兜底成功后本周期内该平台固定走浏览器（避免反复横跳）。

### ③ Docker 镜像瘦身

前提厘清：chromium 的 233MB 是为「浏览器兜底/主路径」服务的，不是为指纹库。两条路：

- **保守（推荐先走）**：HTTP 主通道 + 浏览器兜底并存——`xhs/adapter.ts` fetch() 先走 §4.1 代码，风控信号出现时 `ctx.browser` 兜底（沿用 t_7e949351 降级模式）。**镜像不动（495MB）**，puppeteer/chromium/infra/browser.ts 全保留。
- **激进**：确认兜底不需要后，删 puppeteer 依赖 + chromium 包 + `infra/browser.ts` 主路径，镜像 ≈ **260MB 量级**（495−233，按 README 体积构成推算 **【推断】**，未构建实测）。建议实测构建体积后再定（child 卡 t_c7f4adad 只做保守路线，激进路线留给主会话决策）。

### ④ 影响面清单

| 文件 | 影响 |
|---|---|
| `src/platforms/xhs/adapter.ts` | **主要改动点**：`fetch()` 从 `ctx.browser.getDocumentHtml` 改为 HTTP 通道（§4.1 代码形态）；`via` 标 `'http'`；`needsResolve` 分支可补 `resolve()`（短链裸 fetch 可展开）；`capabilities.http: false` 需改 `true` |
| `src/platforms/xhs/parse.ts` | **不动**（`__INITIAL_STATE__` 路径不变，HTTP 与浏览器拿到的 body 同构） |
| `src/infra/browser.ts` | 保留作兜底（保守方案）；激进方案才动 |
| `Dockerfile` | 保守方案不动；激进方案删 chromium 层 + `PUPPETEER_*` 环境（体积见 ③） |
| `src/services/media-proxy.ts` 的 `UPSTREAM_HEADERS` | **不需要新 referer 矩阵**：媒体直链下载是独立请求，xhscdn/xiaohongshu 现行规则就是「不带 Referer」（research/03 §4.1 实测：小红书 CDN 带本站 Referer 反而 403），与 note 页走哪个通道无关；三件套头结论只作用于 note HTML 获取，不必传导到 /media |
| `tests/probe-xhs.ts` / 新单测 | 适配 via 变化；指纹通道可注入 client 保持离线可测（child 卡已有约定） |

---

## 5. 遗留与风险

1. **门槛时效性**：02（10-24）与本文（10-26）行为已不同，说明小红书风控在动。上线后建议把「302 登录墙比率」当指标看；一旦出现，先查 Accept/UA 头，再考虑切 impit，最后才是浏览器兜底。
2. **curl_cffi 默认头假说**（§2.3）**【推断】**未直接复验——本机当前 python3 无 curl_cffi；要坐实可 `uv run --with curl_cffi` 做一次「impersonate=chrome 但剔除 Accept/AL」实验。
3. wreq-js 302 的根因未定位（§3 #4）；ja3-client 拿到 200 但落登录页的原因同未定位。两者不影响结论（主通道用不到它们）。
4. cycletls 安装卡 postinstall（Go 引擎下载）、tls-client(npm) ffi-napi 装不上——若未来要用，前者需预置引擎离线包，后者应直接换 node-tls-client。
