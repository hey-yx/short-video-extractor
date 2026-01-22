# 第一阶段：构建阶段
FROM oven/bun:canary-alpine AS builder

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
# 先删除旧的构建产物
RUN rm -rf ./src/entry && bun run build

# 第二阶段：生产镜像
FROM oven/bun:canary-alpine

RUN apk add --no-cache \
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

WORKDIR /app

# 只复制构建产物和依赖
COPY --from=builder /app/package.json /app/bun.lockb ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src/entry ./src/entry
COPY --from=builder /app/ecosystem.config.json ./

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PORT=7777

# 用环境变量控制端口暴露
EXPOSE ${PORT}

CMD ["bun", "run", "start"]