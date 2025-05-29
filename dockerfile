FROM oven/bun:1.1.21-alpine

# 安装 Node.js 和 Chromium 依赖
RUN apk add --no-cache \
    nodejs \
    chromium \
    chromium-chromedriver \
    fontconfig \
    freetype \
    libstdc++ \
    nss \
    xorg-server \
    xvfb \
    dbus \
    ttf-freefont \
    wget \
    ca-certificates

# Puppeteer 无头浏览器参数建议加上
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 bun.lockb
COPY package.json bun.lockb ./

# 安装依赖
RUN bun install --frozen-lockfile

# 复制源代码
COPY . .

# 安装 PM2
RUN bun add -g pm2

# 创建日志目录
RUN mkdir -p logs

# 设置 Puppeteer 环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 暴露端口
EXPOSE 7777

# 使用 PM2 Runtime 启动应用
CMD ["pm2-runtime", "ecosystem.config.json"]