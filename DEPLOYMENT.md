# 部署指南

本文档详细说明了如何部署和运行视频解析服务。

## 环境要求

- Node.js >= 18
- Bun >= 1.0.0
- Docker (可选)

## 本地开发部署

1. 克隆项目

```bash
git clone <repository-url>
cd video-parser
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
  -p 3000:3000 \
  --name video-parser \
  video-parser
```

3. 查看容器日志

```bash
docker logs -f video-parser
```

## 环境变量说明

必需的环境变量：

- `PORT`: 服务器端口号（默认：3000）
- `NODE_ENV`: 环境模式 (development/production)

## 注意事项

1. Puppeteer 相关

- Docker 环境中使用了 Alpine 的 Chromium
- 已配置所需的中文字体和依赖
- 无需额外安装 Chromium

2. 性能优化

- 建议使用 PM2 或类似工具进行进程管理
- 可配置 Nginx 进行反向代理

3. 安全建议

- 建议配置请求频率限制
- 建议启用 CORS 保护
- 生产环境需配置 SSL 证书

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
docker run -d -p 3000:3000 --name video-parser video-parser:latest
```
