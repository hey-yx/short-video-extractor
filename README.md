# Video Parser Service

一个强大的短视频解析服务，支持主流短视频平台的无水印视频提取。支持130多个平台视频和图片，抖音去水印，快手去水印，小红书去水印，快速、高质量地移除视频水印或图片水印。

![](./docs/images/screenshot.png)

## 核心功能

### 无水印视频解析

- 支持抖音、快手等主流短视频平台
- 自动提取视频原始地址
- 获取视频标题和封面图
- 快速获取高清视频下载链接
- 支持批量解析（开发中）

## API 使用说明

### 视频解析接口

```http
POST /public/parseVideo
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

响应示例：

```json
{
  "success": true,
  "data": {
    "videoUrl": "https://xxx.com/video.mp4",
    "title": "这是视频标题",
    "cover": "https://xxx.com/cover.jpg"
  },
  "message": "视频解析成功"
}
```

### 错误处理

```json
{
  "success": false,
  "data": {
    "videoUrl": "",
    "title": "",
    "cover": ""
  },
  "message": "解析失败，未找到视频链接",
  "errorCode": 1201
}
```

## 使用特点

- 解析速度快：通常在3-5秒内完成解析
- 稳定可靠：采用先进的浏览器自动化技术
- 高清原片：提供最高质量的视频源链接
- 完整信息：同时获取视频标题和封面图
- 使用简单：仅需提供视频分享链接即可解析

## 开始使用

1. 克隆项目
2. 安装依赖
3. 启动服务
4. 调用API

详细的安装和配置说明请参考 [部署文档](./docs/DEPLOYMENT.md)。

## 注意事项

- 请合理使用，遵守相关平台的使用规范
- 建议增加请求频率限制，避免接口滥用
- 视频链接有效期可能受平台限制，建议及时下载

## 联系我们

如有任何问题或建议，请随时联系我们：

- 邮箱：support@itcox.cn

## 赞助

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>
