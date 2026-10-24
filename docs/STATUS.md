# 现状诊断（2026-10-24）

仓库：`hey-yx/short-video-extractor`（原名 yassine-zhang/short-video-extractor，已转到本人账号，非 fork，无上游可同步）
规模：15 个 TS 文件 / 1918 行，Bun + Elysia + Puppeteer，Apache-2.0，103 star
接口：`POST /pv`、`POST /public/parseVideo`（同一 handler），`/public/cache/*`
支持：小红书（视频/图集）、抖音（视频/图集）—— 快手支持已在 2026-02 移除

---

## P0 安全（上线前必须处理）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| 1 | **明文账号密码入库**：`business@itcox.cn` / 密码明文，且从 2025-06 起就在 git 历史里（公开仓库） | `src/utils/puppeteer.ts:379-380` | 该账号已实质泄露，需改密；代码是死代码（jiexiapi.top 登录流程，已无用）仍被打包 |
| 2 | 接口无鉴权、无限流，CORS `origin: "*"` | `bootstrap/app.ts:24`、`routes/*` | 任何人可当免费公共 API 刷，单机被跑满即全站不可用 |
| 3 | 只返回平台直链，不带中转 | `controllers/*` | 前端跨域播放/下载大概率 403（平台防盗链校验 Referer），用户拿到链接却下不动 |

## P1 可靠性（这是"1~3 秒"背后真正的坑）

| # | 问题 | 位置 | 后果 |
|---|---|---|---|
| 4 | 抖音解析 = 开页拦截 `/aweme/v1/web/aweme/detail/`，轮询 5s；拿不到就降级图集嗅探：`networkidle2` 30s + 硬等 3s + 翻页点击 + 稳定性轮询 2s | `utils/api-parser.ts:315-470` | 正常 1-3s，异常路径最坏 40s+，且经常返回"空结果"而非明确错误 |
| 5 | 图集页数靠 DOM 文本匹配 `^\d+\s*/\s*\d+$`、靠猜 SVG path 找"下一个"按钮 | `api-parser.ts:171-269` | 页面改版即失效（issue #11「封面无法解析」即此类） |
| 6 | 无并发控制、无页面池上限、无超时预算、无熔断 | `utils/puppeteer.ts` | 并发上来后页面/内存堆积，浏览器单点卡死全站 |
| 7 | 缓存只有小红书一份，抖音零缓存；`CacheManager` 每实例自带 `setInterval` 不可按 key 设 TTL | `utils/cache.ts`、`controllers/core/xiaohongshu.ts:29` | 同链接重复解析；多实例部署时缓存各自为政 |
| 8 | `GET /public/cache/stats` 从 `body` 取值；`clear` 只清小红书 | `cache.controller.ts` | 接口语义错，运维以为清了其实是半个 |
| 9 | 日志全靠 `console.log`，无级别、无请求 ID；线上无法定位是哪次解析失败 | 全项目 | 排障靠猜 |
| 10 | 无重试、无降级链设计（现状是"隐式 fallback"），失败原因被吞（大量 `catch {}`） | `api-parser.ts:307-309` | 用户只看到"解析失败"，无法区分风控/网络/改版 |

## P2 架构与可扩展性

| # | 问题 | 位置 |
|---|---|---|
| 11 | 平台分发写死 switch + 主域名匹配，新增平台要同步改 controller/routes/types | `platform-transfer.ts:37-75` |
| 12 | 解析逻辑塞在 controller（小红书单函数 290 行），浏览器交互/资源抓取/响应组装混在一起，无法单测 | `controllers/core/xiaohongshu.ts` |
| 13 | 返回结构 `resources[{type,urls}]`，`type` 是自由字符串；小红书用「URL 含 `sign`」判 video/live，判断本身是错的（`sns-video-` 一律是视频） | `xiaohongshu.ts:64` |
| 14 | 伪造 Context 传参：`parseXiaohongshuContent({ body: { url } } as Context)`，类型形同虚设 | `platform-transfer.ts:44` |
| 15 | `any` 遍布（`videoData: any`、`resources: any`），无统一 ContentResult 领域模型 | `api-parser.ts` |
| 16 | 无测试、无 lint（只有 prettier）、无 CI（现有 workflow 只更 badge） | 全项目 |

## P3 功能缺失

- 短链自己展开（抖音靠浏览器跳转，纯 API 方案必须自己跟 302）
- 封面（issue #11）、作者 ID（issue #10）、标题/正文/tag 分离（issue #12）
- 批量解析、清晰度选择、直播/实况照片
- 下载中转（Range、文件名、Content-Disposition）

## 上游 issue 未解（社区真实反馈，可作为验收用例）

- #12 无标题时把正文和 tag 当标题
- #11 判断条件导致封面无法解析
- #10 希望返回用户 id
