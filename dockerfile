FROM oven/bun:1.1.21-alpine

# 安装所有必需的依赖
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver \
    ca-certificates

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY . .

# 安装依赖
RUN bun install

# 设置 Puppeteer 环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 暴露端口
EXPOSE 7777

ENTRYPOINT [ "bun", "run", "start" ]