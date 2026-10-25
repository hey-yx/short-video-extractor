# syntax=docker/dockerfile:1.7
# 多阶段：oven/bun 构建单二进制 → alpine + chromium 运行（小红书通道需要真实浏览器）
# 体积实测见 README「部署 · 镜像」；镜像体积敏感，勿加多余层
ARG BUN_VERSION=1.3.10

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
# 检测站页面在 status.routes.ts 里以 text import 内嵌进二进制，构建期必须在场
COPY docs/status.html ./docs/status.html

ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) TARGET=bun-linux-arm64-musl ;; \
      amd64) TARGET=bun-linux-x64-musl ;; \
      *) echo "unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac \
 && bun build ./src/index.ts --compile --minify --target="$TARGET" --outfile ./out/server

FROM alpine:3.22
# chromium 自带 nss/freetype/harfbuzz/fontconfig，只需补证书和 init。
# 无头解析用不到的部分同层删掉（不进镜像）：mesa/LLVM 软渲染栈（chromium NEEDED 闭包不含，
# 仅 libgbm 运行期 dlopen）、系统 ICU（chromium 内置）、ANGLE/SwiftShader、locales、图标主题、
# mime/pci 等数据。逐项删除后容器内实测小红书浏览器通道解析仍成功（video+album）。
# apk 走国内镜像（dl-cdn 实测 14KB/s，构建 --build-arg ALPINE_MIRROR= 可换回官方源）
ARG ALPINE_MIRROR=mirrors.aliyun.com
RUN sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories \
 && apk add --no-cache chromium ca-certificates tini \
 && rm -rf \
      /usr/lib/libLLVM* /usr/lib/libgallium* /usr/lib/gallium-pipe \
      /usr/lib/libSPIRV-Tools.so* /usr/lib/dri \
      /usr/share/icu /usr/lib/libicu*.so* \
      /usr/share/misc/magic.mgc /usr/lib/libmagic.so* \
      /usr/share/mime /usr/share/X11 /usr/share/icons /usr/share/themes \
      /usr/lib/gtk-3.0 /usr/lib/gdk-pixbuf-2.0 \
      /usr/lib/girepository-1.0 /usr/share/hwdata \
      /usr/lib/pipewire-0.3 /usr/lib/spa-0.2 \
      /usr/share/xml /usr/share/udhcpc /usr/share/thumbnailers \
      /usr/share/metainfo /usr/share/pkgconfig /usr/share/gtk-doc \
      /usr/lib/chromium/libEGL.so /usr/lib/chromium/libGLESv2.so \
      /usr/lib/chromium/libvulkan.so.1 /usr/lib/chromium/chrome_200_percent.pak \
 && find /usr/lib/chromium/locales -type f ! -name 'en-US.pak' ! -name 'zh-CN.pak' -delete \
 && find /usr/share/fonts/opensans -type f ! -name 'OpenSans-Regular.ttf' -delete \
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
