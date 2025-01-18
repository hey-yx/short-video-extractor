FROM alpine:3.19

# 安装所有必需的依赖
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    nodejs \
    curl \
    bash \
    libstdc++ \
    libgcc

# 安装 bun
RUN curl -fsSL https://bun.sh/install | SHELL=/bin/bash bash
ENV PATH="/root/.bun/bin:${PATH}"

# 安装 PM2
RUN bun add -g pm2

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY . .

# 安装依赖
RUN bun install --production

# 设置 Puppeteer 环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 暴露端口
EXPOSE 7777

# 使用 PM2 启动应用
CMD ["bunx", "dotenvx", "run", "-f", ".env.production", "--", "pm2-runtime", "start", "--interpreter", "bun", "./src/index.ts"]
