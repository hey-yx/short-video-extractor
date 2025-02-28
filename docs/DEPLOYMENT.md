# 部署指南

本文档详细说明了如何部署和运行视频解析服务。

## 环境要求

- Node.js >= 18
- Bun >= 1.0.0
- Docker (可选，用于生产环境)

## 本地开发部署

1. 克隆项目

```bash
git clone git@github.com:yassine-zhang/short-video-extractor.git
cd short-video-extractor
```

2. 安装依赖

```bash
bun install
```

3. 配置环境变量

```bash
# 编辑环境变量
vim .env.development
vim .env.production
```

4. 运行开发服务器

```bash
bun run dev
```

## 跨域配置

如果你需要在网站上对接部署的解析服务，需要先配置网站跨域地址，打开 `src/bootstrap/app.ts` 文件，修改 `ClientAddrs` 数组，添加你的网站地址，例如：

```ts
const ClientAddrs = [
  "http://localhost:5173",
  "https://v0.dev/chat/short-video-extractor-z2fVaJntkAp",
  /^https:\/\/.*\.itcox\.cn$/,
  "https://your-website.com",
];
```

## 配置 Docker 镜像源

请参考 [DOCKER_MIRROR.md](./DOCKER_MIRROR.md)

前提是您要在设备上事先安装 Docker

## Docker 部署

1. 构建 Docker 镜像

```bash
docker build -t video-parser .
```

2. 运行容器

```bash
docker run -d \
  -p 10010:7777 \
  --name video-parser \
  video-parser
```

## 环境变量说明

必需的环境变量：

- `PORT`: 服务器端口号（开发环境：10010, 生产环境：7777），具体可在环境变量文件查看

## 更新维护

1. 更新代码

```bash
git pull
bun install
```

2. 更新 Docker 镜像

```bash
docker build -t video-parser:latest .
docker stop video-parser
docker rm video-parser
docker run -d -p 10010:7777 --name video-parser video-parser:latest
```

## 构建特定架构的 Docker 镜像

在某些情况下，您可能需要为特定的 CPU 架构构建 Docker 镜像。以下是一些常见场景：

1. 构建 linux/amd64 架构的镜像并推送到私有仓库

注意：example-registry.com 是一个自建的私有仓库，这里只做示例，请替换为实际的私有仓库地址

```bash
# 构建并推送到私有仓库
docker build --push --platform linux/amd64 -t example-registry.com/video-parser:latest .

# 拉取镜像
docker pull example-registry.com/video-parser:latest

# 运行容器
docker run -d \
  -p 10010:7777 \
  --name video-parser \
  example-registry.com/video-parser:latest
```

2. 构建多架构支持的镜像

```bash
# 使用 buildx 创建多架构构建器
docker buildx create --use

# 构建并推送多架构镜像
docker buildx build --platform linux/amd64,linux/arm64 \
  -t example-registry.com/video-parser:latest \
  --push .
```
