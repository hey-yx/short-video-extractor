<div align="center">
<h1 align="center">Video Parser Service</h1>
这是一个可以快速部署的短视频解析服务，开箱即用，支持小红书、抖音、快手解析

<br />
<br />

[![GitHub License](https://img.shields.io/github/license/yassine-zhang/short-video-extractor?style=flat-square&color=gold)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/yassine-zhang/short-video-extractor?style=flat-square)](https://github.com/yassine-zhang/short-video-extractor/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/yassine-zhang/short-video-extractor?style=flat-square)](https://github.com/yassine-zhang/short-video-extractor/forks)
[![GitHub Issues or Pull Requests](https://img.shields.io/github/issues/yassine-zhang/short-video-extractor?style=flat-square&color=mediumpurple)](https://github.com/yassine-zhang/short-video-extractor/issues)
[![GitHub Issues or Pull Requests](https://img.shields.io/github/issues-closed/yassine-zhang/short-video-extractor?style=flat-square&color=mediumpurple)](https://github.com/yassine-zhang/short-video-extractor/issues?q=is%3Aissue%20state%3Aclosed)
[![Docker Image Size](https://img.shields.io/docker/image-size/yassine778/video-parser?arch=amd64&style=flat-square&logo=docker&logoColor=mediumseagreen&color=mediumseagreen)](https://hub.docker.com/r/yassine778/video-parser)
![GitHub repo size](https://img.shields.io/github/repo-size/yassine-zhang/short-video-extractor?style=flat-square&color=mediumseagreen)

</div>

## 功能列表

1.  每次解析速度稳定在 1 ~ 3 秒，采用 API 拦截技术，快速且完整；
    > **温馨提示**：当前测试服务器带宽仅为 3Mbps（上下行），解析速度可能较慢，建议部署到更高带宽的服务器以获得更好的性能体验；
2.  浏览器实例复用：使用单例模式管理浏览器实例，首次启动后响应速度提升约 2-3 秒；
3.  智能缓存机制：相同 URL 在一小时内重复请求将直接返回缓存结果，大幅提升响应速度；
4.  多平台支持：支持小红书、抖音解析，自动获取无水印资源；
5.  完整资源捕获：通过 API 拦截技术，确保获取所有图片和视频资源。

## 支持平台

| 平台   | 支持类型                | 特点                 |
| ------ | ----------------------- | -------------------- |
| 小红书 | 视频、图片（单图/多图） | 完整获取所有图片资源 |
| 抖音   | 视频、图集              | 无水印视频           |

## 注意

当前项目采用 API 拦截技术实现短视频解析，直接从平台 API 获取数据，无需复杂签名算法，速度快且稳定性高。

**技术优势**：

- API 拦截：直接获取平台 API 数据，比 DOM 解析快 3-4 倍
- 完整资源：从 API 响应中提取所有资源，不会遗漏
- 资源优化：拦截图片、字体等资源加载，降低带宽消耗
- 自动降级：API 失败时自动降级到浏览器解析
- 浏览器复用：单例模式管理浏览器实例

**已知限制**：

- **抖音图集解析**：由于抖音图集类型不调用详情 API，需使用 Puppeteer 监听网络资源获取图片，**无法返回标题、作者头像等元数据信息**（仅返回资源列表）
- **资源捕获稳定性**：使用 Puppeteer（非逆向手段）不仅请求速度较慢（相比 API 调用），还存在一定概率丢失捕获资源的情况，属于正常现象

## 未来计划

1. 支持更多短视频平台
2. 实现纯 API 调用（无需浏览器）
3. 添加批量解析功能
4. 提供更多 CDN 加速选项

## API 接口

### 标准接口

| 接口路径           | 请求方法 | Content-Type     | 请求参数示例                              | 说明                     |
| ------------------ | -------- | ---------------- | ----------------------------------------- | ------------------------ |
| /pv                | POST     | application/json | {<br> &nbsp;&nbsp; "url": "平台链接"<br>} | 解析短视频接口，简化地址 |
| /public/parseVideo | POST     | application/json | {<br> &nbsp;&nbsp; "url": "平台链接"<br>} | 解析短视频接口           |

### 缓存管理接口

| 接口路径             | 请求方法 | 请求参数示例                              | 说明                                          |
| -------------------- | -------- | ----------------------------------------- | --------------------------------------------- |
| /public/cache/stats  | GET      | 无                                        | 获取缓存统计信息（缓存数量、所有缓存的URL等） |
| /public/cache/clear  | POST     | 无                                        | 清空所有缓存                                  |
| /public/cache/delete | POST     | {<br> &nbsp;&nbsp; "url": "平台链接"<br>} | 删除指定URL的缓存                             |

**缓存说明**：

- 缓存有效期：1小时
- 缓存键生成规则：自动移除URL中的动态查询参数（如 `xhsshare`、`xsec_token` 等），确保相同内容的URL能命中缓存
- 自动清理：每10分钟自动清理过期缓存
- 缓存命中率：相同URL在一小时内的重复请求将直接从内存返回，响应速度从秒级降至毫秒级

---

## 环境变量说明

- `PORT`：服务监听端口（开发环境建议 10010，生产环境建议 7777）
- `PUPPETEER_EXECUTABLE_PATH`：指定 Puppeteer 启动时所用 Chromium/Chrome 浏览器的绝对路径，建议在 Docker 或服务器环境下设置为 `/usr/bin/chromium-browser`，否则 Puppeteer 可能无法正常启动。

## 本地运行

### 安装依赖

```bash
bun install
```

### 直接运行源代码

```bash
bun run dev
```

### 编译并运行

```bash
bun run build-local && bun run start
```

## Docker 镜像快速使用

你可以直接拉取并运行我们已构建好的官方镜像，无需本地构建：

### 1. 拉取镜像

```bash
docker pull yassine778/video-parser:latest
```

### 2. 运行容器

```bash
docker run -d \
  -p 10010:7777 \
  --name video-parser \
  yassine778/video-parser:latest
```

### 3. 验证服务

容器启动后，发起 POST 请求 `http://localhost:10010/public/parseVideo` 即可调用接口。

---

详情内容请参考[详细部署文档](./docs/DEPLOYMENT.md)。

如遇镜像拉取缓慢，可参考[镜像源配置指南](./docs/DOCKER_MIRROR.md)加速 Docker 镜像下载。

---

如需进一步定制或有疑问，欢迎随时联系技术支持。

## 联系我们

- QQ: 57878778
- 邮箱：support@itcox.cn

## 赞助支持

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。Copyright © 2025 济宁若森软件开发中心（个人独资）
