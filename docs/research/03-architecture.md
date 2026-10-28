# 03 · 工程架构方案（插件化 / 中转代理 / 缓存 / 限流 / 可观测性 / 测试 / 部署）

> ⚠️ **勘误提示**：本文是 2026-10-24 的架构调研与改造方案快照。方案骨架已落地，但草案细节与实现有多处偏差（目录布局、指标名、限流、缓存、错误码、熔断等均以下述实际代码为准）；现状以 `README.md` 与 `docs/开发者指南.md` 为准，本文不逐节追改。
>
> 后续演进（2026-10-27/28，不在本方案内）：uifid 身份池（src/platforms/douyin/uifid-pool.ts）与签名器 provider 注册表（src/core/signers.ts）。

> 调研时间：**2026-10-24**（Bun 1.3.10、Elysia 1.4.30 为当时最新稳定版；【勘误 2026-10-28】仓库现为 `elysia ^1.2.0`，`node_modules` 解析到 1.4.30）
> 目标：把现在「一个 switch 分平台 + controller 里塞解析 + 只有小红书内存 Map 缓存 + 直链直接下发前端」的结构，改造成可插件扩展、可横向扩容、可观测、可测试的形态。
> 兄弟文档：平台侧的接口/风控/字段事实见 [01-douyin-tiktok-api.md](./01-douyin-tiktok-api.md) 与 [02-platforms.md](./02-platforms.md)，本文只讲**工程架构**，不重复平台逆向细节。
> 标注约定：**【实测】**= 本次调研真实跑出来的结果；**【源码】**= 读对应仓库源码；**【未核验】**= 只有二手资料或条件不满足未复现，落地前必须自测。**本文不含任何编造的 star 数、体积、额度**。

---

## 0. 结论先行

### 0.1 三条最关键的结论

**① 架构上要抄的不是「注册表」，而是 yt-dlp 的「声明式匹配 + 纯函数解析 + 通道降级」三段切分。**
yt-dlp 有 1100+ 个 extractor 类（`_extractors.py` 实测导入 1187 个 `*IE`）却不需要中心 switch：每个 extractor 是一份自描述声明（`_VALID_URL` 正则 + `_TESTS` 测试），框架用 `suitable(url)` 线性匹配、用 `_CLASS_LOOKUP` 字典做 O(1) 取用、`GenericIE` 兜底在最后。真正值钱的是**约束**：extractor 只负责「把 URL 变成 JSON」，下载/重试/代理/格式选择全在框架层。对应到本项目：`fetch()` 是平台包里唯一允许 IO 的方法，`parse()` 必须是纯函数——这一条决定了你能不能写测试。

**② 直链必须服务端中转，而且两个平台的 Referer 策略完全相反，不能一套配置通吃。**
【实测】抖音 `*.douyinvod.com`：空 Referer → **403**，`Referer: https://www.douyin.com/` → 200；小红书 `*.xhscdn.com`：空 Referer → **200**，`Referer: https://evil.example.com/` → **403**。
即：**抖音必须「注入」Referer，小红书必须「删除」Referer**。更要紧的是——[02-platforms.md](./02-platforms.md) 里「小红书不需要 Referer、可直链给前端」的结论**只验证了空 Referer（curl 场景）**；浏览器 `<video>` 播放时会自动带 `Referer: https://你的站点/`，实测这条路径返回 **403**。所以「直链下发前端 + `referrerpolicy="no-referrer"`」虽然可行，但只要有一个客户端不遵守就是 403，**中转是唯一稳的方案**。

**③ 缓存的对象必须是「元数据 + 可重建的 key」，不是「直链 URL」。**
【实测】抖音两次独立解析同一视频，拿到的 URL 中 32 位 hex token、8 位 hex 时间戳、`dy_q`、`l`、`ft` **全部不同**，但路径里的 `tos-cn-ve-15/<object-id>` 恒定 → 以 URL 为 cache key 命中率恒为 0，以 URL 为缓存值是必然过期。正确姿势：缓存 `objectKey` + `expiresAt`，命中后按需重签或直接代理；TTL 由 URL 自带的过期时刻反推（`x-expires` 或路径 hex 时间戳），而不是拍一个「1 小时」。

### 0.2 现状诊断（对照真实代码，逐条给病灶）

| 位置 | 现状 | 后果 | 归属章节 |
|---|---|---|---|
| `src/controllers/platform-transfer.ts` | `switch (mainDomain)` 写死 2 个平台 | 加平台要动 controller，且与解析逻辑耦合 | §2 §3 |
| `src/controllers/platform-transfer.ts` | `case "xiaohongshu.com"` 直接 `await parseXiaohongshuContent({body:{url}} as Context)` | 为了复用签名把 Elysia `Context` 强转塞进 parser——parser 依赖框架，无法单测 | §3 |
| `src/controllers/core/xiaohongshu.ts` | 326 行，抓取 + 翻页 + DOM 选择器 + 缓存 + 响应信封全在一起 | 平台改版时无法定位是「抓取失败」还是「字段变了」；覆盖率 1.69% | §9 |
| `src/controllers/core/xiaohongshu.ts` | `catch` 里返回 `success:false` 但 **HTTP 200**，且 `data` 里塞空结构 | 前端无法区分「平台挂了」和「视频不存在」 | §7 |
| `src/utils/api-parser.ts` | `parseVideo` 捕获不到 API 就退到 `parseGalleryFromPage`，后者失败返回 `{title:"",resources:[]}` | controller 判 `if (apiResult)` 为真 → **用户拿到 `success:true` + 空资源**（这是当前最严重的正确性 bug） | §7 §9 |
| `src/utils/api-parser.ts` | 每次都 `browserManager.createPage()`，无并发上限、无超时、无取消 | 10 个并发就是 10 个 Chromium page，内存打满后 OOMKill | §6 |
| `src/utils/cache.ts` | 进程内 `Map` + `setInterval` 清理，仅小红书在用，key 只去 4 个 query 参数 | 多副本不共享；重启即失效；`setInterval` 还会挂住 `bun test` 进程 | §5 |
| `src/routes/public.routes.ts` | `/public/cache/clear`、`/cache/delete` **无鉴权** | 任何人可清空线上缓存（可被用来打穿上游、放大风控） | §6 |
| `src/hooks/error.hooks.ts` | 所有错误统一 `set.status = 400` + `text/plain` | 破坏 JSON 契约；参数校验错误、内部异常、404 全糊成 400 | §7 |
| `src/utils/puppeteer.ts` | 文件里硬编码某邮箱账号 / 明文密码 + 登录某解析站域名（原文含真实凭据，已抹） | **凭据泄漏 + 供应链风险**，且这段代码与业务无关，必须立刻删 | §0.3 |
| `src/bootstrap/app.ts` | `cors({ origin: "*" })` 且无鉴权 | 公开可刷；配合中转代理就是免费 CDN | §4 §6 |
| 全仓库 | 0 个测试文件，`package.json` 无 `test` 脚本 | 重构无安全网 | §9 |

### 0.3 先做的三件「与架构无关但必须马上做」的事

1. **删除 `src/utils/puppeteer.ts` 里 `PuppeteerManager`（第三方解析站登录）整段**，并轮换该账号密码——密码已进 git 历史。
2. `grep` 确认真实凭据无残留，必要时 `git filter-repo` 清历史。
3. `/public/cache/*` 三个管理端点先加 `Authorization` 校验或直接下线。

---

## 1. 架构总览

### 1.1 目标分层（依赖单向向下，平台包不 import 框架）

```
                    ┌──────────────────────────────────────────┐
   HTTP 层          │ routes/  (Elysia)                        │
                    │  /parse  /media  /health  /ready /metrics │
                    └───────────────┬──────────────────────────┘
                                    │ 只做：解析入参、调 service、套信封
                    ┌───────────────▼──────────────────────────┐
   应用服务层        │ services/                                │
                    │  parse-service   ← 编排：缓存→限流→通道降级 │
                    │  media-proxy     ← 流式中转 + 签名          │
                    │  cache / limiter / breaker                │
                    └───────────────┬──────────────────────────┘
                                    │ 依赖接口，不依赖实现
                    ┌───────────────▼──────────────────────────┐
   平台适配层        │ platforms/                               │
                    │  registry.ts  (Map<Platform, Adapter>)    │
                    │  douyin/{adapter,fetch,parse,sign}.ts     │
                    │  xhs/{adapter,fetch,parse,tls}.ts         │
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
   基础设施层        │ infra/  http(签名UA/TLS) browser(pool)     │
                    │        redis  metrics  logger             │
                    └──────────────────────────────────────────┘
```

**铁律（写进 review checklist）**：
- `platforms/**` 不许 `import { Elysia }`、不许 `import { redis }`、不许 `console.log`。
- `routes/**` 不许出现 `if (platform === 'douyin')`。
- 新增平台只允许改「新增一个目录 + 在 registry 里加一行」（或者连 registry 都不改，见 §3.4）。

### 1.2 与现状的映射表

| 现有文件 | 去向 |
|---|---|
| `controllers/platform-transfer.ts` | 拆成 `routes/parse.ts`（薄）+ `services/parse-service.ts`（编排） |
| `controllers/core/xiaohongshu.ts` | 拆成 `platforms/xhs/{adapter,fetch,parse}.ts`；DOM 翻页逻辑**整体废弃**，改用 `__INITIAL_STATE__`（见 02 文档 §1） |
| `utils/api-parser.ts` | 拆成 `platforms/douyin/fetch.ts`（纯 HTTP）+ `infra/browser/`（仅兜底通道） |
| `utils/cache.ts` | 换 `lru-cache`（L1）+ 可选 Redis（L2），并加 `expiresAt` 语义（§5） |
| `utils/extractUrl.ts` | → `core/url.ts`，并补「短链展开」与「host 白名单」 |
| `hooks/error.hooks.ts` | → `core/errors.ts` + `http/error-handler.ts`（§7） |
| `utils/puppeteer.ts` | 删 `PuppeteerManager`；`browserManager` → `infra/browser/pool.ts` |

---

## 2. yt-dlp 的 extractor 架构（逐层解剖，附源码位置）

> 版本：`master` 分支，2026-10-23 抓取。仓库 201,170★、Unlicense（`gh api` 实测，2026-10-24 16:19 CST）。

### 2.1 目录组织：一个文件一个平台，`_extractors.py` 是唯一聚合点

```
yt_dlp/
├── extractor/
│   ├── common.py          # InfoExtractor 基类（4185 行，全部公共能力）
│   ├── _extractors.py     # ★ 唯一聚合点：from .xxx import XxxIE 的清单（纯 import，无逻辑）
│   ├── extractors.py      # ★ 把聚合结果变成 _CLASS_LOOKUP 字典，决定匹配顺序
│   ├── lazy_extractors.py # 构建期生成的「只有 _VALID_URL 的壳」，避免启动 import 全部模块
│   ├── generic.py         # GenericIE —— 兜底（从任意网页找 <video>/JSON-LD）
│   ├── tiktok.py          # TikTokBaseIE + TikTokIE + DouyinIE + TikTokVMIE ...
│   └── xiaohongshu.py     # XiaoHongShuIE（109 行，纯 HTTP）
├── plugins.py             # 插件发现/加载（namespace package）
└── globals.py             # extractors / plugin_ies_overrides 等全局上下文
```

关键设计：**平台文件之间不互相 import，聚合只发生在 `_extractors.py`**。
`_extractors.py` 全部内容就是几百行 `from .abc import ABCIE, ...`（[源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/_extractors.py)）。这让「新增一个平台」= 新增一个文件 + 加一行 import，冲突面极小（几百人同时提 PR 也不打架）。

`extractors.py` 把清单变成查表，并且**显式规定匹配顺序**（[源码 L1-L40](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/extractors.py)）：

```python
_CLASS_LOOKUP = dict(itertools.chain(
    # Youtube first to improve matching performance
    ((name, value) for name, value in members if '.youtube' in value.__module__),
    # Add Generic last so that it is the fallback
    ((name, value) for name, value in members if name != 'GenericIE'),
    (('GenericIE', _extractors.GenericIE),),
))
```

三点可直接照搬：
1. **热路径平台排最前**（YouTube 流量最大，先匹配它省时间）。
2. **兜底 extractor 永远最后**（`GenericIE` 匹配 `.*`，放前面会吞掉一切）。
3. **惰性加载**：`lazy_extractors.py` 构建期生成，只保留 `_VALID_URL`，把「启动时 import 上千个模块」变成「匹配到再 import 一个」。对应 TS 就是动态 `import()`。

### 2.2 基类契约：5 个要素就能定义一个新平台

`InfoExtractor`（[common.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py)）里与本项目相关的只有这几处：

```python
class InfoExtractor:
    _VALID_URL = None          # 正则（或 tuple of 正则），必须含 (?P<id>...)
    IE_NAME = ...              # 展示名，默认取类名去掉 IE 后缀
    _TESTS = []                # ★ 自测用例，见 §2.6

    @classmethod
    def _match_valid_url(cls, url):                       # L616
        if '_VALID_URL_RE' not in cls.__dict__:           # 每个子类缓存自己的编译结果
            cls._VALID_URL_RE = tuple(map(re.compile, variadic(cls._VALID_URL)))
        return next(filter(None, (r.match(url) for r in cls._VALID_URL_RE)), None)

    @classmethod
    def suitable(cls, url):                               # L627
        return cls._match_valid_url(url) is not None

    @classmethod
    def _match_id(cls, url):                              # L634
        return cls._match_valid_url(url).group('id')

    def _real_extract(self, url):                         # L829
        raise NotImplementedError('This method must be implemented by subclasses')
```

