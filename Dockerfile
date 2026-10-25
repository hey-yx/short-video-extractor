# syntax=docker/dockerfile:1.7
# 多阶段：oven/bun 构建单二进制 → alpine + chromium 运行（小红书通道需要真实浏览器）
# 体积实测见 README「镜像体积」；服务器磁盘仅剩 5.5G，勿加多余层
ARG BUN_VERSION=1.3.10

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) TARGET=bun-linux-arm64-musl ;; \
      amd64) TARGET=bun-linux-x64-musl ;; \
      *) echo "unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac \
 && bun build ./src/index.ts --compile --minify --target="$TARGET" --outfile ./out/server

FROM alpine:3.22
# chromium 自带 nss/freetype/harfbuzz/fontconfig，只需补证书和 init
RUN apk add --no-cache chromium ca-certificates tini \
 && addgroup -S app && adduser -S -G app -u 10001 app
ENV NODE_ENV=production \
    PORT=7777 \
    HOME=/home/app \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
COPY --from=builder --chown=app:app /app/out/server /app/server
USER app
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/server"]
