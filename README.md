<div align="center">
<h1 align="center">Video Parser Service</h1>
✨✨✨这是一个可以快速部署的短视频解析服务，开箱即用，目前支持小红书解析服务✨✨✨

<br />

[![GitHub License](https://img.shields.io/github/license/yassine-zhang/short-video-extractor?style=flat-square&color=gold)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/yassine-zhang/short-video-extractor?style=flat-square)](https://github.com/yassine-zhang/short-video-extractor/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/yassine-zhang/short-video-extractor?style=flat-square)](https://github.com/yassine-zhang/short-video-extractor/forks)
[![GitHub Issues or Pull Requests](https://img.shields.io/github/issues/yassine-zhang/short-video-extractor?style=flat-square&color=mediumpurple)](https://github.com/yassine-zhang/short-video-extractor/issues)
[![GitHub Issues or Pull Requests](https://img.shields.io/github/issues-closed/yassine-zhang/short-video-extractor?style=flat-square&color=mediumpurple)](https://github.com/yassine-zhang/short-video-extractor/issues?q=is%3Aissue%20state%3Aclosed)
[![Docker Image Size](https://img.shields.io/docker/image-size/yassine778/video-parser?arch=amd64&style=flat-square&logo=docker&logoColor=mediumseagreen&color=mediumseagreen)](https://hub.docker.com/r/yassine778/video-parser)
![GitHub repo size](https://img.shields.io/github/repo-size/yassine-zhang/short-video-extractor?style=flat-square&color=mediumseagreen)

[![Server Status](https://img.shields.io/endpoint?url=https%3A%2F%2Fkener-sve-monitor-to-shieldsendpoints.it-edu.workers.dev%2Fstatus)](https://status.itcox.cn/?monitor=sve-api)
[![Server Uptime](https://img.shields.io/endpoint?url=https%3A%2F%2Fkener-sve-monitor-to-shieldsendpoints.it-edu.workers.dev%2Fuptime)](https://status.itcox.cn/?monitor=sve-api)

</div>

## 功能列表🎉🎉🎉

1.  每次解析速度稳定在 3 ~ 12s ，速度取决于页面内解析量和服务器下行网速✨；
2.  小红书实况图解析后会被作为视频返回，我们加入了 type 变量来区分解析的资源类型🎉；
3.  ...

## 注意⚠️

当前项目通过 Node.js puppeteer 模拟点击操作并监听资源实现短视频解析，受限于页面结构和反爬机制，无法保证长期稳定性。

## TodoList📍

在不久的将来，我将新开一个专门仓库，基于 Node.js 或 Python，直接调用小红书 API 接口获取数据，从而大幅提升解析的稳定性与兼容性，欢迎持续关注项目进展。

## API 接口

### 标准接口

| 接口路径           | 请求方法 | Content-Type     | 请求参数示例                                                             | 说明                     |
| ------------------ | -------- | ---------------- | ------------------------------------------------------------------------ | ------------------------ |
| /pv                | POST     | application/json | {<br> &nbsp;&nbsp; "url": "https://www.xiaohongshu.com/explore/xxx"<br>} | 解析短视频接口，简化地址 |
| /public/parseVideo | POST     | application/json | {<br> &nbsp;&nbsp; "url": "https://www.xiaohongshu.com/explore/xxx"<br>} | 解析短视频接口           |

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
