# Video Parser Service[![Status](https://status.itcox.cn/badge/sve-api/dot?animate=ping&t=)](https://status.itcox.cn)

[![short-video-extractor ✨](https://status.itcox.cn/badge/sve-api/status?labelColor=&color=&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8&t=)](https://status.itcox.cn)
[![short-video-extractor ✨ 90D](https://status.itcox.cn/badge/sve-api/uptime?labelColor=333&color=7a44dc&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8&sinceLast=7776000&hideDuration=false&t=)](https://status.itcox.cn)

一个强大的短视频解析服务，支持主流短视频平台的无水印视频提取。基于 Bun 运行时开发，提供高性能的 API 服务。

## 支持的平台

- 抖音 (Douyin)
- 快手 (Kuaishou)
- 火山 (Huoshan)
- 头条 (Toutiao)
- 西瓜 (Xigua)
- 微博 (Weibo)
- 秒拍 (Miaopai)
- 微视 (Weishi)
- 美拍 (Meipai)
- 映客 (Yingke)
- 陌陌 (Momo)

## 技术栈

- 运行时：Bun 1.1.21
- 包管理：Bun
- 进程管理：PM2
- 浏览器自动化：Puppeteer
- 容器化：Docker

## API 接口

### 标准接口

```http
POST /public/parseVideo
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

### 简化接口

```http
POST /pv
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

### 响应示例

```json
{
  "success": true,
  "data": {
    "videoUrl": "https://xxx.com/video.mp4",
    "title": "视频标题",
    "cover": "https://xxx.com/cover.jpg",
    "author": "作者名称",
    "platform": "douyin"
  },
  "message": "视频解析成功"
}
```

## 特点

- 解析速度快：3-5秒内完成
- 稳定可靠：内置智能重试机制
- 高清原片：提供最高质量视频源
- 使用简单：仅需分享链接即可解析
- Docker 支持：一键部署
- 多平台支持：覆盖主流短视频平台
- 自动重试：失败自动重试机制
- 日志记录：完整的运行日志

## 快速开始

### 使用 Docker 部署

```bash
# 拉取镜像
docker pull itcox/short-video-extractor:latest

# 运行容器
docker run -d -p 7777:7777 --name video-parser itcox/short-video-extractor:latest
```

### 本地开发

1. 克隆项目

```bash
git clone https://github.com/yourusername/short-video-extractor.git
cd short-video-extractor
```

2. 安装依赖

```bash
bun install
```

3. 启动开发服务器

```bash
bun run dev
```

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。Copyright © 2025 济宁若森软件开发中心（个人独资）

## 联系我们

- 官方网站：[https://itcox.cn](https://itcox.cn)
- 邮箱：support@itcox.cn

## 赞助支持

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>