调用链在外层：`YoutubeDL.extract_info(url)` → 遍历 `gen_extractors()` → 第一个 `suitable(url)` 为真的 → `ie.extract(url)`（做 cookiejar、参数校验、错误包装）→ `_real_extract(url)` 返回 `info_dict`。

**这个契约最值得抄的是「`suitable` 不做 IO，`_real_extract` 不做分派」**：匹配纯字符串，解析纯逻辑，框架负责「谁来调、失败了怎么办」。

### 2.3 小红书 extractor：109 行、纯 HTTP、零浏览器

`XiaoHongShuIE` 是本次调研里**最有价值的参照物**——它证明小红书的完整信息（标题/作者/图集/视频/多清晰度）**一次性**就在页面 HTML 的 `window.__INITIAL_STATE__` 里（[源码](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py)）：

```python
class XiaoHongShuIE(InfoExtractor):
    _VALID_URL = r'https?://www\.xiaohongshu\.com/(?:explore|discovery/item)/(?P<id>[\da-f]+)'
    IE_DESC = '小红书'

    def _real_extract(self, url):
        display_id = self._match_id(url)
        webpage = self._download_webpage(url, display_id)
        initial_state = self._search_json(
            r'window\.__INITIAL_STATE__\s*=', webpage, 'initial state', display_id,
            transform_source=js_to_json)

        note_info = traverse_obj(initial_state, ('note', 'noteDetailMap', display_id, 'note'))
        video_info = traverse_obj(note_info, ('video', 'media', 'stream', ..., ...))

        formats = []
        for info in video_info:            # ★ 多清晰度：一条 stream 一个 format
            format_info = traverse_obj(info, {
                'fps': ('fps', {int_or_none}), 'width': ('width', ...),
                'height': ('height', ...), 'vcodec': ('videoCodec', {str}),
                'acodec': ('audioCodec', {str}), 'tbr': ('avgBitrate', ...),
                'format': ('qualityType', {str}), 'filesize': ('size', ...),
            })
            formats.extend(traverse_obj(info, (('masterUrl', ('backupUrls', ...)), {
                lambda u: url_or_none(u) and {'url': u, **format_info}})))

        if origin_key := traverse_obj(note_info, ('video', 'consumer', 'originVideoKey', {str})):
            # Not using a head request because of false negatives
            urlh = self._request_webpage(
                f'https://sns-video-bd.xhscdn.com/{origin_key}', display_id,
                'Checking original video availability', 'Original video is not available', fatal=False)
            if urlh:
                formats.append({'format_id': 'direct', 'url': urlh.url,
                                'filesize': int_or_none(urlh.get_header('Content-Length')),
                                'quality': 1})   # ★ quality=1 = 最高优先

        return {'id': display_id, 'formats': formats, 'thumbnails': thumbnails, ...}
```

可抄的三点：
- **`backupUrls` 是 fallback 列表**，不是「挑一个」——多 CDN 域名时全部保留成候选，下载层失败可切。
- **`originVideoKey` → 拼 URL** 而不是存 URL：这正是 §5「缓存 key 而不是 URL」的来源。key 是稳定对象标识，URL 是可重建的派生值。
- **`quality` 字段做语义排序**，不用 `format_id` 字符串比较。

### 2.4 抖音 extractor：先纯 HTTP，失败才提示要 cookie

