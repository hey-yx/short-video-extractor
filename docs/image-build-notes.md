# 镜像构建与裁剪记录

README 只保留结论，这里存完整的构建与裁剪过程记录。

## 体积实测（2026-10-25 构建）

| 阶段 | 体积 |
|---|---|
| 初始构建 | 830MB |
| 裁剪后 arm64 | 495MB |
| 裁剪后 amd64 | 527MB |

## 删除项清单

所有删除都在 apk 同一层内完成（装完即删，不产生独立层）：

| 删除项 | 体积 | 验证方式 |
|---|---|---|
| mesa/LLVM 软渲染栈 | -247MB | 容器内实测小红书浏览器通道真实解析通过 |
| 系统 ICU 数据 | -30MB | 同上 |
| ANGLE / SwiftShader | -7MB | 同上 |
| 若干无头解析用不到的数据文件 | 若干 MB | 同上 |

每一项删除都在容器内实测小红书浏览器通道解析通过后才保留，防止误删 Chromium 运行时真依赖。

## 保留项

- chromium 本体（浏览器兜底通道的内核）
- 其 ffmpeg 编码器依赖
- nss / 字体
- 100MB 的 bun 单二进制

## apk 镜像源

默认走阿里云镜像：实测 `dl-cdn.alpinelinux.org` 仅 14KB/s，阿里云 1.4MB/s。要换官方源：

```bash
docker build --build-arg ALPINE_MIRROR=dl-cdn.alpinelinux.org .
```

## 构建后验收清单

- 容器内 `/health` 200
- `/ready` 报告 9 个平台
- 每平台一条真实链接解析通过
- `bun test` 全绿（216 用例）
- `tsc --noEmit` 零错
