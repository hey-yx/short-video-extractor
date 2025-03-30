# Video Parser Service[![Status](https://status.itcox.cn/badge/sve-api/dot?animate=ping)](https://status.itcox.cn)

[![short-video-extractor ✨](https://status.itcox.cn/badge/sve-api/status?labelColor=&color=&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8)](https://status.itcox.cn)
[![short-video-extractor ✨ 90D](https://status.itcox.cn/badge/sve-api/uptime?labelColor=333&color=7a44dc&style=for-the-badge&label=short-video-extractor%20%E2%9C%A8&sinceLast=7776000&hideDuration=false)](https://status.itcox.cn)

一个强大的短视频解析服务，支持主流短视频平台的无水印视频提取。

## 支持的平台

抖音、快手、火山、头条、西瓜、微博、秒拍、微视、美拍、映客、陌陌...

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

## 快速开始

1. 克隆项目
2. 安装依赖
3. 启动服务
4. 调用API

详细部署说明请参考 [部署文档](./docs/DEPLOYMENT.md)

## 联系我们

- 邮箱: support@itcox.cn
- QQ: 57878778

## 赞助支持

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>