`DouyinIE`（[tiktok.py#L1371](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py#L1371)）的 `_real_extract` 只有 10 行：

```python
class DouyinIE(TikTokBaseIE):
    _VALID_URL = r'https?://(?:www\.)?douyin\.com/video/(?P<id>[0-9]+)'
    _UPLOADER_URL_FORMAT = 'https://www.douyin.com/user/%s'
    _WEBPAGE_HOST = 'https://www.douyin.com/'

    def _real_extract(self, url):
        video_id = self._match_id(url)
        detail = traverse_obj(self._download_json(
            'https://www.douyin.com/aweme/v1/web/aweme/detail/', video_id,
            'Downloading web detail JSON', 'Failed to download web detail JSON',
            query={'aweme_id': video_id}, fatal=False), ('aweme_detail', {dict}))
        if not detail:
            # TODO: Run verification challenge code to generate signature cookies
            raise ExtractorError(
                'Fresh cookies (not necessarily logged in) are needed',
                expected=not self._get_cookies(self._WEBPAGE_HOST).get('s_v_web_id'))
        return self._parse_aweme_video_app(detail)
```

注意 `expected=` 这个参数：**它区分「用户环境问题」和「我们的 bug」**。有 cookie 还拿不到 = 我们代码坏了（打印 bug report 模板）；没 cookie 拿不到 = 用户看提示。这是错误码设计里最容易被忽略的一维（详见 §7）。

> 与本项目的关系：01 文档实测「带 `Origin: https://open.douyin.com` 就能拿完整 detail，不需要签名/cookie」。所以**纯 HTTP 是主通道，浏览器只是兜底**——和现状（先开浏览器）正好相反。

### 2.5 短链与重定向：HEAD 拿最终 URL，再交给下一个 extractor

短链不硬编码跳转规则，而是「解析一跳，然后把结果重新丢回分派器」（[tiktok.py#L1511](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py#L1511)）：

```python
class TikTokVMIE(InfoExtractor):
    _VALID_URL = r'https?://(?:(?:vm|vt)\.tiktok\.com|(?:www\.)tiktok\.com/t)/(?P<id>\w+)'
    IE_NAME = 'vm.tiktok'

    def _real_extract(self, url):
        new_url = self._request_webpage(
            HEADRequest(url), self._match_id(url),
            headers={'User-Agent': 'facebookexternalhit/1.1'}).url
        if self.suitable(new_url):        # ★ 防环：跳完还是自己
            raise UnsupportedError(new_url)
        return self.url_result(new_url)   # ★ 交回框架重新分派，不自己解析
```

四个设计点：
1. **HEAD 而不是 GET**：只取 `Location` 链，不下载 body。
2. **换 UA**（`facebookexternalhit`）：分享页对社交爬虫放行，比浏览器 UA 更省事——这条在抖音/小红书短链上同样值得实测。
3. **防环**：`self.suitable(new_url)` 为真说明 302 没生效或指回自己，抛 `UnsupportedError` 终止，避免无限递归。
4. **`url_result()` 是「委托」而非「递归调用」**：返回一个「请解析这个新 URL」的标记，由框架重新走分派 → 短链解析和内容解析是两个 extractor，**互不知道对方存在**。

对应 TS 的核心接口就是：`resolve(url): Promise<{ finalUrl, redirected: boolean }>` 与 `registry.dispatch(finalUrl)`，且 `dispatch` 要做 depth 限制。

### 2.6 测试内嵌：`_TESTS` 就是契约

每个 extractor 自带测试用例，字段是**外部可验证的事实**而不是内部实现（[xiaohongshu.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py)）：

```python
_TESTS = [{
    'url': 'https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9',
    'md5': '2a87a77ddbedcaeeda8d7eae61b61228',      # 下载后比对，验证「真的能拿到内容」
    'info_dict': {
        'id': '6411cf99000000001300b6d9', 'ext': 'mp4',
        'title': '香妃蛋糕也太香了吧🔥不需要卷❗️绝对的友好',
        'uploader_id': '5c31698d0000000007018a31',
        'duration': 101.726,
        'thumbnail': r're:https?://sns-webpic-qc\.xhscdn\.com/\d+/[a-z0-9]+/[\w]+',   # ★ 正则而非定值
        'tags': [...],
    },
}, {
    'url': 'https://www.xiaohongshu.com/discovery/item/67405174...?xsec_token=CBge...',
    'only_matching': True,     # ★ 只验证「URL 能被这个 extractor 匹配」，不发请求
}]
```

三种用例粒度，正好对应三档测试成本：
- `only_matching` → 纯字符串测试（0 网络，CI 每次跑）。
- `info_dict` 里的 `re:` 正则 → 结构契约（字段在不在、形态对不对）。
- `md5` → 端到端内容校验（真下载，只手动/定时跑）。

`skip` 字段还支持标注「这条链接已经失效」而不删用例——保留历史样本价值。

### 2.7 插件机制：namespace package + 多目录 + 优先级 + 失败隔离

官方文档（[README#plugins](https://github.com/yt-dlp/yt-dlp#plugins)、[Plugin-Development wiki](https://github.com/yt-dlp/yt-dlp/wiki/Plugin-Development)）：

- 目录约定：`yt_dlp_plugins/extractor/<name>.py`，包名固定，**插件作者不需要改 yt-dlp 源码**。
- 搜索路径（全部会扫，取并集）：`${XDG_CONFIG_HOME}/yt-dlp/plugins/*/yt_dlp_plugins/`、`~/.yt-dlp/plugins/`、`/etc/yt-dlp/plugins/`、**可执行文件同级 `yt-dlp-plugins/`**、`sys.path`。
- **extractor 插件优先于内置**（`plugin_ies_overrides` 全局表实现覆盖）。
- `YTDLP_NO_PLUGINS=1` 一键禁用——排障时不用卸载。
- 加载器是 `importlib` 的 `MetaPathFinder` + 虚拟 namespace package（[plugins.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/plugins.py)），单个插件 import 失败只记 warning，**不影响其他插件**。

**TS 侧怎么等价实现**（不需要 namespace package 这么重）：

```ts
// platforms/registry.ts
const sources = [
  () => import('./douyin/adapter.ts'),
  () => import('./xhs/adapter.ts'),
  // 可选：外部插件目录（对应 yt-dlp 的 plugins/ 目录）
  ...(await scanExternalAdapters(process.env.PLATFORM_PLUGIN_DIR)),
];
```

并且必须补上 yt-dlp 有的三件事：**同名冲突检测（后加载者覆盖并 warn）、加载失败隔离（try/catch + 跳过）、禁用开关**。

### 2.8 该抄 / 不该抄

| 该抄 | 理由 |
|---|---|
| `_VALID_URL` 单一正则 + `suitable()` | 匹配即声明，加平台零改动 |
| `_match_id` 只取 `id`，其余字段用命名组 | 下游缓存 key、日志都用得上 |
| 短链「解析一跳 → 委托分派」+ 防环 | 抖音 `v.douyin.com`、小红书 `xhslink.com` 都是这个模式 |
| `formats[]` 统一形状（url/format_id/ext/width/height/vcodec/tbr/filesize/quality） | 多清晰度、多备份域、多资源类型都能塞进同一结构 |
| `_TESTS` 内嵌 + `only_matching` 分级 | 平台包自带回归，不必另建测试目录 |
| `expected=` 区分用户错/程序错 | 直接映射到 4xx/5xx 与告警级别 |
| 插件失败隔离 + 禁用开关 | 一个平台改版不该拖垮整站 |

| 不该抄 | 理由 |
|---|---|
| 「上千个 extractor」才需要的构建期 `lazy_extractors.py` 代码生成 | 你只有 3–5 个平台，动态 `import()` 足够；生成脚本是纯负债 |
| 把 `formats` 的排序/选择逻辑放进 extractor | yt-dlp 有 `FormatSorter` 做这层；你要的是「原样返回所有候选 + 前端选」 |
| Python 的 `traverse_obj` 深度嵌套写法 | TS 里等价物是 zod/手写 guard，嵌套过深反而不可调试 |
| 一个 URL 一个 extractor 的粒度 | 抖音的 `video/`、`note/`、`user/`、`live/` 建议合成一个 adapter 内部按 `kind` 分派，减少文件数 |

---

## 3. 本项目目录结构与接口签名草案

### 3.1 目录结构（可直接照建）

```
src/
├── index.ts                     # 只做 startServer()
├── config.ts                    # zod 校验的 env（含默认值），启动即 fail-fast
├── bootstrap/
│   ├── app.ts                   # createApp()：装配插件，可被测试直接调用
│   └── server.ts                # listen + 优雅关闭（SIGTERM）
├── routes/
│   ├── parse.routes.ts          # POST /parse  GET /parse?url=
│   ├── media.routes.ts          # GET|HEAD /media/:sig
│   ├── ops.routes.ts            # /health /ready /metrics
│   └── admin.routes.ts          # /admin/cache/*（必须鉴权）
├── services/
│   ├── parse.service.ts         # ★ 编排：cache → breaker → http → browser → 信封
│   ├── media-proxy.service.ts   # ★ 流式中转 + HMAC 签名校验
│   ├── cache/
│   │   ├── two-level.ts         # L1(lru-cache) + L2(redis) + singleflight + SWR
│   │   ├── expiry.ts            # urlExpiry / earliestExpiry / computeTtlMs
│   │   └── types.ts             # ParseResult / MediaAsset / CachePolicy
│   └── limiter.ts               # elysia-rate-limit + Redis context
├── platforms/
│   ├── types.ts                 # ★ PlatformAdapter / MatchResult / FetchCtx
│   ├── registry.ts              # ★ 构建 + getAdapter + dispatch（含 depth 限制）
│   ├── douyin/
│   │   ├── adapter.ts           # _VALID_URL 等价物：match + capabilities
│   │   ├── fetch.ts             # 唯一允许 IO：detail API / 短链展开
│   │   ├── parse.ts             # ★ 纯函数：aweme_detail → ParsedMedia
│   │   └── __fixtures__/aweme-detail.json
│   └── xhs/
│       ├── adapter.ts
│       ├── fetch.ts             # __INITIAL_STATE__ / xsec_token
│       ├── parse.ts             # ★ 纯函数
│       └── __fixtures__/initial-state.json
├── core/
│   ├── errors.ts                # AppError + ErrorCode 枚举 + HTTP 映射
│   ├── envelope.ts              # ok() / fail()，唯一响应工厂
│   └── url.ts                   # extractUrl / 短链判定 / host 白名单
├── infra/
│   ├── http/client.ts           # 统一 UA / 超时 / signal / TLS impersonation
│   ├── browser/pool.ts          # 信号量 + context 隔离 + 硬超时
│   ├── redis.ts                 # 单例 + fail-open
│   ├── metrics.ts               # prom-client registry
│   └── logger.ts                # pino + redact
└── test-helpers/                # FakePage / 录制脚本（也可放 tests/）
tests/
├── unit/  parser/  contract/  api/  e2e/
├── fixtures/                    # 大样本放这里，平台包内只放小样本
└── bunfig.toml
```

### 3.2 核心接口（签名即契约，实现前先冻结）

```ts
// platforms/types.ts
import type { ParseResult, MediaAsset } from '../services/cache/types.ts';

export type Platform = 'douyin' | 'xhs';

/** 匹配结果：纯数据，不含行为 */
export interface MatchResult {
  platform: Platform;
  /** 平台内稳定 ID（用于缓存 key、日志、指纹） */
  id: string;
  /** 资源类型：视频 / 图集 / 直播 / 主页（决定后续流程） */
  kind: 'video' | 'note' | 'images' | 'live' | 'profile' | 'unknown';
  /** 短链需要先展开（此时 id 可能是短码） */
  needsResolve: boolean;
  /** 原样保留的查询参数（xsec_token 之类，必须参与后续请求） */
  params?: Record<string, string>;
}

/** 通道能力：决定降级链是否可用 */
export interface Capabilities {
  /** 纯 HTTP 能否完成 */
  http: boolean;
  /** 必须浏览器（JS 渲染 / 风控挑战） */
  browser: boolean;
  /** 需要浏览器级 TLS 指纹（小红书实测需要，见 02 文档） */
  tlsImpersonation: boolean;
  /** 需要 cookie / 访客票据 */
  auth: 'none' | 'guest' | 'optional-user';
  /** 资源类型支持 */
  kinds: ReadonlyArray<MatchResult['kind']>;
}

/** IO 上下文：超时/取消/通道选择都从这里进，平台包不自己造 */
export interface FetchCtx {
  signal: AbortSignal;
  /** 当前尝试的通道；平台可按 channel 调整策略 */
  channel: 'http' | 'browser';
  /** 复用连接、带 cookie jar 的客户端（由 infra 注入） */
  http: HttpClient;
  /** 仅 channel==='browser' 时非空 */
  page?: BrowserPage;
  logger: Logger;
}

/**
 * 平台适配器。三条硬约束（照 Evil0ctal 的 PlatformAdapter 裁剪）：
 *  1. match() 必须是纯函数（可被 10 万次/秒调用，无 IO）
 *  2. fetch() 是唯一允许 IO 的方法
 *  3. parse() 必须是纯函数（同输入同输出，可 fixture 回归）
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** host 白名单：兼作 SSRF 防护的第一道闸 */
  readonly hosts: readonly string[];
  readonly capabilities: Capabilities;

  match(url: URL): MatchResult | null;

  /** 短链展开：只解析一跳，返回新 URL；不负责内容解析 */
  resolve?(url: URL, ctx: FetchCtx): Promise<URL>;

  /** 抓原始载荷：返回「未解析的中间态」，便于 fixture 落盘 */
  fetch(input: MatchResult, url: URL, ctx: FetchCtx): Promise<RawPayload>;

  /** 纯函数：原始载荷 → 统一结果 */
  parse(raw: RawPayload, input: MatchResult): ParseResult;
}

/** 中间态必须是可 JSON 序列化的（fixture 才能录） */
export interface RawPayload {
  /** 来源标记，便于排查「哪条通道拿到的」 */
  via: 'api' | 'html-embedded-json' | 'browser-intercept';
  /** 抓取时刻（Unix 秒），用于计算直链剩余寿命 */
  fetchedAt: number;
  /** 原始 JSON / HTML / 拦截到的响应体 */
  body: unknown;
  /** 上游响应头里对解析有用的部分（content-type 等） */
  meta?: Record<string, string>;
}
```

```ts
// platforms/registry.ts
export interface Registry {
  get(platform: Platform): PlatformAdapter;          // 未注册 → AppError(UNSUPPORTED_PLATFORM)
  match(url: URL): PlatformAdapter | null;           // 遍历，O(n) n<=5
  /** 短链 → 最终 URL → 再匹配；带深度上限，防环 */
  dispatch(url: URL, ctx: FetchCtx, depth?: number): Promise<{ adapter: PlatformAdapter; input: MatchResult; url: URL }>;
  /** 只读快照，给 /health 和文档站用 */
  list(): ReadonlyArray<{ platform: Platform; hosts: string[]; capabilities: Capabilities }>;
}
```

`dispatch` 的语义（照 `TikTokVMIE` + `url_result`）：

```ts
async function dispatch(url, ctx, depth = 0) {
  if (depth > 3) throw new AppError('INVALID_URL', { reason: 'redirect_loop' });
  const adapter = registry.match(url);
  if (!adapter) throw new AppError('UNSUPPORTED_PLATFORM', { url: url.hostname });
  const input = adapter.match(url)!;
  if (!input.needsResolve || !adapter.resolve) return { adapter, input, url };

  const finalUrl = await adapter.resolve(url, ctx);
  if (registry.match(finalUrl)?.platform === adapter.platform && finalUrl.href === url.href) {
    throw new AppError('UNSUPPORTED_CONTENT', { reason: 'resolve_noop' }); // 对应 suitable() 防环
  }
  return dispatch(finalUrl, ctx, depth + 1);   // 委托，不嵌套调用 parse
}
```

### 3.3 统一数据模型（对外 JSON 的最小集）

```ts
// services/cache/types.ts
export interface MediaAsset {
  type: 'video' | 'image' | 'audio' | 'cover';
  /** ★ 可重建 URL 的稳定标识（抖音 object-id / 小红书 originVideoKey） */
  key?: string;
  url: string;
  /** 直链自身的过期时刻（Unix 秒）；读不出则 undefined */
  expiresAt?: number;
  contentType?: string;
  width?: number; height?: number; durationMs?: number; size?: number;
  /** 多个备份域（yt-dlp 的 backupUrls 语义） */
  backups?: string[];
  /** ★ 该资源被代理时必须注入的头（由平台层声明，代理层执行） */
  proxyHeaders?: { referer?: string | null; userAgent?: string };
}

export interface ParseResult {
  platform: Platform;
  id: string;
  title: string;
  author: { name: string; avatar?: string; id?: string };
  assets: MediaAsset[];
  /** 所有直链里最早过期的那一个 */
  expiresAt?: number;
  parsedAt: number;          // Unix 秒
  /** 解析通道，用于指标与降级归因 */
  via: 'http' | 'browser';
}
```

> 对比现状：`ContentInfo.resources: {type, urls[]}[]` 丢掉了「过期时间」「备份域」「代理头」「尺寸/时长」——这些恰好是中转与缓存必需的元数据。**建议保留 `resources` 作为兼容字段（由 `assets` 派生），但内部一律用 `assets`。**

### 3.4 「加平台 = 加一个目录」怎么强制

两个可执行的手段（比写在文档里管用）：

1. **注册表自检测试**：启动时（或 `bun test`）遍历 `platforms/*/adapter.ts`，断言「目录名 == `adapter.platform`」「`hosts` 非空」「`match` 对目录内 fixture 里的 URL 全部命中」。少一个就 fail。
2. **禁止手写 switch 的 lint**：`grep -rn "switch (.*platform" src/` 加入 CI 检查，命中即失败。

Bun 已支持 `import.meta.glob`（2026 年合入，见 [oven-sh/bun#44833](https://github.com/oven-sh/bun/pull/44833)），可以这样零维护加载：

```ts
const modules = import.meta.glob('./*/adapter.ts', { eager: true }) as Record<string, { adapter: PlatformAdapter }>;
export const adapters = Object.values(modules).map(m => m.adapter);
```

但**建议阶段一用显式数组**：静态可查、IDE 可跳转、`bun build --compile` 打包行为确定。等平台超过 8 个再换 glob。

---

## 4. 中转代理（防盗链的工程解法）

### 4.1 防盗链实测矩阵（这是配置的唯一依据）

【实测】2026-10-24，真实抖音/小红书视频直链，30+ 组组合：

| 平台 / 域名 | 空 Referer | `Referer: 平台域名` | 第三方 Referer | UA 校验 | 结论 |
|---|---|---|---|---|---|
| 抖音 `*.douyinvod.com`（web 播放链） | **403** | **200** | 403 | 不校验（curl UA 也 200） | **必须注入** `https://www.douyin.com/` |
| 抖音 `aweme.snssdk.com/aweme/v1/play/`（302） | 302 无需头 | 302 | 302 | — | 302 本身免头，落地链按上一行 |
| 抖音 302 落地链（`a=1128`） | **200** | 200 | **403** | 不校验 | 空 Referer 也放行，但注入更稳 |
| 抖音 `*.douyinpic.com`（图集） | 200 | 200 | **200** | 不校验 | 可直连，无需中转 |
| 小红书 `*.xhscdn.com`（`sns-video-*`） | **200** | 200 | **403** | 不校验 | **必须删除** Referer |

补充实测细节（全部来自同一批样本）：
- Referer 校验是**严格域名后缀**：`https://www.douyin.com.evil.com/` → 403，`https://notdouyin.com/` → 403。所以「随便带个含 douyin 的字符串」无效。
- 403 响应体是 openresty 页面，带 `Forbid_code: 020200`，且**响应头里有 `Access-Control-Allow-Origin: *`** → 前端 `<video>` 拿到的是「媒体解码错误」而不是 CORS 错误，排查时别往跨域方向找。
- 抖音直链 query 里**没有** `x-expires`/`x-signature`；签名与时效在**路径段**：`/<32位hex>/<8位hex 时间戳>/video/tos/cn/tos-cn-ve-15/<object-id>/`。样本中 `0x6addb5f0` = 2026-10-25 15:55，签发于 2026-10-24 15:52 → 约 24h。
- 小红书 `sns-video-bd.xhscdn.com/spectrum/...` 原片返回 `Content-Type: application/octet-stream` → **代理必须改写 MIME**，否则部分浏览器拒播；且该样本 135 MB，必须流式。

> 与 [02-platforms.md](./02-platforms.md) §10 的差异说明：02 测的是「无 Referer」（curl 默认不带），结论「不需要 Referer」在 **curl 场景**成立；但浏览器 `<video>` 会带**本站 Referer**，小红书对该值返回 403。两者不矛盾，**是测试条件不同**。生产上必须按「浏览器会带 Referer」这个前提设计。

### 4.2 三种中转方案选型

| | ① 302 到反代 URL | ② 流式回源（pipe） | ③ 先落地再返回 |
|---|---|---|---|
| Range 透传 | 天然（浏览器第二次请求直接打到反代） | 自己转发并回 206 | 需实现偏移读取 |
| HEAD | 天然 | 需显式注册（Elysia 有坑，见 4.3） | 需显式 |
| 首字节延迟 | 多一跳 RTT | 最低 | 最高 |
| 内存/磁盘 | 无 | 无（ReadableStream 背压） | 需磁盘/对象存储 |
| 适用 | 用户点「下载」、需要长期可分享的链接 | **在线播放（默认走这条）** | 需要转码/切片时 |

**推荐：播放走 ②，下载按钮走 ①，③ 不做。**

### 4.3 Bun + Elysia 流式代理（已跑通，含三个实测坑）

```ts
// services/media-proxy.service.ts（核心逻辑，已实测：Range/HEAD/302/字节校验全通过）
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const SECRET = process.env.PROXY_SECRET!;
const TTL = 600;                    // 签名有效期（秒），务必短

/** 每个上游域名该注入什么头（后缀匹配，取最长） */
const RULES: Record<string, { referer?: string; userAgent?: string }> = {
  'douyinvod.com':    { referer: 'https://www.douyin.com/' },  // 实测：空 Referer 403
  'douyin.com':       { referer: 'https://www.douyin.com/' },
  'snssdk.com':       { referer: 'https://www.douyin.com/' },
  'douyinpic.com':    {},                                       // 实测：不校验
  'xhscdn.com':       {},                                       // 实测：必须「没有」Referer
};

const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade','host','content-length']);

const sign = (u: string, exp: number) =>
  createHmac('sha256', SECRET).update(`${u}\n${exp}`).digest('hex').slice(0, 32);

export function signMediaUrl(url: string) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const q = new URLSearchParams({
    u: Buffer.from(url).toString('base64url'), exp: String(exp), sig: sign(url, exp),
  });
  return `/media?${q}`;
}

/** 手动跟随 302：每一跳重新做 SSRF 校验 + 重新注入头 */
async function fetchUpstream(target: string, req: Headers, method: string, depth = 0): Promise<Response> {
  if (depth > 5) throw new Error('too_many_redirects');
  const u = await assertSafe(target);                 // 见 4.5
  const rule = matchRule(u.hostname)!;

  const h = new Headers();
  for (const k of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
    const v = req.get(k); if (v) h.set(k, v);         // ★ 只白名单透传，绝不整体复制
  }
  h.set('user-agent', rule.userAgent ?? UA);
  if (rule.referer) h.set('referer', rule.referer);
  else h.delete('referer');                           // 小红书：必须不存在
  h.set('accept-encoding', 'identity');               // 媒体不压缩，否则 Range 字节语义错乱

  const res = await fetch(u, { method, headers: h, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    await res.body?.cancel();                         // ★ 必须取消，否则连接泄漏
    if (!loc) return res;
    return fetchUpstream(new URL(loc, u).href, req, method, depth + 1);
  }
  return res;
}

export async function handleMedia({ query, request, set }: any) {
  const raw = Buffer.from(String(query.u ?? ''), 'base64url').toString('utf8');
  const exp = Number(query.exp);
  if (!raw || !exp || Date.now() / 1000 > exp) { set.status = 410; return { code: 'MEDIA_LINK_EXPIRED' }; }
  const a = Buffer.from(sign(raw, exp)), b = Buffer.from(String(query.sig ?? ''));
  if (a.length !== b.length || !timingSafeEqual(a, b)) { set.status = 403; return { code: 'MEDIA_BAD_SIGNATURE' }; }

  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  const up = await fetchUpstream(raw, request.headers, method);

  const out = new Headers();
  for (const [k, v] of up.headers) {
    const lk = k.toLowerCase();
    if (HOP.has(lk) || lk === 'content-length' || lk === 'content-encoding') continue;
    out.set(k, v);
  }
  const cl = up.headers.get('content-length');
  if (cl) out.set('content-length', cl);              // HEAD 也要真实长度
  const ct = up.headers.get('content-type');
  out.set('content-type', !ct || ct.includes('octet-stream') ? 'video/mp4' : ct);
  out.set('accept-ranges', 'bytes');
  out.set('cache-control', 'public, max-age=3600');
  out.set('access-control-allow-origin', '*');
  out.set('access-control-expose-headers', 'Content-Length,Content-Range,Accept-Ranges');

  return new Response(method === 'HEAD' || !up.body ? null : up.body, { status: up.status, headers: out });
}
```

路由注册时有**三个实测坑**，不踩过一定会遇到：

```ts
app
  .get('/media', handleMedia)
  .head('/media', handleMedia)     // ★ 坑 1：Elysia 自动应答 HEAD 会把 content-length 改写成 0
  .options('/media', ({ set }) => { // ★ 坑 2：Range 虽是 safelisted，但带自定义头时仍会预检
    set.headers['access-control-allow-origin'] = '*';
    set.headers['access-control-allow-headers'] = 'Range';
    set.headers['access-control-max-age'] = '3600';
    return new Response(null, { status: 204 });
  });
```

1. **`HEAD` 必须显式注册**：Elysia 对 GET 路由自动应答 HEAD 时会重算 `content-length`，空 body 算出来是 0。实测改前 `content-length: 0`、改后 `3570885`。播放器靠这个值算 seek 位置，为 0 会直接不播。
2. **`redirect: 'follow'` 不能用**：抖音 play 链是 302，而 `Location` 由上游控制——直接 follow 等于把 SSRF 白名单绕过去了。必须手动跟，每跳重校验 + 重注入头。
3. **必须 `accept-encoding: identity`**：否则上游可能返回 gzip 流，`Content-Range` 的字节偏移和实际 body 对不上，分段下载拼接必坏（实测 sha256 对不上就是这么来的）。

其余要点：
- **不要 `await res.arrayBuffer()`**：`new Response(upstream.body)` 直接交回 `ReadableStream`，Bun 会在客户端慢消费时停止向上游读（背压），135 MB 原片也只占几十 KB 内存。
- **永不透传 `Cookie` / `Authorization`**：那是你自己的会话。也不能 `fetch(request)` 图省事。
- **逐跳头必须剥**：`connection`、`transfer-encoding`、`te`、`upgrade`、`keep-alive`、`host`。
- **内容类型兜底**：`application/octet-stream` → `video/mp4`（小红书原片实测就是 octet-stream）。

### 4.4 Cloudflare Workers 反代（适合小流量，不适合当 CDN）

**额度（官方文档，[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)，2026-10 抓取）**

| 项 | Free | Paid |
|---|---|---|
| 请求 | **100,000 / 天**（UTC 零点重置，超限 Error 1027） | 无限制 |
| CPU 时间 | **10 ms / 请求** | 5 min（默认 30 s） |
| 内存 | 128 MB | 128 MB |
| Subrequest | **50 / 请求** | 10,000 / 请求 |
| 同时连接 | 6 / 请求 | 6 / 请求 |
| 请求体 | 100 MB（Free 计划） | 同 |

三条对方案有决定性影响的官方原文：
- 「There is **no hard limit on duration** for HTTP-triggered Workers. As long as the client remains connected, the Worker can continue processing, making subrequests, and **streaming a response body**.」→ 流式转视频不会被 30 s / 5 min 打断。
- 「**Each subrequest in a redirect chain counts against this limit.**」→ 抖音 302 链吃 2 个 subrequest。
- 「Waiting on network requests (such as `fetch()` calls…) **does not count toward CPU time**.」→ 纯转发 CPU ≈ 0，Free 的 10 ms 够用。

**成本风险（[Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/) 原文）**：
> "Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the **Developer Platform, Images, and Stream**) that you must use in order to serve **video and other large files** via the CDN. Cloudflare reserves the right to disable or limit your access … if you use or are suspected of using the CDN without such Paid Services to serve video or a **disproportionate percentage** of pictures, audio files, or other large files."

解读：Workers 属于它点名的 Developer Platform，条款上没有直接禁止；但立法意图明确是「大流量视频请买 Stream」。**小规模工具站（每天几千次播放）没问题，做成公开视频 CDN 代理会被限速/停用**。另：免费 100k 请求/天 **不等于** 100k 次播放——`<video>` 会发多次 Range 请求，倍数**未核验**。

代码要点（`wrangler dev --local` 已跑通）：

```js
// src/index.js —— 与 4.3 同构，差异只在「没有 DNS API」
const h = new Headers();
for (const k of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
  const v = request.headers.get(k); if (v) h.set(k, v);
}
h.set('user-agent', UA);
if (rule.ref) h.set('referer', rule.ref);   // 空则完全不设置 = 小红书要的「无 Referer」
h.set('accept-encoding', 'identity');

const upstream = await fetch(target, {
  method, headers: h,
  redirect: 'follow',                          // Worker 里手动跟也可以，但每跳算 subrequest
  cf: { cacheEverything: false, cacheTtl: 0 }, // ★ 别让 CF 缓存签名 URL
});
return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
```

`wrangler.toml`：

```toml
name = "media-proxy"
main = "src/index.js"
compatibility_date = "2026-10-01"
# secret 用 `wrangler secret put PROXY_SECRET`，不要进仓库
# routes = [{ pattern = "media.example.com/*", zone_name = "example.com" }]
[observability]
enabled = true
```

**Workers 方案的真实短板**：没有 DNS 解析能力 → 只能挡「字面量 IP + 白名单」，**挡不住 DNS rebinding**（自建可以用 `dns.lookup` 后校验内网段）。所以 Worker 只适合「域名白名单写死且不接受任意 URL」的场景。

### 4.5 Nginx 反代（自建首选，带 slice 分片缓存）

```nginx
# 按上游域名决定 Referer（空值 = 删除该头）
map $uhost $ref_hdr {
    default                 "";
    ~*\.douyinvod\.com$     "https://www.douyin.com/";
    ~*\.douyin\.com$        "https://www.douyin.com/";
    ~*\.snssdk\.com$        "https://www.douyin.com/";
    ~*\.douyinpic\.com$     "";      # 不校验
    ~*\.xhscdn\.com$        "";      # 必须空
}

proxy_cache_path /var/cache/nginx/media levels=1:2 keys_zone=media:32m
                 max_size=20g inactive=6h use_temp_path=off;

server {
    listen 443 ssl;
    http2 on;
    server_name media.example.com;

    resolver 223.5.5.5 1.1.1.1 valid=300s ipv6=off;   # 变量 proxy_pass 必须有 resolver
    resolver_timeout 5s;

    # /p/<上游host>/<上游path>?<原查询串>
    location ~ ^/p/(?<uhost>[^/]+)(?<upath>/.*)$ {
        set $upstream "https://$uhost$upath$is_args$args";

        proxy_pass $upstream;
        proxy_http_version 1.1;
        proxy_ssl_server_name on;            # 变量 proxy_pass 默认不发 SNI，必须开
        proxy_set_header Host $uhost;
        proxy_set_header Connection "";      # ★ 空串才复用长连接（默认是 close）
        proxy_set_header Referer $ref_hdr;   # ★ 空值 = 删除
        proxy_set_header User-Agent "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
        proxy_set_header Accept-Encoding "identity";

        # 分片缓存（Range 友好）
        slice 2m;
        proxy_cache media;
        proxy_cache_key "$uhost$upath$slice_range";   # ★ 不要带 $args
        proxy_set_header Range $slice_range;
        proxy_cache_valid 200 206 1h;
        proxy_cache_lock on;
        proxy_force_ranges on;               # 上游没给 Accept-Ranges 也支持 Range
        proxy_request_buffering off;

        add_header Access-Control-Allow-Origin  "*" always;
        add_header Access-Control-Allow-Headers "Range" always;
        add_header Access-Control-Expose-Headers "Content-Length,Content-Range,Accept-Ranges" always;
        add_header X-Proxy-Cache $upstream_cache_status always;
    }
}
```

指令依据（[ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[ngx_http_slice_module](https://nginx.org/en/docs/http/ngx_http_slice_module.html)）：
- `proxy_set_header` 默认值就是 `Host $proxy_host; Connection close;` → 不显式设空串，**每个请求一条新连接**。
- 「If caching is enabled, the header fields … **`Range`** … from the original request are **not passed** to the proxied server.」→ 开了缓存后客户端 Range 不会自动上去，必须 `proxy_set_header Range $slice_range`。
- `proxy_force_ranges on`：「Enables byte-range support … **regardless of the `Accept-Ranges` field**」。
- `slice` 模块「not built by default, it should be enabled with `--with-http_slice_module`」——官方 nginx 镜像默认带，自己编译要加参数。

**两个实测坑**：
1. **`proxy_buffering off` 会让 `proxy_cache` 完全失效**（缓存目录 0 B、三次全 MISS）。「流式不缓冲」和「分片缓存」不能同时要；要缓存就保持 buffer 开 + `slice 2m`（单片内存 2 MB）。
2. **cache key 不能带 `$is_args$args`**：抖音每次解析出 URL 的 token/`dy_q`/`l`/`ft` 全变 → 命中率恒为 0。要按稳定对象 id 做 key：

```nginx
map $upath $media_key {
    default                   $upath;
    ~/tos/[^/]+/(?<oid>[^/]+)/  "tos/$oid";    # 抖音：忽略签名路径段
}
proxy_cache_key "$uhost$media_key$slice_range";
```

3. 另一个易踩的：`proxy_cache_max_range_offset` **别设 0**——设了等于关闭所有 Range 缓存（「If the range is beyond the offset, the range request will be passed to the proxied server and the response will **not be cached**」）。

### 4.6 SSRF 四层防护（代理 = 公网 SSRF 跳板，这一步不能省）

1. **host 白名单按 `.` 边界**：`host === d || host.endsWith('.' + d)`。**绝不用 `includes('douyin')`**（`evil-douyin.com` 会过）。
2. **只允许 `https:` + 只允许 443**，且用 `new URL(x).hostname` 判断而不是字符串匹配（`https://x@127.0.0.1/` 的 hostname 会被正确解析成 `127.0.0.1`）。
3. **DNS 解析后校验内网段**（10/8、127/8、169.254/16、172.16/12、192.168/16、100.64/10、::1、fc00::/7、fe80::/10），防 DNS rebinding。
4. **302 每一跳重校验**（`Location` 上游可控）。

⚠️ **实测踩到的坑**：本机 DNS 被 Clash fake-ip 劫持（`*.douyinvod.com` → `198.18.0.67`），导致第 3 层把所有正常域名都拦了。部署在走代理/内网 DNS 的环境里会一样中招 → 用 DoH 独立解析，或把 IP 校验做成可开关（`SSRF_DNS_CHECK=0` 仅限可信网络），白名单兜底。

### 4.7 盗链滥用防护

- **绝不暴露 `?url=` 裸参数**。用 `HMAC(secret, url + exp)` + 短 TTL（600 s），前端拿到的是 `/media?u=…&exp=…&sig=…`。
- 可选加固：把 IP 或 UA hash 进签名（移动端换网会误伤，慎用）；`sig` 一次性消费（Redis `SET NX EX`）；按 IP QPS 限流。
- token 会进 access log、会作为 Referer 泄漏 → **TTL 必须短**，日志对 `sig` 脱敏。

---

## 5. 缓存策略

### 5.1 分层结构

```
请求 → L1 LRU（进程内，热点，亚毫秒） → L2 Redis（跨实例） → singleflight → 上游解析
              ↑ 命中回填              ↑ 命中回填 L1
```

- **L1 用 `lru-cache@11.5.3`**（实测 `ttl` 正常：50 ms 内命中、80 ms 后 `undefined`）。注意 license 是 **BlueOak-1.0.0**（非 MIT），商用需确认合规。
- **Bun 没有内置 LRU**（`bun-types` 解包后无任何缓存容器 API），别找。
- **L2 用 Bun 原生 `redis` 客户端**（[bun.com/docs/runtime/redis](https://bun.com/docs/runtime/redis)）有硬约束：**只支持 Redis ≥ 7.2**、**不支持 Sentinel / Cluster**、事务要 `send('MULTI')` 裸命令、`idleTimeout` 后不自动重连。单机 7.2+ 且只用 GET/SET/EVAL → 用它；要 Cluster/多路复用 → `ioredis@6`。**别混用两套客户端**。
- **容量估算**：`max ≈ QPS × 平均 TTL × 1.5`，起步 `max: 5000`。
- **TTL 加 ±10% jitter**，防同批 key 同时过期。

### 5.2 直链过期：到底多久，以及为什么不能拍数字

**没有任何官方文档给出抖音/小红书直链 TTL**，网上「X 小时」全是社区实测。正确做法是**运行时从 URL 里读出过期时刻**：

| 平台 | 证据 | 可核验性 |
|---|---|---|
| 抖音（图集 `p26-sign.douyinpic.com`） | query 带 `x-expires=<unix秒>`，值都是整点 | 参数名/格式可核验；**精确 TTL 未核验** |
| 抖音（`douyinvod.com` 播放链） | **本次实测样本 query 里没有 `x-expires`**，时效编码在路径 8 位 hex 段，样本 ≈ 签发 + 24h | 【实测】单样本，**未等到真过期验证** |
| 抖音（社区实现） | `hiyufan/alcedo` 注释称「路径 hex 段，实测总有效期约 80 分钟」 | 二手，社区实测值，**不能当契约** |
| 小红书 `sns-video-bd/<key>` | 无任何 query 签名，host + key 可重建 | 【实测】无签名是事实；**是否永久有效未核验** |
| 小红书图片 `sns-webpic-qc/<202511251711>/...` | 路径首段是**生成时刻**（分钟级），不是过期时刻 | 可从样本反推，**语义未核验** |

**推导出的两条设计铁律**：
- 抖音：URL **不可重建**（带签名），必须存整条 URL 并严格遵守读出的 `expiresAt`。
- 小红书：URL **可重建**（host + key），缓存里存 `key`，命中后现拼 → 「URL 过期」问题在该平台直接消失。

### 5.3 TTL 计算与刷新决策（原型代码，未落库）

> 勘误：`services/cache/expiry.ts` 为原型代码，未落库，「16 个测试」系原型记录。实际实现：TTL 直接取 `result.expiresAt`（`src/services/cache.ts` 的 `ttlFor`），无 SWR/jitter/Redis。

```ts
// services/cache/expiry.ts（原型代码，未落库）
export function urlExpiry(url: string, now = Math.floor(Date.now() / 1000)): number | undefined {
  const plausible = (t: number) => t > 1_577_836_800 && t < now + 30 * 86_400;  // 防把哈希段当时间戳
  let u: URL; try { u = new URL(url); } catch { return undefined; }

  for (const [k, v] of u.searchParams) {                       // 1) query 里的过期时刻
    if (!['x-expires','expires','expire','deadline','valid_to','e'].includes(k.toLowerCase())) continue;
    const t = Number(v); if (Number.isFinite(t) && plausible(t)) return t;
  }
  for (const seg of u.pathname.split('/')) {                    // 2) 路径里的 8 位 hex 时间戳（抖音）
    if (seg.length !== 8 || !/^[0-9a-fA-F]{8}$/.test(seg)) continue;
    const t = parseInt(seg, 16); if (plausible(t)) return t;
  }
  return undefined;
}

export function computeTtlMs(r: ParseResult, p: CachePolicy, now = Date.now()): number {
  const exp = earliestExpiry(r);                 // 取所有资源里最早的
  if (!exp) return p.maxTtlMs;                   // 读不出寿命 → 只受配置上限约束
  const remain = exp * 1000 - now - p.safetyMs;  // safetyMs 默认 120s，覆盖下游下载耗时
  return remain <= 0 ? 0 : Math.min(remain, p.maxTtlMs);   // 返回 0 = 不进缓存
}
```

**刷新决策矩阵**（直接落成 if/else）：

| 逻辑 TTL | 直链剩余寿命 | 动作 | 返回 |
|---|---|---|---|
| 未过期 | > safety | 直接返回 | `hit` |
| 未过期 | ≤ safety（链快死了） | **同步**重解析 | `miss`（新结果） |
| 已过期 | > safety 且在 `staleGraceMs`(30s) 内 | 返旧值 + 后台刷新 | `stale` |
| 已过期 | > safety 但超宽限期 | 同步重解析 | `miss` |
| 已过期 | ≤ safety | 同步重解析 | `miss` |

```ts
// 关键实现：singleflight + 负缓存 + SWR
async load(key: string, loader: () => Promise<ParseResult>): Promise<Entry> {
  return this.sf.run(key, async () => {           // 同 key 并发只打一次上游（实测 3 并发 → 1 次）
    try {
      const r = await loader();
      const ttl = computeTtlMs(r, this.policy);
      const entry = { value: r, expireAt: Date.now() + jitter(ttl), urlExpiresAt: earliestExpiry(r) };
      this.l1.set(key, entry);
      if (ttl > 0) await this.l2?.set(key, entry, ttl);
      return entry;
    } catch (e: any) {
      // ★ 只对「稳定失败」做负缓存，超时/风控绝不缓存
      if (['CONTENT_NOT_FOUND','UNSUPPORTED_PLATFORM','UNSUPPORTED_CONTENT'].includes(e?.code)) {
        const err = { error: { code: e.code }, expireAt: Date.now() + this.policy.negativeTtlMs };
        this.l1.set(key, err); await this.l2?.set(key, err, this.policy.negativeTtlMs);
      }
      throw e;
    }
  });
}
```

### 5.4 缓存 key 设计（比 TTL 更容易出错）

```ts
function cacheKey(platform: Platform, id: string, variant = 'default') {
  return `v1:parse:${platform}:${id}:${variant}`;   // 带版本前缀，便于整体失效
}
```

- **绝不用原始 URL 做 key**：分享链带 `xsec_token`、`share_source`、时间戳，同一内容几十个 URL。现状 `CacheManager.generateKey` 只删 4 个参数，不够（还漏 `share_id`、`appuid`、`apptime`、`share_channel`）。
- **不要用 `redlock` 做 singleflight**：其最新版长期停在 `5.0.0-beta.2`（2022），且对「同 key 合并」是过度设计。进程内 singleflight + L2 已经够；跨进程强一致收益远小于复杂度。
- **负缓存白名单**要显式（见上），否则一次风控会把「暂时失败」缓存 60 秒，等于自己制造故障。

---

## 6. 并发、限流、降级、可观测性

### 6.1 两条通道的资源模型（决定池子怎么开）

| | 纯 HTTP | 浏览器（Puppeteer） |
|---|---|---|
| 单次成本 | 1–3 次请求，10–80 ms，几十 KB | 复用实例下每页 100–400 ms；新实例 300–800 ms |
| 并发上限 | 上游 QPS/风控（几十~几百） | **内存**（个位数） |
| 失败模式 | 401/403/风控页 | 进程崩溃、导航超时、内存泄漏 |
| 取消 | `AbortController` 断 socket | 需 `page.close()` + `ctx.close()`，只 abort 不够 |

**结论：浏览器只能当兜底通道，不进主链路。** 01 文档已实测抖音 detail 接口可纯 HTTP 拿到，小红书可走 `__INITIAL_STATE__`（但需 TLS 指纹，见 02 文档）——所以「先浏览器」的现状是纯浪费。

### 6.2 浏览器池大小（实测内存）

【实测】`puppeteer@24.3.0` + Chrome 155，headless，每实例 1 页，`ps -axo rss` 汇总：

| 场景 | 折算单实例 RSS |
|---|---|
| 1 实例 / 1 页 | 857 MB（macOS 把共享内存重复计入，**是上界**） |
| 3 实例 / 3 页 | **758.8 MB** |
| 追加第 2 个标签页 | 每页 +30~110 MB |

> 读法：**按「单浏览器 400–600 MB 稳态」做容量规划**，并用容器内存上限兜底。
> ⚠️ 现状 `ecosystem.config.json` 的 `max_memory_restart: 800M` **只监控 bun 进程自身**，Chrome 子进程不计入 → 池子开大时先被容器 OOMKill，而不是被 pm2 重启。

```
N = min(上游允许并发, floor((容器上限 - Bun基线 - 余量) / 单实例稳态), CPU核数 × 2)
例：2 GB 容器、Bun 基线 200 MB、余量 300 MB、单实例 500 MB → floor(1500/500) = 3
```

**2C4G 上浏览器池 3 个，别超过 4。**

### 6.3 信号量 + abort 贯穿（20 行自研，比引库可控）

```ts
// infra/browser/pool.ts
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (this.active < this.max) { this.active++; return () => this.release(); }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { signal?.removeEventListener('abort', onAbort); reject(new DOMException('aborted','AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(() => { signal?.removeEventListener('abort', onAbort); resolve(); });
    });
    this.active++;
    return () => this.release();
  }
  private release() { this.active--; this.queue.shift()?.(); }
  get stats() { return { active: this.active, waiting: this.queue.length, max: this.max }; }
}

export async function withPage<T>(fn: (p: Page) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
  const release = await sem.acquire(parentSignal);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('browser_timeout')), 20_000);  // 硬超时
  parentSignal?.addEventListener('abort', () => ac.abort(parentSignal.reason), { once: true });
  const ctx = await (await getBrowser()).createBrowserContext();   // ★ context 隔离，防 cookie 串号
  try {
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(15_000);
    ac.signal.addEventListener('abort', () => { page.close().catch(() => {}); }, { once: true });
    return await fn(page);
  } finally {
    clearTimeout(timer);
    await ctx.close().catch(() => {});   // 关 context = 关页 + 清 storage
    release();
  }
}
```

- **取消必须贯穿到底**：Elysia `request.signal` → 解析器 → `fetch(url,{signal})` / puppeteer 导航 → 上游 socket。任一环丢 signal，超时请求会继续占着浏览器槽位。
- 可换 `p-queue@10.0.0`（4,298★，纯 ESM，`engines: node >=22`），但它 `timeout` 只 reject、**不取消正在跑的任务**，对浏览器槽位回收不够。

### 6.4 限流

**Elysia 生态实况（npm registry 实查，2026-10-24）**

| 包 | 最新 | peer `elysia` | star | 备注 |
|---|---|---|---|---|
| `elysia-rate-limit` | **5.1.1** | **`>= 2.0.0`** | 239 (MIT) | 只能配 Elysia 2.x |
| 同包 | **4.6.3**（`previous` tag） | **`>= 1.0.0`** | 同上 | ★ **当前的 Elysia 1.x 必须用这个** |
| `rate-limiter-flexible` | 11.2.3 | 与框架无关 | 3,596 | 存储层库，带 `insuranceLimiter` |
| `bottleneck` | 2.19.5（**2019**） | — | 2,007 | 五年未发版，别用 |

README 原文：「If you're using Elysia v2.0.0 or higher, use `elysia-rate-limit` v5.0.0 or higher. If you're using Elysia v1.0.0, you should use version 4.6.3 or lower.」→ **在 Elysia 1.x 上装 5.x 会因 peer 不满足 + `onBeforeHandle` 签名差异挂掉**。

```ts
// services/limiter.ts（提案，未采纳）
import { Elysia } from 'elysia';
import { rateLimit } from 'elysia-rate-limit';

export const limiter = new Elysia({ name: 'rate-limit' }).use(rateLimit({
  duration: 60_000,
  max: (_k, req) => (req.headers.get('x-api-key') ? 120 : 20),  // 匿名 20/min，带 key 120/min（提案，未采纳）
  countFailedRequest: true,        // 失败也计数，防刷错误路径
  headers: true,                   // 输出 RateLimit-* + Retry-After
  scoping: 'scoped',               // 只作用于本实例，别污染全局
  generator: (req, server) => {
    const ip = server?.requestIP(req)?.address ?? 'unknown';
    // ★ 只在直连对端是可信代理时才信任转发头，否则一行 header 就能绕过限流
    return isTrustedProxy(ip)
      ? (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? ip)
      : ip;
  },
  skip: req => /\/(health|ready|metrics)$/.test(new URL(req.url).pathname),
}));
```

> 勘误：上述 elysia-rate-limit 代码为提案，未采纳。实际实现：自研令牌桶 30 次/分/IP（`src/services/limiter.ts`），`clientIp` 取 `X-Real-IP` / `X-Forwarded-For` 第一段。【勘误 2026-10-28】已补可信代理校验：转发头只在直连对端是可信代理（同机回环、内网地址）时采信，公网直连伪造 `X-Real-IP` 按连接地址计数（坑 2 的修法）。

**多实例必失效**：默认 context 是进程内 `AllocQuickLRU(5000)`。pm2 `instances: 2+`、k8s 多副本、滚动发布新旧并存 → 实际额度 = N × max。要么下沉 Redis（实现 `elysia-rate-limit` 的 `Context` 五方法 `init/increment/decrement/reset/kill`，滑动窗口用 Lua：`ZREMRANGEBYSCORE` + `ZADD` + `ZCARD` + `PEXPIRE` 原子完成），要么用 `rate-limiter-flexible` 的 `RateLimiterRedis`（自带 `insuranceLimiter`，Redis 挂时回落内存）。

**算法选型**：匿名按 IP 用固定窗口（便宜，但窗口交界可打 2× 额度）；按 API Key 用滑动窗口或令牌桶（公平、可计费）。

### 6.5 重试与降级链

**错误分类表**（决定「重试 / 降级 / 负缓存」三件事）：

| 错误码 | 来源 | 重试 | 降级到浏览器 | 负缓存 | 说明 |
|---|---|---|---|---|---|
| `UPSTREAM_TIMEOUT` | 上游/浏览器 | ✅ 1–2 次 | ✅ | ❌ | 暂时状态 |
| `UPSTREAM_UNREACHABLE` | 网络 | ✅ 指数退避 | ❌ | ❌ | 多为抖动 |
| `UPSTREAM_5XX` | 平台 | ✅ | ✅ | ❌ | |
| `UPSTREAM_RISK_CONTROL` | 风控/验证码 | ⚠️ 换 IP/降速后，**同 key 不重试** | ✅（带 cookie） | ❌ | 重试会加重风控 |
| `AUTH_REQUIRED` | 签名/cookie 失效 | ❌ | ✅ | ❌ | 先刷新凭据 |
| `CONTENT_NOT_FOUND` | 已删/私密 | ❌ | ❌ | ✅ 60s | 稳定事实 |
| `UNSUPPORTED_CONTENT` | 链接类型不支持 | ❌ | ❌ | ✅ 60s | 稳定事实 |
| `PARSE_FAILED` | 选择器/字段变了 | ❌（同版本） | ✅ | ⚠️ 30s + **告警** | 多半是平台改版 |

**降级链**：

```
① 纯 HTTP（2 s 超时，可重试 1 次）
     │ 失败且 code ∈ {RISK_CONTROL, AUTH_REQUIRED, PARSE_FAILED, UPSTREAM_5XX}
     ▼
② 浏览器通道（bulkhead 3 并发，20 s 硬超时，signal 贯穿）
     │ 失败
     ▼
③ 结构化失败 { success:false, code, retryable, retryAfter? }
   + 若 L2 有 stale 结果且直链仍活 → 作为最后兜底（返回 stale:true）
```

退避必须加 jitter（full jitter），否则重试风暴整齐地打在同一个恢复窗口：

```ts
const exp = Math.min(capMs, baseMs * 2 ** (i - 1));
await sleep(exp / 2 + Math.random() * (exp / 2), signal);   // base 200ms, cap 3s
```

**熔断器**：`cockatiel@4.0.0`（1,830★，TS 原生，内置 decorrelated jitter、`SamplingBreaker`、`bulkhead`）优于 `opossum@10`（其 `engines` 只到 `^22 || ^24 || ^26`，且无内置 jitter）。

```ts
export const breakers = {
  douyin: circuitBreaker(handleAll, { halfOpenAfter: new ExponentialBackoff({ initialDelay: 5_000, maxDelay: 60_000 }), breaker: new ConsecutiveBreaker(5) }),
  xhs:    circuitBreaker(handleAll, { halfOpenAfter: 10_000, breaker: new ConsecutiveBreaker(8) }),
};
export const browserBulkhead = bulkhead(3, 20);   // 3 并发 + 最多排 20
```

> ⚠️ 熔断器**必须全局复用同一实例**（每次 `circuitBreaker()` 新建 = 没熔断，官方 README 强调）。

**幂等**：`GET /parse` 天然幂等，但解析有副作用（打上游、烧 IP），所以同 `id` 并发必须被 singleflight 合并（§5.3）；`POST /parse` 建议支持 `Idempotency-Key`（`SET NX EX 600` 抢占）。

### 6.6 可观测性

**依赖可用性**：`prom-client` 与 `pino` 在 Bun 下均已实测可用；`@elysiajs/opentelemetry` **版本与 Elysia 1.2.x 对不上，阶段一别装**（自写 40 行更稳）。`elysia-prometheus@1.1.1` 只有 17★，未实测。

**指标清单（命名提案，未采用；按优先级，前 6 个是必须的）**

> 勘误：下表命名为提案，未采用。实际指标名：`parse_total`、`parse_duration_ms`、`cache_hit_total`、`upstream_error_total`、`channel_downgrade_total`、`parse_retry_total`、`channel_breaker_open`，另有 `uifid_mint_total`、`uifid_retired_total`（由 `src/platforms/douyin/uifid-pool.ts` 经 `src/infra/metrics.ts` 记录）。

| 指标 | 类型 | labels | 回答什么问题 |
|---|---|---|---|
| `parse_requests_total` | Counter | platform, result, channel, cached | **各平台成功率** |
| `parse_duration_seconds` | Histogram | platform, channel | P95/P99（buckets: .05,.1,.25,.5,1,2,5,10,30） |
| `cache_requests_total` | Counter | layer, status | **命中率 = hit/(hit+miss)** |
| `upstream_responses_total` | Counter | platform, status_class | 上游 4xx/5xx 突增 |
| `browser_pool_inuse` / `_waiting` | Gauge | — | **池子够不够**（waiting>0 说明太小） |
| `url_expiry_seconds` | Histogram | platform | **直链寿命分布 → 用来校准 TTL，别拍脑袋** |
| `ratelimit_rejected_total` | Counter | scope | 限流是否误伤 |
| `circuit_state` | Gauge | platform | 0/1/2 |
| `upstream_blocked_total` | Counter | platform, reason | 风控强度趋势 |
| `singleflight_dedup_total` | Counter | platform | 省了多少上游调用 |

**`/health` 与 `/ready` 必须分开**（这是最常见的自伤）：

| 端点 | 含义 | 查什么 | 失败后果 |
|---|---|---|---|
| `GET /health` | 进程活着吗 | **只查事件循环能否响应，零外部 IO** | k8s 重启容器 |
| `GET /ready` | 能接流量吗 | Redis PING(200ms)、浏览器池有空槽、熔断未全开 | k8s 摘流量，不重启 |

> 反模式：`/health` 里查 Redis → Redis 抖 3 秒 → 所有副本连环重启 → 雪崩。

**告警（PromQL 思路，指标命名提案，未采用）**：

```promql
sum(rate(parse_requests_total{result="ok"}[5m])) by (platform)
  / sum(rate(parse_requests_total[5m])) by (platform) < 0.9          # 单平台成功率 < 90%
histogram_quantile(0.95, sum(rate(parse_duration_seconds_bucket[5m])) by (le, platform)) > 5
sum(rate(cache_requests_total{status="hit"}[5m])) / sum(rate(cache_requests_total[5m])) < 0.6
max_over_time(browser_pool_waiting[5m]) > 5
```

`/metrics` 必须放进限流 `skip` 列表（否则 Prometheus 抓取把额度耗光）且只在内网/带 token 暴露。

---

## 7. 错误码设计（兼容现有 12xx 体系）

现有 `docs/ERROR_CODE.md` 只列了 1201–1203（**1204 只出现在代码里**，`platform-transfer.ts` 用它表示「抖音解析失败」），且**错误返回的 HTTP 状态与 JSON 契约都是混着的**（`errorHook` 一律 `set.status = 400` + `text/plain`）。建议：

> 勘误：本节 12xx 数字错误码体系（含 `docs/ERROR_CODE.md` 引用，该文件现已不在仓库）为提案，未采用。实际实现为字符串错误码共 16 个（`INVALID_URL`、`RISK_CONTROL`、`CONFIG_MISSING` 等），见 `src/core/errors.ts`；信封无数字 `errorCode` 字段。

### 7.1 保留 12xx 前缀，补齐语义维度

| HTTP | code | 名称 | 可重试 | 归因 | 说明 |
|---|---|---|---|---|---|
| 400 | **1201** | `INVALID_INPUT` | ❌ | 调用方 | 文案里没有 URL / URL 不可解析 |
| 400 | **1202** | `UNSUPPORTED_PLATFORM` | ❌ | 调用方 | host 未命中任何 adapter（`details.supported` 回白名单） |
| 400 | **1203** | `UNSUPPORTED_CONTENT` | ❌ | 调用方 | 平台认了但链接类型不支持（如直播间、主页） |
| 404 | **1204** | `CONTENT_NOT_FOUND` | ❌ | 平台 | 作品已删/私密（代码里原 1204 是「抖音解析失败」，语义要改，见下） |
| 401 | **1211** | `AUTH_REQUIRED` | ❌（先刷凭据） | 我方/平台 | 需要 cookie 或刷新签名 |
| 403 | **1212** | `MEDIA_BAD_SIGNATURE` | ❌ | 调用方 | 中转 URL 的 HMAC 不匹配 |
| 410 | **1213** | `MEDIA_LINK_EXPIRED` | ✅（重新解析） | 时间 | 中转签名过期 |
| 429 | **1221** | `RATE_LIMITED` | ✅（带 Retry-After） | 调用方 | 我方限流 |
| 502 | **1231** | `UPSTREAM_RISK_CONTROL` | ⚠️（换 IP/降速后） | 平台 | 风控/验证码页 |
| 502 | **1232** | `UPSTREAM_CHANGED` | ✅（可能自愈） | 平台 | 字段/结构变了 → **必须告警** |
| 502 | **1233** | `UPSTREAM_UNREACHABLE` | ✅ | 网络 | 连接/超时 |
| 503 | **1241** | `CIRCUIT_OPEN` | ✅（稍后） | 我方 | 熔断中 |
| 503 | **1242** | `QUEUE_FULL` | ✅（稍后） | 我方容量 | 浏览器池排队超限 |
| 500 | **1250** | `INTERNAL` | ❌ | 我方 bug | 未捕获异常，带 `requestId` |

**关键改动：1204 的语义必须挪。** 现状 1204 = 「抖音解析失败，请确保链接有效」，把「视频被删」和「我们代码坏了」混成一个码。改成 `CONTENT_NOT_FOUND`（404），另设 `UPSTREAM_CHANGED`（502）承接「平台改版」。这是可观测性的前提——否则你永远不知道成功率下降是内容问题还是代码问题。

### 7.2 统一信封（保留现有字段，增量扩展）

```ts
// core/envelope.ts
export interface Envelope<T> {
  success: boolean;
  data: T | null;
  message: string;
  errorCode?: number;          // 兼容现有前端
  code?: string;               // 新增：稳定字符串码，前端按它做分支
  retryable?: boolean;         // 新增：调用方能否直接重试
  retryAfter?: number;         // 新增：秒
  details?: Record<string, unknown>;  // 新增：如 { supported: ['douyin','xhs'] }
  requestId?: string;          // 新增：贯穿日志
}
```

```ts
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: Record<string, unknown>,
    readonly cause?: unknown,
  ) { super(code); }
  get httpStatus() { return HTTP_STATUS[this.code]; }
  get retryable()  { return !NON_RETRYABLE.has(this.code); }
}

export const toEnvelope = (e: unknown, set: any, requestId: string): Envelope<null> => {
  const err = e instanceof AppError ? e : new AppError('INTERNAL', {}, e);
  set.status = err.httpStatus;
  set.headers['content-type'] = 'application/json; charset=utf-8';
  return { success: false, data: null, message: MESSAGES[err.code], errorCode: CODE_NUM[err.code],
           code: err.code, retryable: err.retryable, details: err.details, requestId };
};
```

**错误钩子必须改**：现在 `errorHook` 对所有错误返 `400 + text/plain`，会把 Elysia 的 `VALIDATION`（应 422/400 JSON）、`NOT_FOUND`（应 404）、`PARSE`（应 400）和内部异常（应 500）全糊在一起，且破坏 JSON 契约。

---

## 8. 部署

### 8.1 `bun build --compile` 单二进制

**支持目标**（[bun.com/docs/bundler/executables](https://bun.com/docs/bundler/executables)）：`bun-linux-x64`、`bun-linux-arm64`、`bun-linux-x64-musl`、`bun-linux-arm64-musl`、`bun-darwin-{x64,arm64}`、`bun-windows-{x64,arm64}`。**没有 `amd64` 这个名字**（实测能识别，但统一写 `x64`）。

【实测】体积（同一份 `src/`）：

| 构建 | 体积 |
|---|---|
| 空项目 `hello.ts --compile --minify`（linux-x64） | **99 MB** ← Bun 运行时地板 |
| 本项目 `--compile --minify` linux-x64 | **105 MB**（业务代码只占 ~6 MB） |
| 加 `--bytecode` | 156 MB（只为优化冷启动，常驻服务不划算） |
| linux-x64-musl / linux-arm64-musl | 97 MB / 95 MB |
| darwin-arm64 | 70 MB |

【实测】首字节：编译产物 207 ms，`bun run src/index.ts` 213 ms，容器内（含 docker 开销）1295 ms。**「编译后启动更快」在本项目不成立**——瓶颈是模块初始化；二进制的真实收益是**部署面**（不需要 node_modules / 不需要装 Bun / 镜像层更少）。

**与 Puppeteer 的兼容性（实测）**：
- **能跑**：编译进二进制的 puppeteer 在外部 Chromium 下正常（darwin 产物 + 本机 Chrome 155、arm64-musl 产物 + alpine chromium 均通过）。
- **必须外置 `PUPPETEER_EXECUTABLE_PATH`**：不设时报 `Could not find Chrome ... at resolveExecutablePath (/$bunfs/root/...)`。注意 `/$bunfs/` —— 编译后 `__dirname` / `import.meta.url` 指向 Bun 虚拟文件系统，**任何靠相对路径找浏览器/证书/模板的代码都会失效**。
- **安装阶段必须 `PUPPETEER_SKIP_DOWNLOAD=true`**，否则每次 `bun install` 拉一份 Chrome for Testing。
- **libc 必须对齐**：musl 产物丢进 Debian → `no such file or directory`（缺 `ld-musl`）；glibc 产物丢进 Alpine → `not found`（现状 Dockerfile 的 `gcompat` 就是在兜这个，用 musl target 可以彻底去掉）。
- **Chromium 打不进二进制**：`--compile` 只打包 JS + 运行时；Chromium 是几万文件的程序，需要真实路径 `execve`。这是架构约束，不是配置偏好。

### 8.2 Docker 方案对比

【实测】镜像体积：

| 方案 | 镜像 | 浏览器 |
|---|---|---|
| `alpine:3.22` + `apk add chromium` + musl 二进制 | **935 MB** | Chromium 142 |
| 同上 + `nss freetype harfbuzz ttf-freefont` | 947 MB | 只多 12 MB，且基本冗余 |
| `debian:bookworm-slim` + `apt chromium` | **1.01 GB** | Chromium 156 |
| `debian:bookworm-slim` + `google-chrome-stable` | 926 MB | Chrome 156 |

三者同一量级（差 <10%）。**选型不该看体积，看**：glibc 兼容性（Chrome 官方只保证 glibc）、中文封面字体渲染、Alpine 的 Chromium 版本落后（142 vs 156）。

**推荐 Dockerfile**（可直接用）：

```dockerfile
# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true       # 构建期不需要浏览器
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
ARG BUN_TARGET=bun-linux-x64-musl      # ★ alpine 用 musl 目标，彻底去掉 gcompat
RUN bun build ./src/index.ts --compile --minify --target=${BUN_TARGET} --outfile ./out/server

FROM alpine:3.22
# chromium 自带 nss/freetype/harfbuzz/fontconfig，只需补证书和 init
RUN apk add --no-cache chromium ca-certificates tini \
 && addgroup -S app && adduser -S -G app -u 10001 app
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production SERVER_PORT=7777 HOME=/home/app
WORKDIR /app
COPY --from=builder --chown=app:app /app/out/server /app/server
USER app
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${SERVER_PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["/app/server"]
```

配套 compose：

```yaml
services:
  app:
    build: { context: ., args: { BUN_TARGET: bun-linux-arm64-musl } }
    init: true
    ports: ["7777:7777"]
    shm_size: "1gb"                  # 默认 /dev/shm 只有 64MB
    read_only: true
    tmpfs: ["/tmp:size=512m"]
    security_opt: ["no-new-privileges:true"]
    cap_drop: ["ALL"]
    deploy: { resources: { limits: { memory: 1g } } }
```

**`--no-sandbox` 的安全代价（实测两种情况都逃不掉）**：

| 场景 | 结果 |
|---|---|
| root，不加 `--no-sandbox` | `Running as root without --no-sandbox is not supported` |
| 非 root（uid 10001），不加 | `Failed to move to new namespace ... Operation not permitted` |

即默认 Docker 配置下**只能用 `--no-sandbox`**；想保留沙箱得 `--cap-add=SYS_ADMIN`（puppeteer 官方示例如此），但那等于把内核能力交出去，通常更糟。

代价：渲染进程无沙箱，被抓页面的第三方脚本（广告位）等同于在本容器执行任意代码。缓解（按性价比）：① 非 root + `cap_drop: ALL` + `no-new-privileges`；② 只读根 + tmpfs；③ **出站网络白名单（只放行目标域名与 CDN，阻断内网段）——这条比前两条都关键**；④ 每请求独立 `createBrowserContext()`；⑤ `memory` / `pids_limit` 上限。

**distroless / docker-slim**：distroless 无 shell 无包管理器，装不了 Chromium，还得手工拷全部 `.so` + 字体，且没有 `wget` 做 HEALTHCHECK → **不建议**（本项目正是 distroless 最难覆盖的类型）。docker-slim 能省的只是缓存与未用 `.so`，而 700 MB 里绝大部分是 Chromium 本体，**实际收益未核验**，别当 50% 优化写进方案。

### 8.3 pm2 vs 容器编排

- **pm2 cluster 在 Bun 下不能当生产方案**：PM2 cluster 依赖 `node:cluster`，而 Bun 的兼容性标注是 🟡——「`node:http/https` servers in workers each bind their own socket instead, so load-balancing HTTP requests across processes is only supported on Linux (through SO_REUSEPORT) ... implemented but not battle-tested」（[bun.com/docs/runtime/nodejs-apis](https://bun.com/docs/runtime/nodejs-apis)）。**`instances: 1` + `exec_mode: "fork"`（现状）是对的**；要并发就多开容器副本，用 Nginx/Service 分流。
- **pm2-runtime 在容器里的真问题**不是「不理 SIGTERM」（官方明确说会转发），而是：① PM2 作 PID 1 不 reap 子进程，puppeteer 派生 chromium/zygote 容易攒僵尸；② `autorestart` / `max_memory_restart` 与 compose `restart:` / k8s probe 打架；③ 镜像里白装 Node+pm2（~100 MB），而你已有单二进制；④ 信号链多一跳。
  → **容器里删掉 pm2，直接 `ENTRYPOINT` 二进制**；pm2 只留给裸机。

k8s 三探针（关键：**liveness 千万别打会拉 Chromium 的接口**）：

```yaml
startupProbe:   { httpGet: { path: /health, port: 7777 }, periodSeconds: 2, failureThreshold: 30 }   # 最多等 60s
livenessProbe:  { httpGet: { path: /health, port: 7777 }, periodSeconds: 15, timeoutSeconds: 3, failureThreshold: 3 }
readinessProbe: { httpGet: { path: /ready,  port: 7777 }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 2 }
```

### 8.4 Serverless 可行性

| 平台 | 能跑 Puppeteer？ | 关键限制（官方数字） | 结论 |
|---|---|---|---|
| **Cloudflare Workers** | ❌ | Worker 体积 64 MiB、内存 128 MB、CPU Free **10 ms**、启动 1 s | isolate 无子进程/文件系统，`execve` Chromium 无门 |
| **CF Browser Rendering** | ✅ 托管浏览器 | Free **10 分钟/天**、并发 1、60 s 超时；Paid 200 并发、60 s 超时（[limits](https://developers.cloudflare.com/browser-rendering/limits/)） | 可行，但出口是 CF 段，抖音/小红书风控命中率**未核验** |
| **Vercel Functions** | ⚠️ 要换 Chromium | 未压缩 250 MB、Hobby 300 s / Pro 800 s、请求体 4.5 MB（[limits](https://vercel.com/docs/functions/limitations)） | 官方模板用 `@sparticuz/chromium-min`，冷启动 1–3 s，每请求可能重解压 |
| **自托管容器** | ✅ | 无平台时限 | **推荐**：要登录态、翻页、长超时，只有这条稳 |

**结论**：
1. **纯 HTTP API 版**（短链展开 + 签名 + 元数据）**适合 Workers**，但 Free 的 10 ms CPU 对 HMAC 偏紧，实质要 Paid。
2. **带浏览器的解析**：Workers 只能走 Browser Rendering，Vercel 只能走 `@sparticuz`，两者都比自托管贵且不可控。
3. 要边缘化就**双轨**：边缘只做「校验 + 缓存命中 + 入队」，浏览器解析回容器（CF Queues / SQS 触发）。

---

## 9. 测试（Bun test 具体做法）

### 9.1 分层（成本递增，覆盖递减）

| 层 | 测什么 | 依赖 | 速度 | 何时跑 |
|---|---|---|---|---|
| L1 纯函数 | `extractUrl` / `match` / `parse` / `urlExpiry` / `computeTtlMs` | 无 | ms | 每次 push |
| L2 fixture 映射 | `aweme_detail` → `ParseResult` | fixture | ms | 每次 push |
| L3 契约 | fixture 是否还长得像线上（字段名/URL 形态） | fixture | ms | 每次 push（更新 fixture 时人工确认） |
| L4 HTTP 层 | `POST /parse` 错误码分支、Elysia 校验、错误钩子 | 无浏览器/无端口 | ms | 每次 push |
| L5 浏览器交互 | 拦截 `response`、abort 策略 | FakePage | ms | 每次 push |
| L6 E2E smoke | 真实链接 | 真 Chromium + 网络 | 10–30 s | **手动 / 每日定时** |

**前提**：现在 `parseVideo` 把「抓取」和「映射」揉在一起，L2/L3 根本没法测。必须先做 §9.2 的两处可测性重构，否则只能等 E2E = 等于没测试。

### 9.2 两处最小的可测性重构

**(1) 抽出纯映射层** `platforms/douyin/parse.ts`：

```ts
export function pickPlayUrl(detail: any): string | null {
  const list: unknown = detail?.video?.play_addr?.url_list;
  if (!Array.isArray(list)) return null;
  return list.find((u): u is string => typeof u === 'string' && u.includes('/aweme/v1/play/')) ?? null;
}

export function mapAwemeDetail(detail: any, fetchedAt: number): ParseResult {
  const assets: MediaAsset[] = [];
  const play = pickPlayUrl(detail);
  if (play) assets.push({ type: 'video', url: play, key: objectIdFromUrl(play),
                          expiresAt: urlExpiry(play), proxyHeaders: { referer: 'https://www.douyin.com/' } });
  for (const url of pickImageUrls(detail)) {
    assets.push({ type: 'image', url, expiresAt: urlExpiry(url), proxyHeaders: {} });   // douyinpic 不校验
  }
  return { platform: 'douyin', id: detail?.aweme_id ?? '', title: detail?.desc ?? '',
           author: { name: detail?.author?.nickname ?? '', avatar: detail?.author?.avatar_thumb?.url_list?.[0] },
           assets, expiresAt: earliestExpiryOf(assets), parsedAt: fetchedAt, via: 'http' };
}
```

`fetch.ts` 里那几十行字段提取 if/else 直接换成 `return mapAwemeDetail(json, now)`。

**(2) 依赖注入 page 工厂**：`class DouyinParser { constructor(private pageFactory: () => Promise<Page> = () => browserManager.createPage()) {} }`。改完 3 处调用点，之后所有浏览器测试都能用 FakePage。

### 9.3 fixture 怎么录

```ts
// scripts/record.ts —— 手动跑一次，产物进 tests/fixtures/
// bun run scripts/record.ts "https://www.douyin.com/video/xxx" > tests/fixtures/douyin/aweme-detail.json
const page = await browser.newPage();
let captured: any = null;
page.on('response', async (res) => {
  if (res.url().includes('/aweme/v1/web/aweme/detail/')) { try { captured = await res.json(); } catch {} }
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 100 && !captured; i++) await Bun.sleep(100);
// ★ 脱敏：去掉 token / 签名 / 真实 uid
const json = JSON.stringify(captured, null, 2).replace(/([?&](?:sig|token|a_bogus|msToken)=)[^"&]+/g, '$1REDACTED');
```

要点：**存原始 JSON，不手写**（手写的 fixture 是「我以为线上长这样」，测不出平台改版）；**必须脱敏**（fixture 会进 git）。

### 9.4 Bun test 关键写法

```ts
// 纯函数
import { describe, expect, it, spyOn } from 'bun:test';

describe('extractUrl', () => {
  it('从分享文案里取第一条链接并去掉尾部标点', () => {
    expect(extractUrl('7.99 复制打开抖音 https://v.douyin.com/iRNBho6u/ 复制此链接'))
      .toBe('https://v.douyin.com/iRNBho6u/');
    expect(extractUrl('看这个 https://xhslink.com/a/abc，')).toBe('https://xhslink.com/a/abc');
  });
});

// fixture 映射
import fixture from '../fixtures/douyin/aweme-detail.json';
it('映射成统一结构', () => {
  const r = mapAwemeDetail(fixture, 1_700_000_000);
  expect(r.assets.filter(a => a.type === 'video')).toHaveLength(1);
  expect(r.expiresAt).toBeNumber();
});
```

**FakePage（不 mock 库，mock 边界）**——比 `mock.module('puppeteer')` 稳，因为它锁的是你自己的接口：

```ts
class FakePage {
  closed = false;
  navigations: string[] = [];
  private handlers: Record<string, ((a: any) => void)[]> = {};
  constructor(private payload: unknown = null) {}
  async setRequestInterception() {}
  on(e: string, h: (a: any) => void) { (this.handlers[e] ??= []).push(h); }
  removeAllListeners(e: string) { this.handlers[e] = []; }
  private emit(e: string, a: any) { for (const h of this.handlers[e] ?? []) h(a); }
  async goto(url: string) {
    this.navigations.push(url);
    this.emit('request', { url: () => url, resourceType: () => 'document', abort: async () => {}, continue: async () => {} });
    if (this.payload) this.emit('response', {
      url: () => 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1',
      headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => this.payload,
    });
  }
  async evaluate() { return 1; }
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
}

it('拦截 detail 接口并映射', async () => {
  const page = new FakePage(fixture);
  const parser = new DouyinParser(async () => page as any);
  const r = await parser.parseVideo('https://www.douyin.com/video/7300000000000000000');
  expect(page.navigations).toEqual(['https://www.douyin.com/video/7300000000000000000']);
  expect(page.closed).toBe(true);            // ★ 断言资源回收，防泄漏回归
});
```

> 这个用例还能**钉住一个真实 bug**：抓到风控页时现状走 `parseGalleryFromPage` 兜底返回 `{title:"",resources:[]}`，controller 判 `if (apiResult)` 为真 → 用户拿到 `success:true` + 空资源。写成 `expect(r).toBeNull()`（或 `expect(() => ...).toThrow()`）后，改动会立刻红。

**HTTP 层不启浏览器、不开端口**：`app.handle(new Request(...))` 直接跑完整路由 + 校验 + 错误钩子。

```ts
const app = createApp();
const post = (body: unknown) => app.handle(new Request('http://localhost/parse', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

it('文案里没有链接 → 1201', async () => {
  const res = await post({ url: '今天天气不错没有链接' });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ success: false, errorCode: 1201 });
});
it('未支持平台 → 1202 且带 supported 列表', async () => {
  const body = await (await post({ url: 'https://example.com/video/1' })).json();
  expect(body.errorCode).toBe(1202);
  expect(body.details.supported).toContain('douyin');
});
```

**拦 fetch 用 `spyOn`**（不要指望 undici MockAgent：Bun 的 `fetch` 是原生实现，不走 undici 的 global dispatcher；**未核验**但无需冒险）：

```ts
const spy = spyOn(globalThis, 'fetch').mockImplementation(async (input: any) =>
  new Response(JSON.stringify({ aweme_detail: fixture.aweme_detail }), { headers: { 'content-type': 'application/json' } }));
// ...断言后必须恢复
spy.mockRestore();
```

**`mock.module` 只在必须替换整个库时用**：

```ts
mock.module('puppeteer', () => ({ default: { launch: async (o: any) => { launched.push(o); return fakeBrowser; } } }));
afterAll(() => mock.restore());
```

注意：`mock.restore()` 会恢复模块，**但不会恢复 `spyOn` 的原实现**（文档明确）；且 `BrowserManager` 是单例缓存 browser，跨文件会串 → 给类加 `reset()`，或把断言锁在同一文件。

**E2E 默认跳过，但要显式显示 skip**：

```ts
const RUN = process.env.E2E === '1' && !!process.env.E2E_DOUYIN_URL;
describe.skipIf(!RUN)('E2E 抖音真实解析', () => {
  it('能拿到至少一个资源', async () => {
    const r = await new DouyinParser().parseVideo(process.env.E2E_DOUYIN_URL!);
    expect(r!.assets.length).toBeGreaterThan(0);
  }, 60_000);
});
```

用 `skipIf` 而不是 `if (!RUN) return;`——后者在 CI 里看不出到底跑没跑。

**覆盖率**：

```toml
# bunfig.toml
[test]
coverageReporter = ["text", "lcov"]
coverageSkipTestFiles = true
coverageThreshold = { lines = 0.80, functions = 0.75 }
```

`statements` 键「接受但不强制」，只有 `lines`/`functions` 生效。合理目标：`core/**`、`platforms/*/parse.ts`、`cache/**` ≥ 90%；`fetch.ts` ≥ 70%；`infra/browser` 靠 E2E 兜。

### 9.5 CI

```yaml
name: test
on:
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: "0 18 * * *" }]        # 每天 02:00 CST 跑 E2E
jobs:
  unit:
    runs-on: ubuntu-latest
    env: { PUPPETEER_SKIP_DOWNLOAD: "true" }   # 关键：别在 CI 拉 Chrome
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "1.3.10" }
      - run: bun install --frozen-lockfile
      - run: bun test --coverage
```

**这类依赖外部平台的服务，测试策略一句话**：把「网络」和「解析」彻底切开，让**解析逻辑 100% 可离线回归**，网络问题交给 E2E 与线上指标（`UPSTREAM_CHANGED` 告警）。平台改版时你要看到的是「parser 单测红」，而不是「线上悄悄返回空数组」。

---

## 10. 参考项目（GitHub 实测数据，2026-10-24 16:19 CST）

| 项目 | Star | 最近提交 | License | 主语言 | 该学什么 |
|---|---|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 201,170 | 2026-10-23 | Unlicense | Python | **声明式匹配 + 纯函数解析 + 通道降级 + 内嵌 `_TESTS`**（§2 全篇） |
| [cobalt](https://github.com/imputnet/cobalt) | 45,396 | 2026-04-06 | AGPL-3.0 | Svelte（**api 是纯 JS**） | 单端点 + `status` 判别式响应；识别层数据化；错误码命名空间化 |
| [RSSHub](https://github.com/DIYgod/RSSHub) | 46,634 | 2026-10-24 | AGPL-3.0 | TypeScript | 「元数据 + handler 同一对象」；构建期注册表 + 开发期懒加载；**按上游 host 出站限流** |
| [Verdaccio](https://github.com/verdaccio/verdaccio) | 17,940 | 2026-10-24 | MIT | TypeScript | 插件**加载失败隔离**、`sanityCheck` 能力校验、插件基类带契约 `version` |
| [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API) | 20,863 | 2026-10-21 | Apache-2.0 | Python（**非同栈，仅借契约**） | **目录自动发现**（加平台 = 加目录）、适配器零 IO、`{platform}` 作路径参数、错误码按「谁的错」分 400/502/503 |

> 前置事实：**中文短视频解析的 TS 生态没有成熟可参考项目**。GitHub 按 star 搜 `douyin`/`小红书`，TypeScript 结果最高只有个位数 star（如 `Potato-Allens/Douyin-Watermark-Free-Parser` 3★、Hono），领域高星项目全在 Python/Go。所以第 5 项故意选了 Python 项目**只借 API 契约**。

### 10.1 横向对比

| 维度 | yt-dlp | cobalt | RSSHub | Verdaccio | Evil0ctal |
|---|---|---|---|---|---|
| 插件/注册机制 | 命名空间包 + `_CLASS_LOOKUP` 查表 + 惰性壳 | 声明式域名表 + **手写 switch** | 路由即模块，**构建期**扫生成 registry + 外部路由目录 | 配置 key → `verdaccio-*` 包名 + sanityCheck | **目录扫描自动发现**，缺 `ADAPTER` 直接 fail-fast |
| 平台适配层 | `extractor/*.py`，统一返回 `formats[]` | `services/<name>.js`，统一返回 `{urls,isPhoto,isHLS,...}` | `routes/<ns>/<route>.ts`，handler 返回数据或 Response | 无（auth/storage/middleware 插件） | `platforms/<name>/`，`PlatformAdapter` 协议，parser 纯函数零 IO |
| 缓存 | 无（下载器不缓存元数据） | 无（流式隧道） | 全局中间件，xxhash key，Redis，`claim` 原子去重 | uplink `maxage`/`max_fails` | `services/cache.py`（TTL 策略未逐行核验） |
| 限流 | 无（本地 CLI） | express-rate-limit × 3 档，Redis store，key=HMAC(IP) | **无入站**，有按上游 host 的出站限流 | `middleware/rate-limit.ts` | `enforce_rate_limit` + `QUEUE_FULL` |
| 测试 | `_TESTS` 内嵌，`only_matching`/`md5` 分级 | 每平台一份 JSON fixture + 独立 workflow | vitest，测试与被测文件同级 | 各包 vitest + integration | `tests/` + replay 测试 |
| 部署 | 单二进制/zipimport | Docker（api + web） | Docker / Vercel / CF Workers 多入口 | Docker + npm + helm | Docker / compose（API 与 worker 分容器） |

**四条路线一句话**：yt-dlp = 契约最严；cobalt = 表驱动识别但**分发仍是 switch**（正是你要消灭的）；RSSHub = 扩展最好但机制最重；Evil0ctal = 扩展最省但约束最严。
**本项目要的形态**：RSSHub 的「约定 + 自动收集」+ Evil0ctal 的「零 IO 适配器协议」+ yt-dlp 的「`_TESTS` 内嵌」，**不要** cobalt 的 switch。

### 10.2 可直接抄的两个细节

1. **cobalt 的 `status` 判别式**（[api/src/processing/match-action.js](https://github.com/imputnet/cobalt)）：解析服务天然是「一次输入、多种产物」（单视频/图集/多清晰度/picker），用 `status` 字段判别比开 `/video` `/images` 三条路由省心，前端一个 switch 就够。
2. **RSSHub 的出站限流**（`lib/utils/host-rate-limit.ts`，`REQUEST_RATE_LIMITS` 按目标 host 配 `{points, duration}`）：**被限流的是你自己，不是调用方**。这条比入站限流更贴合本项目——尤其抖音频控。

---

## 11. 落地路线（按 PR 拆，每步可独立上线）

| # | 内容 | 风险 | 验收 |
|---|---|---|---|
| 0 | 删 `PuppeteerManager`（明文凭据）、下线 `/public/cache/*`、`errorHook` 改 JSON | 零 | `grep` 无残留；错误响应是 JSON |
| 1 | `core/errors.ts` + `envelope.ts` + `http/error-handler.ts`（§7） | 低 | L4 测试覆盖 1201/1202/1203 |
| 2 | `platforms/types.ts` + `registry.ts`，把抖音搬成 adapter（`fetch` + `parse` 拆开） | 中 | 加新平台的 diff 只有 1 个目录 + 1 行 registry |
| 3 | 小红书改走 `__INITIAL_STATE__`（弃 DOM 翻页），保留浏览器兜底 | 中 | fixture 回归通过；P95 显著下降 |
| 4 | 缓存换 `lru-cache` + `computeTtlMs` + singleflight + 负缓存（§5） | 低 | `url_expiry_seconds` 有数据；命中率可观测 |
| 5 | `/metrics` + `/health` + `/ready` + `prom-client` + pino redact | 零 | 先拿基线，再谈优化 |
| 6 | `elysia-rate-limit@4.6.3` + 中转 `/media`（§4.3） | 中 | Range/HEAD/302 三条 curl 验收 |
| 7 | 浏览器池信号量 + 硬超时 + 熔断（§6.3 §6.5） | 中 | `browser_pool_waiting` 常态 0 |
| 8 | Redis L2 + Redis 限流 context（多副本前必须完成） | 中 | 两副本额度不翻倍 |
| 9 | Dockerfile 换 musl target + 非 root + 健康检查（§8.2） | 低 | 镜像 <1 GB，`HEALTHCHECK` 生效 |

**三个最容易翻车的点**（都是实测量出来的，不是理论）：
1. `maxTtlMs` 拍成 30 分钟 → 直链早死了，用户拿到 403，还以为是解析器坏了。
2. 限流 key 用 `X-Forwarded-For` 第一段且不校验代理 → 一行 header 绕过。
3. `/health` 里查 Redis → Redis 抖 3 秒，全部副本连环重启。

---

## 12. 未核验清单（明确不装懂）

- 抖音 `douyinvod` 直链**精确 TTL**：本次只观察到「路径时间戳 ≈ 签发 + 24h」，**没等它真过期验证**；社区另有「约 80 分钟」的实测值（`hiyufan/alcedo`），二者矛盾，须以线上 `url_expiry_seconds` 直方图为准。
- 抖音签名 URL 是否**绑定出口 IP**：本次所有测试同 IP，未验证换 IP 是否失效。
- 旧式 `x-expires` / `x-signature` 形式的抖音直链（本次样本 query 里没有这两个参数）。
- 小红书 `xhscdn` 直链是否**永久有效**：无 query 签名是事实，「长期可用」只是社区实践。
- 小红书笔记页 `xsec_token` 强校验细节 + `originVideoKey` 提取：本机 IP 被风控，**未复现**（02 文档同样标注）。
- Workers 免费 100k 请求/天 折算成「多少次播放」（`<video>` 的 Range 请求倍数）。
- Worker 能否设置 `Host` 头；Worker 内手动跟 302 与 `redirect:'follow'` 的 subrequest 计数差异。
- `ioredis@6` 在 Bun 下的长期稳定性（检索到的 issue 不足以证明）。
- `elysia-prometheus@1.1.1` 在 Elysia 1.2.x + Bun 下的实际行为（17★，未实测，建议自写）。
- docker-slim 对 Chromium 镜像的实际压缩率。
- CF Browser Rendering 的出口 IP 在抖音/小红书风控下的命中率。

---

## 13. 参考链接（均为实际抓取，2026-10-24）

**yt-dlp**
- 基类与匹配：[extractor/common.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py)（`_match_valid_url` L616、`suitable` L627、`_match_id` L634、`_real_extract` L829、`_request_webpage` L864、`_search_json` L1349）
- 注册表：[extractor/extractors.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/extractors.py)、聚合清单 [extractor/_extractors.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/_extractors.py)
- 插件加载：[yt_dlp/plugins.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/plugins.py)
- 小红书（纯 HTTP）：[extractor/xiaohongshu.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/xiaohongshu.py)
- 抖音 / 短链：[extractor/tiktok.py#L1371](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py#L1371)（`DouyinIE`）、[#L1511](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/tiktok.py#L1511)（`TikTokVMIE`）
- 插件文档：[README#plugins](https://github.com/yt-dlp/yt-dlp#plugins)、[Plugin-Development wiki](https://github.com/yt-dlp/yt-dlp/wiki/Plugin-Development)

**代理 / 防盗链**
- Cloudflare Workers [Limits](https://developers.cloudflare.com/workers/platform/limits/) / [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) / [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/) / [Request `redirect`](https://developers.cloudflare.com/workers/runtime-apis/request/) / [Range 行为](https://developers.cloudflare.com/cache/reference/range-requests/)
- nginx [proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) / [slice_module](https://nginx.org/en/docs/http/ngx_http_slice_module.html)
- MDN [Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range) / [206](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/206)

**运行时 / 生态**
- Bun [executables](https://bun.com/docs/bundler/executables) / [redis](https://bun.com/docs/runtime/redis) / [test](https://bun.com/docs/cli/test) / [mocks](https://bun.com/docs/test/mocks) / [coverage](https://bun.com/docs/test/coverage) / [nodejs-apis 兼容表](https://bun.com/docs/runtime/nodejs-apis)
- `elysia-rate-limit` [npm](https://www.npmjs.com/package/elysia-rate-limit)（5.1.1 → Elysia ≥2.0.0；4.6.3 → ≥1.0.0）、`lru-cache` [npm](https://www.npmjs.com/package/lru-cache) 11.5.3、`cockatiel` [GitHub](https://github.com/connor4312/cockatiel) 4.0.0
- Docker [HEALTHCHECK](https://docs.docker.com/reference/dockerfile/#healthcheck)、[compose 启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)、k8s [探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- Cloudflare [Browser Rendering limits](https://developers.cloudflare.com/browser-rendering/limits/)、Vercel [functions limits](https://vercel.com/docs/functions/limitations)
- puppeteer [troubleshooting](https://pptr.dev/troubleshooting)、pm2 [cluster mode](https://pm2.keymetrics.io/docs/usage/cluster-mode/)
