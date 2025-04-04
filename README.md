# Video Parser Service[![Status](https://status.itcox.cn/badge/sve-api/dot?animate=ping&t=1743490343t=1743725086t=1743714094t=1743703305t=1743692505t=1743681716t=1743670903t=1743660108t=1743650016t=1743638673t=1743627685t=1743616909t=1743606101t=1743595316t=1743584508t=1743573723t=1743563637t=1743552290t=1743541292t=1743530499t=1743519719t=1743508933)](https://status.itcox.cn)

[![short-video-extractor ✨](https://status.itcox.cn/badge/sve-api/status?labelColor=&color=&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8&t=1743490343t=1743725086t=1743714094t=1743703305t=1743692505t=1743681716t=1743670903t=1743660108t=1743650016t=1743638673t=1743627685t=1743616909t=1743606101t=1743595316t=1743584508t=1743573723t=1743563637t=1743552290t=1743541292t=1743530499t=1743519719t=1743508933)](https://status.itcox.cn)
[![short-video-extractor ✨ 90D](https://status.itcox.cn/badge/sve-api/uptime?labelColor=333&color=7a44dc&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8&sinceLast=7776000&hideDuration=false&t=1743490343t=1743725086t=1743714094t=1743703305t=1743692505t=1743681716t=1743670903t=1743660108t=1743650016t=1743638673t=1743627685t=1743616909t=1743606101t=1743595316t=1743584508t=1743573723t=1743563637t=1743552290t=1743541292t=1743530499t=1743519719t=1743508933)](https://status.itcox.cn)


一个强大的短视频解析服务，支持主流短视频平台的无水印视频提取，快速、高质量地移除视频水印或图片水印。

平台支持：抖音、快手、火山、头条、西瓜、微博、秒拍、微视、美拍、映客、陌陌...

![](./docs/images/screenshot.png)

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
    "title": "视频标题"
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

### 本地开发

1. 克隆项目
2. 安装依赖
3. 启动开发服务器

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。Copyright © 2025 济宁若森软件开发中心（个人独资）

## 联系我们

- QQ: 57878778
- 邮箱：support@itcox.cn

## 赞助支持

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>
