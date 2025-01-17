# 使用官方的Bun镜像
FROM oven/bun:latest as base

# 设置工作目录
WORKDIR /usr/src/app

# 将本地项目文件复制到工作目录
COPY . .

# 安装项目依赖
RUN bun install

# 运行Bun应用
CMD ["bun", "run", "start"]

# 使用 sleep 命令保持容器运行
# CMD ["sleep", "infinity"]