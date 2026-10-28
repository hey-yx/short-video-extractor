# 抖音 / TikTok 纯 HTTP API 去水印方案调研（2026-10 版）

> 落地目标：把 `short-video-extractor` 现方案的「headless Chrome 拦截 `/aweme/v1/web/aweme/detail/` 响应」改成**不带浏览器的 HTTP 直连**，把 P95 从 1–3 s 压到 300 ms 量级，并去掉 Chrome 的 200–400 MB 常驻内存。
>
> 本文所有「实测」均为 2026-10-24 本机真实执行结果（curl / Node / Python），非二手转述。无法确证的地方标「**未核验**」，不写猜测值。

---

## 0. 结论先行

**可行，而且比预期简单得多：当前（2026-10）抖音详情接口存在一条不需要任何签名、不需要任何 Cookie 的通道。**

| 结论 | 证据 |
|---|---|
| ① `GET /aweme/v1/web/aweme/detail/` 只要带 `Origin: https://open.douyin.com`，**不传 a_bogus / msToken / ttwid / verifyFp，也返回完整 `aweme_detail`** | 本机实测 30/30 成功，直连（山东电信）与海外代理出口各测一次均 200；TTFB 0.33 s |
| ② **a_bogus 已经不足以过 `detail/`**：`a_bogus + ttwid` 组合仍然 403 `Uifid Not Found` | 实测四种组合全 403；Evil0ctal v5 源码注明同类实测 detail 仅 3/8 通过 |
| ③ 无水印视频在 `video.play_addr`（1080p），`video.download_addr` 是带抖音号水印的 720p | 实测下载两文件 + 抽帧做视觉比对确认 |
| ④ 图集/实况照片全部在同一个 detail 接口返回，`images[]` 里既有图也有 5 秒实况视频 | 实测 40 张图集 + 源码测量记录 |
| ⑤ TS 侧现成轮子：npm `abogus@2.0.0`（MIT、零依赖、2026-10-23 发布）同时提供 a_bogus / X-Gnarly / msToken / ttwid | 实测安装调用成功，`getValidMsToken()` 拿到 180 字符真实 token |

**推荐架构（按优先级降级）**：

```
L1  open-API 口子：detail + Origin: open.douyin.com      ← 0 签名 0 Cookie，覆盖 95%+
L2  web API + a_bogus + ttwid + uifid/x-secsdk-web-signature   ← 需要身份池，见 §4.4
L3  浏览器兜底（保留现有 Puppeteer 代码，仅作 1% 长尾）    ← 已存在，不删
```

L1 失效时的判定信号很明确：HTTP 403 且 body 为 `Blocked by ArgusSecurityPlugin Uifid Not Found`。监控这个字符串即可自动切换。

---

## 1. 实测环境与方法

| 项 | 值 |
|---|---|
| 时间 | 2026-10-24 15:50–16:05 CST |
| 直连出口 IP | 国内电信家宽出口（IP 已脱敏） |
| 代理出口 IP | 海外机房出口（IP 已脱敏） |
| UA | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| 工具 | `curl --noproxy '*'`、Node v26.7.0、Python 3.12 |

用于测试的样本作品（公开、无登录可见）：

- 视频 `7142091187963399427`（李子尘，1080p，14.9 s）
- 图集 `7668299666311970405`（40 张图）
- 图集 `7680061591601961471`（单图）
- 失效样本 `7590062598603787569`（返回 `status_self_see`）

---

## 2. 抖音 web 详情接口现状

### 2.1 端点与参数全表

```
GET https://www.douyin.com/aweme/v1/web/aweme/detail/?<query>
```

参数来自 Evil0ctal v5 的 `base_params()`（[params.py](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/platforms/douyin/params.py)）+ `aweme_id`。逐项实测必需性如下：

