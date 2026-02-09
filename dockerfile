# 第一阶段：构建阶段
FROM oven/bun:canary-alpine AS builder

WORKDIR /app

# 优化：优先复制依赖文件利用缓存
COPY package.json bun.lockb ./

# 设置环境变量跳过 chromium 下载（构建阶段不需要运行浏览器）
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# 安装依赖
RUN bun install --frozen-lockfile

COPY . .

# 构建单文件可执行程序
# 注意：package.json 中的 build 命令使用了 --compile 选项
RUN bun run build

# 第二阶段：生产镜像
# 使用纯 Alpine 镜像以减小体积（不再需要 oven/bun 基础镜像，因为应用已编译为独立二进制）
FROM alpine:latest

# 安装 Chromium 及其运行所需依赖
# gcompat: 用于支持 Bun 编译出的二进制文件 (glibc compatibility)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    libstdc++ \
    gcompat \
    dumb-init

WORKDIR /app

# 只复制编译后的二进制文件
COPY --from=builder /app/src/entry ./src/entry
# 如果项目中有需要运行时读取的静态文件，也需要在这里复制
# COPY --from=builder /app/public ./public 

# 设置环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PORT=7777

EXPOSE ${PORT}

# 使用 dumb-init 正确处理 PID 1 信号
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# 直接运行二进制文件
CMD ["./src/entry"]
