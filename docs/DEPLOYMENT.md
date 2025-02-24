# 部署指南

本文档详细说明了如何部署和运行视频解析服务。

## 环境要求

- Node.js >= 18
- Bun >= 1.0.0
- Docker (可选)

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

5. 运行生产服务器

```bash
bun run start
```

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

3. 查看容器日志

```bash
docker logs -f video-parser
```

## 环境变量说明

必需的环境变量：

- `PORT`: 服务器端口号（开发环境：10010, 生产环境：7777），具体可在环境变量文件查看

## 故障排除

1. 如果遇到 Chromium 启动失败：

```bash
# 检查 Chromium 是否正确安装
docker exec -it video-parser which chromium-browser
```

2. 如果遇到中文显示问题：

```bash
# 确认字体文件是否存在
docker exec -it video-parser ls /usr/share/fonts
```

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

```bash
# 构建并推送到私有仓库
docker build --push --platform linux/amd64 -t docker-registry.itcox.cn/video-parser:latest .

# 拉取镜像
docker pull docker-registry.itcox.cn/video-parser:latest

# 运行容器
docker run -d \
  -p 10010:7777 \
  --name video-parser \
  docker-registry.itcox.cn/video-parser:latest
```

2. 构建多架构支持的镜像

```bash
# 使用 buildx 创建多架构构建器
docker buildx create --use

# 构建并推送多架构镜像
docker buildx build --platform linux/amd64,linux/arm64 \
  -t docker-registry.itcox.cn/video-parser:latest \
  --push .
```