| 参数 | 示例值 | 必需？ | 说明 |
|---|---|---|---|
| `aweme_id` | `7142091187963399427` | **必需** | 作品 ID（`/video/<id>`、`/note/<id>`、短链解析后都能拿到） |
| `aid` | `6383` | 强烈建议 | 不带 `aid` 仍返回 200，但 `bit_rate` 从 4 档降到 2 档，且少了 `seo_info`/`danmaku_control`/`pc_need_login` 等字段——**画质阶梯会缺档** |
| `device_platform` | `webapp` | 否 | 实测不带也 200 |
| `channel` / `pc_client_type` / `version_code=190500` / `version_name=19.5.0` | — | 否 | 指纹一致性用，L1 通道可全部省略 |
| `cookie_enabled` / `screen_width` / `screen_height` / `browser_*` / `engine_*` / `os_*` / `platform=PC` / `downlink` | — | 否 | 同上。L2 通道建议补齐，与服务端风控比对时更自然 |
| `msToken` | 120/128 字符 | 否（L1） | web API 惯例参数；L1 完全不需要 |
| `ttwid` | Cookie，`1%7C...%7C<ts>%7C<sha>` | 否（L1） | L1 不需要；L2 必需（缺失直接 403） |
| `verifyFp` / `s_v_web_id` | `verify_<base36>_<uuid>` | 否 | L1 实测不需要；L2 作为指纹一致性加分项 |
| `fp` | `verify_...` 同 `s_v_web_id` | 否 | 同上，很多实现里与 `verifyFp` 同值 |
| `X-Bogus` | 28/32 字符 | **否（已过时）** | 抖音 web 现在用 `a_bogus`；`X-Bogus` 仅直播间 webcast 还在用（[ylcangel/douyin_sign README](https://raw.githubusercontent.com/ylcangel/douyin_sign/main/README.md) 明确写「x_bogus：抖音 web 直播间通讯 sign 算法」） |
| `a_bogus` | 188–192 字符 base64 | **否（L1）／是（L2）** | 见 §3 |
| `uifid`（Cookie）+ `x-secsdk-web-signature`（Header） | — | L2 必需 | 见 §4.4 |
| `Origin` | `https://open.douyin.com` | **L1 的关键** | 实测：有 Origin 无 Referer → 200；有 Referer 无 Origin → 403 |

### 2.2 三条通道实测矩阵

| # | 请求构造 | 实测结果 |
|---|---|---|
| A | `aweme_id + aid=6383`，Header `Origin: https://open.douyin.com` + `Referer: https://open.douyin.com/` | **200**，42,316 B，TTFB **0.333 s** |
| A' | 同上，去掉 `Referer` 只留 `Origin` | **200**，42,123 B → **Origin 才是开关** |
| A'' | 只留 `Referer: https://open.douyin.com/`，无 `Origin` | 403，46 B |
| A''' | 两个头都不带 | 403，`Blocked by ArgusSecurityPlugin Uifid Not Found` |
| A'''' | 不带 UA | **200**，42,122 B → L1 连 UA 都不校验 |
| B | 标准 web 参数，无 Cookie | 403，`Blocked by ArgusSecurityPlugin Uifid Not Found` |
| C | web 参数 + 新注册 `ttwid` | 403，同上 |
| D | web 参数 + 真实 `a_bogus`(192) + `ttwid` | **403，同上** |
| E | `aweme_id + aid=6383 + a_bogus`（走 L1 头） | 200 → `a_bogus` 对 L1 无副作用 |

> 复现命令（可直接跑）：
> ```bash
> curl -s -o /dev/null -w '%{http_code} %{time_starttransfer}\n' \
>   'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7142091187963399427&aid=6383' \
>   -H 'Origin: https://open.douyin.com'
> ```

**为什么会有这个口子**：`open.douyin.com` 是抖音官方「嵌入播放器」的来源域，服务端对该来源跳过 Argus 风控与 `ttwid` 要求。yt-dlp 的一个 fork 也独立发现了同一现象并把它列为第 2 级策略（[Index103000/yt-dlp tiktok_utils README](https://github.com/Index103000/yt-dlp/blob/3878b69d64ef4734fd81c7edc95e102008bb6dde/yt_dlp/extractor/tiktok_utils/README.md)）：

> 「open API：同一接口，`Origin` / `Referer` 为 `https://open.douyin.com`；只需 `aweme_id` + `aid=6383`，不需要 `a_bogus`、Cookie，1 个请求完成；决定放行的是 `Origin: https://open.douyin.com`（官方嵌入播放器的来源），服务端对它跳过 Argus 与 `ttwid` 要求；这是利用口子，随时可能被堵，所以只作兜底。」

注意它把口子当「兜底」，而我们的定位相反：**它是当前最稳的主力通道**（30/30、双出口、0 签名），把签名通道当兜底。

### 2.3 这个口子的边界（实测）

| 接口 | 带 `Origin: open.douyin.com` | 结果 |
|---|---|---|
| `/aweme/v1/web/aweme/detail/` | ✅ | 200 + 完整数据 |
| `/aweme/v1/web/aweme/post/`（作者作品列表） | ❌ | **200 但 body 长度 0**（静默拦截） |
| `/aweme/v1/web/comment/list/` | ❌ | **200 但 body 长度 0** |

所以「200 + 空 body」不是网络问题，而是被静默拒绝——这是排查时最容易误判的坑之一（详见 §7）。

### 2.4 响应结构（实测）

```jsonc
{
  "aweme_detail": { ... },        // 成功
  "filter_detail": null,
  "log_pb": { "impr_id": "..." },
  "status_code": 0
}
```

失败时 `status_code` 仍是 **0**，靠 `aweme_detail: null` + `filter_detail` 判断：

```jsonc
// 作品被删/不可见
{"aweme_detail": null,
 "filter_detail": {"aweme_id":"7590062598603787569",
                   "detail_msg":"因作品权限或已被删除，无法观看，去看看其他作品吧",
                   "filter_reason":"status_self_see",
                   "notice":"抱歉，作品不见了"},
 "status_code": 0}

// 不存在的 ID
{"aweme_detail": null,
 "filter_detail": {"filter_reason":"core_dep", "detail_msg":"", ...},
 "status_code": 0}
```

> **必须把 `status_code == 0 && aweme_detail == null` 当作业务错误**，否则会拿到空对象一路往下走到 `Cannot read properties of null`。

### 2.5 短链与 URL 解析

| 输入形态 | 处理方式 | 实测 |
|---|---|---|
| `https://v.douyin.com/xxxx/` | `HEAD` 不跟随 → 302 Location 里就是 `https://www.iesdouyin.com/share/video/<id>/?...` | ✅ 实测 302，Location 直接含 aweme_id |
| `https://www.douyin.com/video/<id>` | 正则取 id | — |
| `https://www.douyin.com/note/<id>` | 同上（图集） | — |
| `https://www.iesdouyin.com/share/video/<id>/` | 正则 `/(?:video|note)/(\d+)` | ✅（该 URL 直接 GET 会 302 到 `www.douyin.com/video/<id>`，不要指望 SSR 数据） |
| `...?modal_id=<id>` | query 取 `modal_id` | yt-dlp fork 已支持，见其 README |

推荐正则（覆盖上面全部）：

```ts
const AWEME_ID = /\/(?:video|note|share\/video|share\/note)\/(\d{15,20})/;
const MODAL_ID = /[?&]modal_id=(\d{15,20})/;
```

---

## 3. a_bogus / X-Bogus 签名现状

### 3.1 算法版本与是否仍然需要

| 项 | 2026-10 状态 | 来源 |
|---|---|---|
| `a_bogus` 生成器所在文件 | `bdms.js`，**不再是 `webmssdk.js`** | [dtk abogus.py 头部注释](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/native/abogus.py)："It comes from `bdms.js`, which the page installs over XMLHttpRequest/fetch/URL for paths under `/aweme/v1/`" |
| 算法版本 | **`bdms.js` v1.0.1.19-fix.01**（796 个 VM 函数，`fn150` 为生成器） | 同上 + [hanzheng1954 分析](https://github.com/hanzheng1954/douyin-abogus-analysis) |
| 内部 SDK 版本字段 | `[1,0,1,0]`，`aid=6383`，`page_id=6241` | dtk `SDK_VERSION = (1,0,1,0)` |
| 是否仍要传 | 对 `detail/` **传了也没用**：真正的门是 `uifid` + `x-secsdk-web-signature` | 本次实测 D 组；[dtk protection.py](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/protection.py) 实测 3/8 |
| 输出长度 | 188–192 字符（含随机熵，非确定性），base64 变体码表 | 实测 Python 192、npm 188/192 |
| 算法要点 | SM3（盐 `dhzx`/`cus`，多轮）+ 自研「像 RC4 但不是 RC4」的流密码 + 环境字节混入 + 掩码版本块 | dtk abogus.py：*"The cipher looks like RC4 and is not quite: the S-box is seeded descending and the key schedule multiplies"* |

> **结论**：`a_bogus` 不是「过接口的钥匙」，它只是「让请求看起来像浏览器」的一层。2026 年 `detail/` 的实际守门人是 Argus（`uifid` + `x-secsdk-web-signature`）。所以「移植 a_bogus 就能纯 API」这个 2023–2024 的心智模型已经过期。

### 3.2 可直接用的实现（按可用性排序）

| # | 实现 | 语言 | 版本 | License | 备注 |
|---|---|---|---|---|---|
| 1 | **npm [`abogus`](https://www.npmjs.com/package/abogus) 2.0.0** | TypeScript（ESM，零依赖） | 2026-10-23 | **MIT** | 一站式：`abogus()` `xbogus()` `XGnarly` `getTtwid()` `getValidMsToken()` `getVerifyFp()` `signParams()`；Node/Bun/浏览器通用。**首选** |
| 2 | [ylcangel/douyin_sign](https://github.com/ylcangel/douyin_sign) `a_bogus/utils.js` | JS（可直译 TS） | `sdkVersion = "1.0.1.19-fix.01"`（第 33 行） | Apache-2.0（README 写「仅学习」，法务需确认） | 入口 `makeABogus(uri, ts)` 在 [utils.js:359](https://raw.githubusercontent.com/ylcangel/douyin_sign/main/a_bogus/utils.js)；配 `sm3.js`、`vm_decode.js`、`decode_vmcode.py` |
| 3 | Evil0ctal v5 `src/dtk/signing/native/abogus.py` | Python（纯算，2026-09-09 自研，非移植） | 1.0.1.19-fix.01 | Apache-2.0 | `ABogus(ua).get_value(query, body=...)`；依赖同目录 `sm3.py`，**可以直接读来对照移植** |
| 4 | [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2) `f2/utils/crypto/bytedance/abogus.py` | Python | 注释写 `24/11/15 完成1.0.1.19` | Apache-2.0 | `ABogusManager.str_2_endpoint()`；默认分支是 `v0.0.1.8-pw3`（不是 main） |
| 5 | [JoeanAmier/TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) `src/encrypt/aBogus.py` | Python | 同上 | **GPL-3.0（传染）** | 文件头自述改编自 Evil0ctal；商用接入需避开 |
| 6 | [hanzheng1954/douyin-abogus-analysis](https://github.com/hanzheng1954/douyin-abogus-analysis) `node_signer.js` + `bdms_patched.js` | Node 跑原 VM | 2026-08 | **无 license（保留所有权利）** | 逆向过程记录极详细（trace/反汇编），但**不可商用** |

**未核验**：npm `abogus` 与上述 Python 实现产出的签名是否字节级等价（两者都含随机熵，无法直接比对；只能靠「接口是否放行」间接验证，而当前 `detail/` 已不由 `a_bogus` 决定）。若走 L2，务必自己跑一轮 A/B。

### 3.3 TS 接入示例（已实测可运行）

```ts
import { abogus, signParams, getTtwid, getValidMsToken, getVerifyFp, XGnarly } from 'abogus';

// 1) 纯签名
const q = 'device_platform=webapp&aid=6383&aweme_id=7142091187963399427';
const sig = abogus(q, '', { userAgent: UA });   // GET 的 body 传空串

// 2) 一次拿到全部
const { params, searchParams, aBogus } = signParams(
  { aweme_id: '7142091187963399427', aid: '6383' },
  { userAgent: UA },
);

// 3) 真实身份材料
const ttwid = await getTtwid();            // 实测返回 1%7C...%7C<ts>%7C<sha>
const msToken = await getValidMsToken(UA); // 实测返回 180 字符真实 token
const verifyFp = getVerifyFp();            // verify_xxxx_xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx
```

实测输出（本机）：

```
abogus:   Y6snkFX7EdW5cdMbmCjY97Ml9XglNTuf2-i/SqoT...  len 192
xbogus:   RBDXchuX0UByiVH6
verifyFp: verify_mvm42qtj_JLPbHRhu_M0R5_40AZ_Ke8n_dh13XWsai227
ttwid:    1%7CK8Pkv4g7XglSf2PlqRpePYSUTzyG9-oL4e-naJfteuQ%7C1792828973%7C3c76de...
msToken:  QzN-L2dUsRWwX_Vsyfbz...  len 180
signParams keys: [ 'params', 'searchParams', 'aBogus' ]   aBogus len 192
```

---

## 4. ttwid / msToken / verifyFp 的获取

### 4.1 ttwid（实测，独立可复现）

```bash
curl -i -X POST 'https://ttwid.bytedance.com/ttwid/union/register/' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: <UA>' \
  -d '{"region":"cn","aid":1768,"needFid":false,"service":"www.ixigua.com",
       "migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}'
```

实测返回：

```
HTTP/2 200
set-cookie: ttwid=1%7CzR0N8n0C-cX_Uex6pmUH5BJ0cAKthiBVIc2YJppp7mE%7C1792828743%7C32ff440a...; Path=/; Domain=bytedance.com; Max-Age=31536000; HttpOnly; Secure; SameSite=None
{"status_code":0,"message":"union register success","redirect_url":"..."}
```

- **无需登录、无需前置页面**，一次 POST 即得，有效期 1 年。
- 同一份 payload 也是 Evil0ctal v5 用的（[tokens.py `DOUYIN_TTWID`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/native/tokens.py)），`service=www.ixigua.com` 是关键（同一个 ttwid 体系，西瓜/抖音共用）。
- **重要**：`ttwid` 只是入场券。实测「web 参数 + 新 ttwid」仍然 403 `Uifid Not Found`。

### 4.2 msToken

| 方式 | 做法 | 实测 |
|---|---|---|
| 本地假 token | 从 `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-` 抽 126 字符 + `==`（抖音）；TikTok 为 146 | dtk 的 `gen_false_ms_token()`，注释："The platform accepts it for many endpoints and rejects it for some" |
| 真实 token | `POST https://mssdk.bytedance.com/web/r/token`，body 是 SDK 的 `strData`（JSON），响应 `Set-Cookie: msToken=...` | `abogus.getValidMsToken()` 实测拿到 **180 字符**；**裸 POST `{}` 返回 `{"resultCode":-2,"dataType":8}` 且无 Cookie** → body 必须由 SDK 算法生成，不能省 |
| 过期/旧的 `mssdk.bytedance.com/web/report` | — | 实测 **404**，已不是当前路径 |

- L1 通道（open API）**不需要 msToken**。
- 真实 msToken 长度：抖音 120/128（dtk 的 `DOUYIN_MS_TOKEN_SIZES`）；实测 npm 包返回 180，说明该接口形态已变，**长度断言别写死**（否则会像 dtk 那样抛 `UpstreamChanged`）。
- `verifyFp` / `s_v_web_id`：`verify_` + base36 时间戳 + `_` + UUID v4 形态的 36 字符，可本地生成（dtk `VERIFY_FP_ALPHABET` / `_VERIFY_FP_SEPARATORS`）；L1 不需要。

### 4.3 是否需要真实 Cookie 登录

**不需要。** 游客态即可拿到 `aweme_detail` 全量，包括 1080p `play_addr`、全部 `bit_rate` 档位、作者信息、音乐直链、图集全部图片。本次实测全程无任何 Cookie。

需要登录态的场景（社区共识，**未逐条核验**）：私密/好友可见作品、部分区域限制内容、`status_self_see` 类作品、搜索翻页。

### 4.4 L2 通道：web API 到底缺什么

Evil0ctal v5 用自家 web SDK 的 `webSign` 策略反查出了受保护路径白名单（[protection.py](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/protection.py)，14 条），其中包括：

```
/aweme/v1/web/aweme/detail/     PROTECTED   3/8 通过，其余 403 Uifid Not Found
/aweme/v1/web/aweme/post/       PROTECTED   3/8
/aweme/v1/web/comment/list/     unprotected 8/8
/aweme/v1/web/user/profile/other/ unprotected 8/8
```

同文件还写明：

> `websign.py` 是 Argus 的 `x-secsdk-web-signature` 纯算实现；`requires_browser_signature()` 对抖音只在「路径在保护名单里 **且** cookie 里没有 `uifid`」时返回 True。补上 `uifid` 后：「24 of 24 live requests across all four endpoints returned data with no browser involved」。

即 L2 的完整配方是：`a_bogus` + `ttwid` + **`uifid` Cookie** + **`x-secsdk-web-signature` 请求头**（一个签名串，纯 Python 可算，见 `signing/native/websign.py`）。

**卡点**：`uifid` 只能由服务端下发（浏览器 Cookie `UIFID` / `UIFID_TEMP`，或精选页响应里带）。本机实测 `GET https://www.douyin.com/jingxuan` 只拿到 `__ac_nonce`，**没有** `UIFID`（返回的是 JS 挑战页），所以**无浏览器的 uifid 铸造路径未核验**。

工程含义：L2 要么一次性用真浏览器/真机 cookie 铸一个 `uifid` 存起来长期复用，要么就别做 L2，直接 L1 + L3。

---

## 5. 无水印资源：字段路径与域名规则

### 5.1 视频

```
aweme_detail.video
├── play_addr            ← 无水印（主用）
│   ├── uri             "v0300fg10000ccess2bc77u0hbd92do0"
│   ├── url_list[]      https://v26-web.douyinvod.com/.../video/tos/cn/tos-cn-ve-15c001-alinc2/...
│   ├── data_size       1748823
│   ├── width/height    1920/1080
│   └── url_key         ..._h264_1080p_937141
├── play_addr_h264       ← 与 play_addr 同 URI（老字段）
├── bit_rate[]           ← 多档：normal_1080_0 / normal_720_0 / normal_540_0 ...
│   └── { gear_name, bit_rate, quality_type, is_h265, play_addr{...} }
├── download_addr        ← 带水印（抖音号 + logo），720p
├── cover / origin_cover / dynamic_cover
├── duration (ms) / ratio ("1080p") / cdn_url_expired
└── has_watermark        ← 注意：这是「原片是否自带水印」的元数据，
                            不是「这个 URL 有没有水印」，别拿它做判断
```

实测对照（同一作品）：

| 字段 | 分辨率 | 大小 | 水印 |
|---|---|---|---|
| `play_addr.url_list[0]` | 1920×1080 | 1,748,823 B | **无**（抽帧视觉确认，画面只有创作者自己的字幕） |
| `download_addr.url_list[0]` | 1280×720（路径含 `/mps/logo/r/p/`） | 1,129,873 B | **有**：左上角抖音 logo + `抖音号: AK1104L` + 昵称「李子尘」 |
| `/aweme/v1/play/?video_id=<uri>&ratio=default` | 上传原片（`.mov`, `ftypqt`） | **27,417,045 B**（≈15.7× 1080p 转码） | 无 |

> 原片通道：`GET https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>&ratio=default&line=0` → 302 到 `v5-se-jltc-colds.douyinvod.com`，返回 QuickTime 容器。yt-dlp fork 实测「码率为最高转码档的 2.8–10.3 倍，少数老视频会回退为转码档」，且「原片跳转到的冷存储节点对带 Referer 的请求可能 403」（[README](https://github.com/Index103000/yt-dlp/blob/3878b69d64ef4734fd81c7edc95e102008bb6dde/yt_dlp/extractor/tiktok_utils/README.md)）。本次实测带 Referer 也能拿到，行为不稳定，**原片只作可选加分项，不要作为默认返回**。

### 5.2 直链的两个硬约束（实测）

1. **下载必须带 `Referer: https://www.douyin.com/`**
   - 带 → 200，`video/mp4`
   - 不带 → **403**，355 B
2. **直链会过期，且视频/图片 TTL 差 100 倍**

| 类型 | 过期字段 | 实测值 | 剩余 TTL |
|---|---|---|---|
| 视频 | `video.cdn_url_expired` | `1792839046` | **2.8 小时** |
| 图片 | URL query `x-expires` | `1795417200` | **719 小时（30 天）** |

> 工程含义：缓存里**不能存视频直链**（2.8 h 就烂），只能存 `aweme_id` + 结构化元数据，直链按需重取或短 TTL 缓存（建议 ≤30 min）。图片直链可以缓存得久一些，但也别超过 7 天。

### 5.3 图集（images）字段结构

图集与视频**共用同一个 detail 接口**，靠 `aweme_detail.images` 非空 / `media_type == 2` 判断。

```
aweme_detail
├── media_type       2 = 图集，4 = 视频
├── aweme_type       注意：图集也可能是 0，别只看这个
├── images[]                          ← 主数组（实测 40 项）
│   ├── uri          "tos-cn-i-0813c000-ce/oMArBA4EnpvPxmYitOcg38MRBAIaxiDF3AaAE"
│   ├── width/height 960/960（各图不同，实测有 1440×1406、1152×1150）
│   ├── url_list[]           ← **无水印**，模板 ~tplv-dy-aweme-images:q75.webp
│   ├── download_url_list[]  ← **带水印**，模板 ~tplv-dy-water-v2:...:960:960.webp
│   ├── is_aigc_media / is_new_text_mode / resolution_log_param
│   ├── live_photo_type      1 = 实况照片
│   ├── clip_type            5 = 实况视频片段
│   └── video                ← 实况照片的 5 秒 MP4（静态图时为 null 或缺省）
│       └── play_addr.url_list[]（720p，约 5 s，无水印）
├── image_list / original_images / image_infos   ← 实测这几个字段为 null，别依赖
└── img_bitrate                                  ← 实测为 []，别依赖
```

实况照片的判定依据来自 Evil0ctal v5 的实测注释（[parser.py `_live_clip`](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/platforms/douyin/parser.py)）：

> "Measured 2026-10-20 on one author's twenty posts: a live slide carries `live_photo_type: 1` and `clip_type: 5` beside a `video` of its own, whose `play_addr` is about five seconds of 720p MP4. A still has no `video` at all, or `"video": null`. **The post-level `video` of such a post is no help — its `play_addr` is the background music.**"

最后一句是最大的坑：图集作品顶层的 `video.play_addr` 是**背景音乐**，不是内容；一定要按 `images[i].video` 取实况片段。

### 5.4 图片去水印的域名与模板规则（实测，含失败的尝试）

实测样本：`https://p3-pc-sign.douyinpic.com/tos-cn-i-0813c000-ce/oMArBA4...~tplv-dy-aweme-images:q75.webp?lk3s=...&x-expires=...&x-signature=...`

| 变体 | 结果 |
|---|---|
| 原样 `url_list[0]`（`~tplv-dy-aweme-images:q75.webp`） | **200**，30,204 B，960×960 webp，**无水印** |
| 原样 `download_url_list[0]`（`~tplv-dy-water-v2:...`） | **200**，31,222 B，960×960 webp，**底部中央有抖音 logo + `抖音号: JC10050823T`** |
| 去掉 `~tplv-...` 段（想拿原图） | **403**（238 B HTML） |
| 去掉整段 query | **403** |
| 把 `q75.webp` 改成 `q75.jpeg` | **403** |
| 换域名 `p3-pc-sign` → `p3` | **403**（`{"code":...}` JSON） |

**结论：图片签名（`x-signature` / `sig`）覆盖了「路径 + 模板段 + query」，URL 一个字符都不能改。** 想要无水印图，只能取 `url_list`（它本来就是无水印模板），不能靠「删模板参数拿原图」这套老办法——2026 年已经不通了。

域名规则：`p3-pc-sign.douyinpic.com` / `p9-pc-sign.douyinpic.com`（`p3`/`p9` 是不同 CDN 节点，`-sign` 表示带签名），实测 120 条图片 URL 只出现这两个 host。旧文档里的 `p3.douyinpic.com`（无 `-sign`）已不接受带签名参数。

---

## 6. 开源项目对标

star / 最近提交均为 2026-10-24 用 `gh api repos/<owner>/<repo>` 实时取值。

| 项目 | Star | 最近提交 | License | 核心实现 | 双端 | 签名位置 |
|---|---|---|---|---|---|---|
| [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | **20,863** | 2026-10-21 | Apache-2.0 | 纯 HTTP（v5 重写，Python） | 抖音+TikTok+B站 | `src/dtk/signing/native/{abogus,xbogus,websign,tiktok_sign}.py` |
| [JoeanAmier/TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader) | **17,077** | 2026-09-22 | **GPL-3.0** | 纯 HTTP（curl_cffi 指纹伪装） | 抖音+TikTok | `src/encrypt/{aBogus,xBogus,websign,xGnarly}.py` |
| [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 67,978 | 2026-10-15 | 非商用（NOASSERTION） | **必须浏览器**（Playwright 取签名/登录态） | 多平台 | `libs/douyin.js` + execjs |
| [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2) | 2,709 | 2026-10-19 | Apache-2.0 | 纯 HTTP（Python，CLI 库） | 抖音+TikTok+多平台 | `f2/utils/crypto/bytedance/{abogus,xbogus,xgnarly}.py` |
| [ylcangel/douyin_sign](https://github.com/ylcangel/douyin_sign) | 79 | 2026-08-07 | Apache-2.0 | 内嵌 JS（可直译） | 仅抖音 | `a_bogus/utils.js`、`a_bogus/sm3.js` |
| [hanzheng1954/douyin-abogus-analysis](https://github.com/hanzheng1954/douyin-abogus-analysis) | 12 | 2026-09-23 | 无 | Node 跑原 VM + Python 移植 | 仅抖音 | `node_signer.js`、`bdms_patched.js` |

### 6.1 Evil0ctal/Douyin_TikTok_Download_API —— 最值得对标

- **已整体重写为 v5**（线上 `demo.douyin.wtf/openapi.json` 自报 `5.1.7`，107 条路径）。v4 的 `crawlers/douyin/web/` **已不存在**，网上大量教程的路径全部失效。
- 解析链路：`platforms/douyin/endpoints.py` 定义 `POST_DETAIL = f"{DOUYIN_DOMAIN}/aweme/v1/web/aweme/detail/"` → `params.py::content_detail_params()` 拼 `base_params(profile) | {"aweme_id": ...}` → `signing/signer.py` 按路径决定签 `a_bogus` 还是 `x-secsdk-web-signature` → `parser.py` 把 `aweme_detail` 归一化成 `Media/VideoStream/AlbumImage` 领域模型。
- **最值得抄的是它的数据契约**：`parser.py` 明确区分 `play_addr`（`watermark=False`）与 `download_addr`（`watermark=True`），并把 `bit_rate[]` 逐档映射成 `VideoStream{bitrate, format, size_bytes, watermark}`；图集走 `_album_images()` + `_live_clip()`。这套模型比「直接透传 JSON 给前端」健壮得多。
- 对外 API：`POST /api/v1/parse`（旧的 `/api/hybrid/video_data` 已不存在），另有 `/api/v1/tools/parse-url`、`/api/v1/tools/parse-batch`、`/api/v1/tasks/{task_id}`。
- 解析链路本身不依赖浏览器：浏览器只作为可选兜底（`signing/rpc.py` 的 `/rpc/sign` 签名中转），以及用于铸造游客身份 cookie。
- Apache-2.0，可商用（保留 NOTICE）。

### 6.2 JoeanAmier/TikTokDownloader —— 工程完整度最高，但 GPL

- `src/encrypt/` 是一套齐全的签名库：`aBogus.py`、`xBogus.py`、`websign.py`、`tiktok_sign.py`、`xGnarly.py`、`msToken.py`、`sm3.py`。
- 自带 FastAPI 服务 `src/application/main_server.py`（`APIServer` + uvicorn）：`POST /douyin/detail` body `{detail_id, cookie?, proxy?, source?}`，`POST /tiktok/detail`，token 走 Header。
- **License 是 GPL-3.0**：如果你的服务要闭源/商用，**不能**把它的代码搬进来（哪怕只搬 `aBogus.py`）。它的实现也已经明确标注改编自 Evil0ctal（Apache-2.0），所以要用就用上游。

### 6.3 Johnserf-Seed/f2 —— 库化最彻底，适合读不适合抄

- 默认分支不是 `main`，而是版本分支 `v0.0.1.8-pw3`；release 仍停在 `v0.0.1.7`（2024-12-31），**别被 release 页骗了**。
- 链路：`f2/apps/douyin/api.py::DouyinAPIEndpoints.POST_DETAIL` → `crawler.py::fetch_post_detail` → `apps/douyin/utils.py::ABogusManager.str_2_endpoint/model_2_endpoint`（同文件 `TokenManager`、`GatewayHeaderManager` 自动补 `x-tt-argus` / `uifid`）。
- 算法本体 `f2/utils/crypto/bytedance/abogus.py`：`ABogus.generate_abogus(params, body)`，纯 Python 无 execjs，注释写 `1.0.1.19`，`salt="cus"`、`pageId` 6241、`ua_key=b"\x00\x01\x0e"`。
- **没有 HTTP 服务**，只有 CLI；要 API 得自己包一层（这点不如 Evil0ctal）。

### 6.4 MediaCrawler —— 反面教材（对我们要做的事而言）

6.8 万 star，但它的抖音实现是 `libs/douyin.js` + execjs/Playwright，并且依赖登录态 cookie 做搜索/评论。它证明的是「爬虫场景下浏览器仍是最省事的」，而**单作品详情去水印不需要走它这条路**。License 是「非商用」，直接排除。

### 6.5 小结：抄什么、不抄什么

| 抄 | 不抄 |
|---|---|
| Evil0ctal 的 `Media/VideoStream/AlbumImage` 数据契约与 `watermark` 标记 | 它的整套 identity 池 / 代理池 / 任务队列（我们场景不需要） |
| `base_params()` 的指纹参数集合（L2 用） | MediaCrawler 的浏览器路线（我们现在就是要摆脱它） |
| `_live_clip()` 的实况判定逻辑 | TikTokDownloader 的代码（GPL 传染） |
| `abogus` npm 包（MIT）做签名 | hanzheng 仓库（无 license） |

---

## 7. 风控与踩坑（全部实测或一手源码佐证）

### 7.1 错误信号对照表

| 现象 | 真实原因 | 处理 |
|---|---|---|
| `403` + body `Blocked by ArgusSecurityPlugin Uifid Not Found`（46 B） | 走了 web API 但缺 `uifid` + `x-secsdk-web-signature`；或 L1 漏了 `Origin` 头 | 优先补 `Origin: https://open.douyin.com`；不行才上 L2 |
| `200` + **body 长度 0** | 接口对该来源静默拒绝（实测 `aweme/post`、`comment/list` 走 L1 头就是这个） | 把「200 且 body 为空」判为失败并换通道，别当成功 |
| `200` + `status_code: 0` + `aweme_detail: null` + `filter_detail.filter_reason` | 作品被删/私密/地区限制。实测值：`status_self_see`（仅自己可见）、`core_dep` | 直接把 `filter_reason` 透出给调用方，别重试 |
| 视频下载 `403`（355 B） | CDN 缺 `Referer: https://www.douyin.com/` | 下载代理必须补 Referer |
| 图片 `403`（238 B HTML） | 改了图片 URL 的任一字符（模板段/query/域名） | 原样使用 `url_list`，不要拼 URL |
| `403` 但 body 是「验证码中间页」HTML | 页面链路 `__ac_nonce` / `__ac_signature` 不匹配（仅 SSR 页面方案会碰到） | 我们不使用该方案，忽略 |
| 签名每隔几周突然全 403 | `bdms.js` 版本升级（当前 1.0.1.19-fix.01） | 监控 + 升 npm 包；L1 通道不受影响 |

### 7.2 频控与 IP

- 实测 30 次连续 detail 请求（同一 IP、无 Cookie、间隔≈0）：**30/30 成功，总耗时 14 s（≈470 ms/次）**，未触发任何限流。
- 实测两个完全不同的出口（山东电信家宽出口、海外机房出口，IP 均已脱敏）均 200 → L1 通道**不挑 IP 归属地**。
- 但 yt-dlp fork 记录「部分 IP 会被 ArgusSecurityPlugin 拦截（按 IP 而定，海外居多，国内电信也遇到过）」——那是 **web API 通道**的现象，与 L1 不同。
- **未核验**：L1 通道的日级配额、并发上限、被识别为数据中心 IP 后的行为。建议上线后按 IP 维度打点。

### 7.3 其它坑

1. **`has_watermark: true` 不代表你拿到的 URL 带水印**。实测该作品 `has_watermark=true`，但 `play_addr` 画面干净（原片自带片头字），`download_addr` 才有抖音号水印。判断水印只能看「取的是哪个字段」。
2. **图集作品的顶层 `video.play_addr` 是背景音乐**（见 §5.3），误用会返回一段几秒的音频画面。
3. **`aweme_type` 不可靠**：实测图集 `aweme_type=0`（和视频同值），必须用 `media_type == 2` 或 `images` 非空判断。
4. **`bit_rate` 档位依赖 `aid`**：不带 `aid=6383` 只剩 2 档（1080p + 540p 这类），带了才有 4 档。要「最高画质」就必须带 `aid`。
5. **直链 TTL 差 100 倍**：视频 2.8 h、图片 30 天（§5.2）。缓存设计必须区别对待。
6. **`impr_id` 是你的排障抓手**：每次响应都有 `log_pb.impr_id`，报障时带上它比描述现象有用。

---

## 8. TikTok 是否值得同时支持

### 8.1 现状（2026-10）

| 维度 | 抖音 | TikTok |
|---|---|---|
| 端点 | `GET /aweme/v1/web/aweme/detail/?aweme_id=` | `GET /api/item/detail/?itemId=` |
| 免签名通道 | **有**（`Origin: open.douyin.com`） | **无**（未发现等价口子） |
| 签名 | `a_bogus`（当前可绕过） | `X-Dynosaur` + `msToken` + `X-Bogus=1` + **`X-Gnarly`** 四参数，顺序固定 |
| `X-Bogus` 是否还用 | 仅直播间 | **HTTP 请求里是字面量字符串 `1`**，真正的封印是 `X-Gnarly` |
| 无水印字段 | `video.play_addr` | `video.playAddr` / `video.bitrateInfo[].PlayAddr.UrlList[]`（`downloadAddr` 带水印） |
| CDN Referer | `https://www.douyin.com/` | `https://www.tiktok.com/` |
| 网络要求 | 国内/海外均可（实测双出口通过） | **必须海外 IP**；本机与代理出口访问 `www.tiktok.com` 均 `302 → /hk/about`，**接口无法实测** |
| SDK 迭代节奏 | `bdms` 1.0.1.19-fix.01（较稳） | `webmssdk` 2.0.0.561 / 上报 5.3.2，约 2–3 个月一升 |

TikTok 侧的一手证据（TS 侧同一个 npm 包也覆盖了）：

- `abogus@2.0.0` 导出 `XGnarly` 类，README：「`new XGnarly().sign(queryString, body, userAgent)` — 生成 TikTok Web API 的 X-Gnarly 签名」「X-Gnarly：TikTok Web 端的 ChaCha20 密钥流签名，使用独立的 Base64 码表」。
- Evil0ctal v5 `src/dtk/signing/native/tiktok_sign.py` 文件头：「`<business query>&X-Dynosaur=<env report>&msToken=<session>&X-Bogus=1&X-Gnarly=<request seal>`」，并注明「`X-Bogus` is the literal one-character string `1` on HTTP requests」。
- f2 有等价实现 `f2/utils/crypto/bytedance/xgnarly.py`（2026-09-26 变更）。

### 8.2 建议

**第一阶段不做 TikTok。**

> 【勘误 2026-10-28】官方 web API 调研存档；实际落地走 tikwm 第三方接口（见 research/05 §4.2），TikTok 现已支持，不走四签名方案

理由：

1. 抖音侧存在免签名通道，工程量是「一个 fetch + 一个 URL 解析」；TikTok 侧是「X-Gnarly + X-Dynosaur + 真实 msToken + 海外代理」，工程量差一个数量级。
2. TikTok 需要海外出口，而当前服务部署在国内（3 Mbps 测试机），加代理会引入新的不稳定源与成本。
3. TikTok 的 SDK 2–3 个月一升版，签名算法跟着变；抖音 `bdms` 的 a_bogus 虽也在变，但**我们压根不用它**。

**如果要做**：直接上 `abogus` npm 包的 `XGnarly`，不要自己移植；同时必须准备海外代理池，并把「200 空 body + `tt_orcas_res:1`」「statusCode 10000/10101」列入错误码表。参考实现：`src/dtk/signing/native/tiktok_sign.py`、`f2/utils/crypto/bytedance/xgnarly.py`。

---

## 9. 落地改造方案（针对本仓库）

### 9.1 现状与目标

本节写于 2026-10-25 重构前，所述 src/utils/ 方案已废弃；现行实现见 §12 与 src/platforms/douyin/。

现状（`src/utils/puppeteer.ts` + `src/utils/api-parser.ts`）：

- 启 headless Chrome → 打开 `douyin.com/video/<id>` → 拦截 `/aweme/v1/web/aweme/detail/` 响应 → `api-parser.ts` 解析 `aweme_detail` → 单例复用浏览器。
- 痛点：1–3 s、内存 200–400 MB、图集类型不调 detail 接口只能靠监听图片资源（README 已自认「无法返回标题、作者头像等元数据」）。

目标：抖音走 `fetch`，P95 < 500 ms，内存 < 50 MB；图集/实况照片有完整元数据。

### 9.2 建议的文件改动

```
src/
├── platforms/
│   └── douyin/
│       ├── client.ts        # 新增：detail 请求 + 三级降级
│       ├── parser.ts        # 新增：aweme_detail → 统一 Content 模型
│       ├── url.ts           # 新增：短链/长链/modal_id → aweme_id
│       └── errors.ts        # 新增：403/空body/filter_reason 分类
├── utils/
│   ├── api-parser.ts        # 保留（L3 浏览器兜底还在用）
│   └── puppeteer.ts         # 保留但降级为 lazy + 超时才启动
└── types/
    └── content.ts           # 扩展：video streams[] / images[] / liveClip
```

### 9.3 核心实现（可直接改写成 `client.ts`）

```ts
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

/** L1：免签名口子。实测 30/30，TTFB ≈ 330 ms */
async function detailL1(awemeId: string) {
  const qs = new URLSearchParams({ aweme_id: awemeId, aid: '6383' });
  const res = await fetch(`${BASE}?${qs}`, {
    headers: {
      'User-Agent': UA,
      Origin: 'https://open.douyin.com',
      Referer: 'https://open.douyin.com/',
    },
    signal: AbortSignal.timeout(3000),
  });
  if (res.status === 403) throw new BlockedError(await res.text());
  if (res.status !== 200) throw new HttpError(res.status);
  const text = await res.text();
  if (!text) throw new EmptyBodyError();           // 200 空 body 必须当失败
  const json = JSON.parse(text);
  if (json.status_code !== 0) throw new ApiError(json.status_code);
  if (!json.aweme_detail) throw new FilteredError(json.filter_detail);
  return json.aweme_detail;
}
```

降级链：

```ts
export async function getAwemeDetail(awemeId: string) {
  try {
    return await detailL1(awemeId);                 // 95%+
  } catch (e) {
    if (e instanceof FilteredError) throw e;        // 作品本身不可见，重试无意义
    try {
      return await detailL2(awemeId);               // a_bogus + ttwid + uifid/websign
    } catch {
      return await detailL3Puppeteer(awemeId);      // 保留现有实现
    }
  }
}
```

`parser.ts` 的关键映射（字段路径照抄 §5）：

```ts
const isAlbum = detail.media_type === 2 || (detail.images?.length ?? 0) > 0;

const streams = [
  { url: detail.video.play_addr.url_list[0], watermark: false, ... },
  ...(detail.video.bit_rate ?? []).map((g) => ({
    url: g.play_addr.url_list[0],
    bitrate: g.bit_rate,
    gear: g.gear_name,
    watermark: false,
  })),
  { url: detail.video.download_addr?.url_list[0], watermark: true, resolution: '720p' },
].filter((s) => s.url);

const images = (detail.images ?? []).map((img) => ({
  url: img.url_list[0],                    // 无水印；不要改 URL
  width: img.width,
  height: img.height,
  liveClip: img.live_photo_type === 1
    ? img.video?.play_addr?.url_list?.[0] ?? null
    : null,                                // 实况：5s 720p
}));
```

### 9.4 下载代理必须补 Referer

`play_addr` 直链不带 Referer 就是 403。如果服务端做「代理下载/转存」，务必：

```ts
fetch(playUrl, { headers: { Referer: 'https://www.douyin.com/', 'User-Agent': UA } });
```

如果直接 302 给客户端，客户端的浏览器 Referer 是自家页面 → 大概率 403。两个选择：服务端代理转发（占带宽），或返回直链 + 前端提示用下载器。

### 9.5 缓存策略（按 TTL 分层的硬要求）

| 缓存内容 | 建议 TTL | 理由 |
|---|---|---|
| `aweme_id` → 元数据（标题/作者/封面/图片 URL/streams 列表） | 1 h（现有 `cache.ts` 的设置可用） | 元数据变化慢 |
| 视频直链 | **≤ 30 min** | `cdn_url_expired` 只有 2.8 h，宁可短 |
| 图片直链 | ≤ 7 天 | `x-expires` 30 天，但保守 |
| 负结果（`filter_reason`） | 10 min | 避免打爆不存在的 ID |

> 别直接缓存整个 `aweme_detail` JSON 就下发：里面 42 KB、上百个字段，前端只需要 10 个，而且含大量签名 URL。

### 9.6 监控指标（能提前发现口子被堵）

| 指标 | 阈值 | 动作 |
|---|---|---|
| L1 403 比例 | > 5%（5 min 窗口） | 告警；确认 body 是否含 `ArgusSecurityPlugin` |
| L1 空 body 比例 | > 1% | 告警 |
| `filter_reason` 分布 | — | 打点即可，用于区分「我们的问题」和「作品的问题」 |
| L2 使用率 | 持续 > 20% | 说明口子不稳，启动预案 |
| L3（浏览器）启动次数 | > 1% 请求 | 说明纯 API 方案退化，需排查 |

---

## 10. 未核验清单

1. **L1 口子的长期稳定性与配额**：只测了 30 次 / 2 个 IP / 20 分钟，没有日级、并发级数据。这是本方案唯一的真实风险。
2. **无浏览器铸造 `uifid` 的可行路径**：本机 `GET /jingxuan` 只返回 `__ac_nonce`，没拿到 `UIFID_TEMP`。dtk 说精选页会下发，但我们没复现。若 L2 要落地，需要一次性用真浏览器/真机 cookie 铸一个。
3. **`x-secsdk-web-signature` 的 TS 实现**：只找到 Python 版（`signing/native/websign.py` 3,207 B、`TikTokDownloader/src/encrypt/websign.py`）。**JS/TS 版未核验是否公开存在**，这是 TS 服务做 L2 的最大空档。
4. **TikTok 全部接口**：本机与代理出口访问 `www.tiktok.com` 均 `302 → /hk/about`，无法实测。§8 的结论来自四个活跃仓库的源码与 release 记录，非实测。
5. **npm `abogus` 与 Python 实现的字节级等价性**：两者都含随机熵，无法直接比对；只能靠接口放行间接验证，而当前 `detail/` 不由 `a_bogus` 决定。
6. **登录态对清晰度的影响**：本次全部游客态，1080p 已经拿到，未测「登录后是否有 4K」。
7. **`/api/item/detail/` 之外的 TikTok 端点**（`/api/post/item/detail/` 等）：三个维护库都不使用，**未核验是否存在**。

---

## 11. 参考链接

**一手源码**

- Evil0ctal v5 签名层：<https://github.com/Evil0ctal/Douyin_TikTok_Download_API/tree/main/src/dtk/signing/native>
- Evil0ctal v5 受保护路径白名单：<https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/protection.py>
- Evil0ctal v5 详情参数：<https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/platforms/douyin/params.py>
- Evil0ctal v5 解析器（含水印/图集/实况判定）：<https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/platforms/douyin/parser.py>
- Evil0ctal v5 身份铸造（ttwid/msToken）：<https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/signing/native/tokens.py>
- f2 a_bogus：<https://raw.githubusercontent.com/Johnserf-Seed/f2/v0.0.1.8-pw3/f2/utils/crypto/bytedance/abogus.py>
- f2 TikTok 签名：<https://github.com/Johnserf-Seed/f2/blob/v0.0.1.8-pw3/f2/utils/crypto/bytedance/xgnarly.py>
- TikTokDownloader 签名目录：<https://github.com/JoeanAmier/TikTokDownloader/tree/master/src/encrypt>
- ylcangel JS 版 a_bogus（1.0.1.19-fix.01）：<https://raw.githubusercontent.com/ylcangel/douyin_sign/main/a_bogus/utils.js>

**工具 / 文档**

- npm `abogus` 2.0.0（MIT，TS）：<https://www.npmjs.com/package/abogus> / <https://github.com/sobird/abogus>
- Evil0ctal 线上 API（107 条路径，v5.1.7）：<https://demo.douyin.wtf/openapi.json>
- Evil0ctal 概念文档（签名保护 / 身份 / cookie）：<https://www.douyin.wtf/concepts/>
- yt-dlp fork 的抖音风控实测记录（三级策略、原片探测）：<https://github.com/Index103000/yt-dlp/blob/3878b69d64ef4734fd81c7edc95e102008bb6dde/yt_dlp/extractor/tiktok_utils/README.md>
- yt-dlp 官方 TikTok extractor（`downloadAddr` 标 watermarked）：<https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py>
- a_bogus 逆向全过程（VM 反汇编/SM3 管线）：<https://github.com/hanzheng1954/douyin-abogus-analysis>

---

## 12. L2 签名通道落地记录（2026-10-27 实测补记）

L1 → L2 → L3 三级降级链已在 `src/platforms/douyin/signing.ts` + `adapter.ts` 落地。以下为预研三项结论、uifid 铸造步骤（供下次复铸）与真机 A/B 证据。

### 12.1 预研三项结论

1. **TS 侧 `x-secsdk-web-signature`**：npm 无独立实现（搜 websign/secsdk/douyin-signature 均无），但 **npm `abogus@2.1.1`（MIT）自带 `signWebUrl()` 与 `SECSDK_WEB_SIGNATURE_SALT`**，与 Evil0ctal `websign.py` 同算法同盐（`md5(uifid_timestamp_盐_query)`）。逐字节 parity 验证：抓真机 SDK 自己发出的 detail 签名 URL，用该公式复算 md5，与它带的 `x-secsdk-web-signature` 32 位十六进制完全一致。因此直接用 abogus，无需移植 websign.py（也没有搬任何 Apache-2.0 代码）。
2. **abogus API 形态**：§3.3 所述 `abogus()` / `signParams()` / `getTtwid()` / `getValidMsToken()` / `getVerifyFp()` 全部可用（实测过）；`signWebUrl(url, { uifid, timestamp })` 会把 `uifid`/`timestamp`/`x-secsdk-web-signature` 追加到查询串末尾。
3. **uifid 铸造**：一次性 headless 浏览器可铸，步骤见 §12.2。真机验证：铸出 `UIFID_TEMP` + 同场 `ttwid` 直接请求 detail 接口即 200 全量。

### 12.2 uifid 铸造步骤（复铸手册）

```js
// 一次性脚本：puppeteer 起 headless Chrome（系统 Chrome 即可），跑完关掉
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage();
await page.goto('https://www.douyin.com/jingxuan', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 8000));          // 等 __ac_nonce 挑战过完
const cdp = await page.createCDPSession();
const { cookies } = await cdp.send('Network.getAllCookies');
// uifid = name 含 'uifid' 的 cookie（真机名 UIFID_TEMP，150-160 字符 hex）；
// 同场把 ttwid 一起抄走，配成一对身份
```

产出两个值配到 env：`DOUYIN_UIFID=<UIFID_TEMP 值>`、`DOUYIN_TTWID=<ttwid 值>`（ttwid 不配也行，服务端会现铸，但同场带出的身份最稳）。`UIFID_TEMP` 可长期复用；签名失效（§7.1 的「Sign Invalid / Uifid Not Found」）时重铸即可。

### 12.3 最终 L2 配方（真机 200 全量，零浏览器）

```
GET https://www.douyin.com/aweme/v1/web/aweme/detail/?
    <标准指纹参数集（§2.1 base_params）>&aweme_id=<id>
    &uifid=<UIFID_TEMP>&timestamp=<秒>&x-secsdk-web-signature=<md5 签名>
Cookie: ttwid=<ttwid>; UIFID_TEMP=<uifid>
Headers: User-Agent、Referer: https://www.douyin.com/
         （uifid / x-secsdk-web-signature / x-secsdk-web-expire 三个头可带可不带，实测无害）
```

curl 实测（2026-10-27，aweme_id=7142091187963399427）：

```
HTTP 200  bytes 43259  ttfb 0.333672s
aweme_detail OK: 7142091187963399427 | 救赎之道 就在心中 | 李子尘 | bit_rate: 4
```

### 12.4 真机 A/B 修正两个配方细节（重要）

§4.4 把 L2 配方写成「`a_bogus` + `ttwid` + `uifid` + `x-secsdk-web-signature` 四件套」。2026-10-27 真机 A/B（同身份同时刻单变量对照）修正如下：

| query 里的成分 | 实测结果 |
|---|---|
| 标准参数 + uifid/timestamp/签名（**无 a_bogus**） | **200 + 42 KB 全量 `aweme_detail`**（10+ 次复验稳定） |
| 同上 + `a_bogus`（三种构造：裸盖业务参数 / 盖含 uifid 的全查询 / SDK 布局） | **200 + 空 body 静默拒绝**，响应带 `x-vc-bdturing-parameters`（风控挑战头） |
| 同上 + `msToken`（假/真均试） | 200 + 空 body 静默拒绝 |
| 同上 + `webid`/`verifyFp`/`fp`/`msToken` 全套 | 200 + 空 body 静默拒绝 |
| 缺签名参数 | 403 `Blocked by ArgusSecurityPlugin Signature Not Found` |
| 签名乱写 | 403 `Blocked by ArgusSecurityPlugin Sign Invalid` |

结论：**守门人是 `uifid` + `x-secsdk-web-signature`（§3.1 原判断正确），`a_bogus` 现阶段是毒参数**——带上它请求直接被风控引擎静默拒绝（200 空 body，§2.3 的坑）。注意：21:35-21:53 时段带 a_bogus 也曾放行过 8 次，22:00 后同配方全部被拒，疑似服务端风控配置或 bdms 版本在当晚切换；落地代码不带 `a_bogus`。若日后要重试 a_bogus（比如服务端开始强制校验），先按本节方法 A/B 再开。

「200 + 空 body = 静默拒绝必须当失败」这条坑在 L2 上同样成立，L2 通道把 403 与 200 空 body 都归 `UPSTREAM_CHANGED`（签名失效），与 L1 的 `RISK_CONTROL` 在错误码与 `channel_downgrade_total` 打点上分开。

---

*文档生成时间：2026-10-24；实测样本与命令见 §1、§2.2，可原样复跑验证。§12 为 2026-10-27 L2 签名通道落地实测补记。*
