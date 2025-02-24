# 错误码

## 1201 - 解析失败

```json
{
  "success": false,
  "data": { "videoUrl": "", "title": "" },
  "message": "解析失败，未找到视频链接或图片列表",
  "errorCode": 1201
}
```

## 1202 - 服务器错误

```json
{
  "success": false,
  "data": { "videoUrl": "", "title": "" },
  "message": "服务器错误",
  "errorCode": 1202
}
```

## 1203 - 解析超时

```json
{
  "success": false,
  "data": {
    "videoUrl": "",
    "title": ""
  },
  "message": "解析超时，请稍后重试",
  "errorCode": 1203
}
```
