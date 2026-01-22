# 部署指南

本文档详细说明了如何部署和运行视频解析服务。

## 技术栈

- 运行时：Bun 1.1.21
- 包管理：Bun
- 进程管理：PM2
- 浏览器自动化：Puppeteer
- 容器化：Docker

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

- `PORT`：服务监听端口（开发环境建议 10010，生产环境建议 7777）
- `PUPPETEER_EXECUTABLE_PATH`：指定 Puppeteer 启动时所用 Chromium/Chrome 浏览器的绝对路径，建议在 Docker 或服务器环境下设置为 `/usr/bin/chromium-browser`，否则 Puppeteer 可能无法正常启动。

## 常用脚本说明

- `bun run dev`：开发环境启动服务，自动加载 .env.development 环境变量。
- `bun run build-local`：本地开发环境编译打包。
- `bun run build`：生产环境编译打包，生成 Linux ARM64 可执行文件。
- `bun run start`：直接运行编译后的入口文件。
- `bun run format`：使用 Prettier 格式化全部代码。
- `bun run encrypt-dev` / `bun run encrypt-prod`：加密开发/生产环境变量文件。
- `bun run decrypt-dev` / `bun run decrypt-prod`：解密开发/生产环境变量文件。
- `bun run dotenvx-help`：显示 dotenvx 版本及帮助信息。
- `bun run pm2:dev`：用 PM2 启动开发环境。
- `bun run pm2:start`：用 PM2 启动生产环境。
- `bun run pm2:stop` / `bun run pm2:restart` / `bun run pm2:logs` / `bun run pm2:status`：PM2 进程管理相关命令。

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
