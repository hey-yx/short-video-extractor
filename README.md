# Video Parser Service

一个强大的短视频解析服务，支持主流短视频平台的无水印视频提取，快速、高质量地移除视频水印或图片水印。

平台支持：抖音、快手、火山、头条、西瓜、微博、秒拍、微视、美拍、映客、陌陌...

![](./docs/images/screenshot.png)

## 核心功能

### 无水印视频解析

- 支持抖音、快手等主流短视频平台
- 自动提取视频原始地址
- 获取视频标题和封面图
- 快速获取高清视频下载链接
- 支持批量解析（开发中）

## API 使用说明

### 解析接口

接口 1（标准接口）：

```http
POST /public/parseVideo
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

接口 2（简化接口）：

```http
POST /pv
Content-Type: application/json

{
  "url": "https://v.douyin.com/xxxxx/"
}
```

两个接口功能完全相同，您可以根据个人喜好选择使用。

#### 响应示例

解析视频：

```json
{
  "success": true,
  "data": {
    "videoUrl": "https://xxx.com/video.mp4",
    "title": "这是视频标题"
  },
  "message": "视频解析成功"
}
```

解析图集：

```json
{
    "success": true,
    "data": {
        "videoUrl": "",
        "title": "已经迫不及待的想要迎接春夏了～|||#冬天过腻了又开始期待夏天[话题]#+#开始期待夏天了[话题]#+#拍出氛围感[话题]#+#来拍照了[话题]#\n我+想+穿+漂亮+裙子+了+咧\n•̥+ˍ+•",
        "imagesList": [
            "http://ci.xiaohongshu.com/1040g00831d3skk5b0m004a2v3gkjs94dlto4rfo?imageView2/2/w/1080/format/jpg",
            "http://ci.xiaohongshu.com/1040g00831d3skk5b0m0g4a2v3gkjs94d48qa69g?imageView2/2/w/1080/format/jpg",
            "http://ci.xiaohongshu.com/1040g00831d3skk5b0m104a2v3gkjs94dpedumg0?imageView2/2/w/1080/format/jpg"
            ...
        ]
    },
    "message": "解析成功"
}
```

### 错误处理

文档地址：[错误码](./docs/ERROR_CODE.md)

## 使用特点

- 解析速度快：通常在3-5秒内完成解析
- 稳定可靠：采用先进的浏览器自动化技术
- 高清原片：提供最高质量的视频源链接
- 使用简单：仅需提供视频分享链接即可解析

## 开始使用

1. 克隆项目
2. 安装依赖
3. 启动服务
4. 调用API

详细的安装和配置说明请参考 [部署文档](./docs/DEPLOYMENT.md)。

## 联系我们

如有任何问题或建议，请随时联系我们：

- 邮箱: support@itcox.cn
- QQ: 57878778

## 赞助

<p style="display: flex;">
    <img src="./docs/images/wechat-pay.png" alt="赞助码" width="200">
    <img src="./docs/images/alipay.png" alt="赞助码" width="200">
</p>
