# Docker镜像源配置指南

本文档提供了在不同操作系统和环境下配置Docker镜像源的详细说明，以加速Docker镜像的拉取过程。

## 推荐的镜像源

我们推荐使用以下镜像源：

- dockerpull.cn

可用镜像地址列表：https://www.coderjia.cn/archives/dba3f94c-a021-468a-8ac6-e840f85867ea

## 配置方法

### Linux系统

#### Ubuntu/Debian

1. 创建或编辑Docker配置文件：

```bash
sudo mkdir -p /etc/docker
sudo nano /etc/docker/daemon.json
```

2. 添加以下内容：

```json
{
  "registry-mirrors": ["https://dockerpull.cn"]
}
```

3. 重启Docker服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

#### CentOS/RHEL

1. 创建或编辑Docker配置文件：

```bash
sudo mkdir -p /etc/docker
sudo vi /etc/docker/daemon.json
```

2. 添加以下内容：

```json
{
  "registry-mirrors": ["https://dockerpull.cn"]
}
```

3. 重启Docker服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

### macOS系统

1. 点击桌面顶部菜单栏中的Docker图标
2. 选择"Preferences"（或"Settings"）
3. 点击"Docker Engine"选项卡
4. 在配置JSON中添加或修改"registry-mirrors"字段：

```json
{
  "registry-mirrors": ["https://dockerpull.cn"]
}
```

5. 点击"Apply & Restart"按钮应用更改

### Windows系统

1. 右键点击系统托盘中的Docker图标
2. 选择"Settings"
3. 点击"Docker Engine"选项
4. 在配置JSON中添加或修改"registry-mirrors"字段：

```json
{
  "registry-mirrors": ["https://dockerpull.cn"]
}
```

5. 点击"Apply & Restart"按钮应用更改

### 在Dockerfile中使用镜像源

在Dockerfile中，您可以通过修改FROM指令来使用镜像源：

```dockerfile
# 原始写法
# FROM node:18-alpine

# 使用镜像源
FROM docker.1panel.live/library/node:18-alpine
```

### 在Docker Compose中配置镜像源

在`docker-compose.yml`文件中，您可以为每个服务指定镜像源：

```yaml
services:
  app:
    image: docker.1panel.live/library/node:18-alpine
    # 其他配置...
```

## 本项目Dockerfile示例

以下是本项目Dockerfile使用镜像源的示例：

```dockerfile
# 原始写法
# FROM oven/bun:1-alpine

# 使用镜像源
FROM docker.1panel.live/oven/bun:1-alpine

# 安装所有必需的依赖
RUN apk add --no-cache \
    chromium \
    chromium-chromedriver

# 设置工作目录
WORKDIR /app

# 复制项目文件
COPY . .

# 安装依赖
RUN bun install

# 安装 PM2
RUN bun add -g pm2

# 设置 Puppeteer 环境变量
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 使用 PM2 启动应用
CMD ["bunx", "dotenvx", "run", "-f", ".env.production", "--", "pm2-runtime", "start", "--interpreter", "bun", "./src/index.ts"]
```

### 使用镜像源加速apk安装

在Alpine Linux中，您还可以配置apk包管理器使用国内镜像源加速依赖安装：

```dockerfile
# 使用镜像源
FROM docker.1panel.live/oven/bun:1-alpine

# 配置Alpine镜像源并安装依赖
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
    && apk add --no-cache \
    chromium \
    chromium-chromedriver

# 其余配置保持不变
# ...
```

## 在CI/CD环境中配置Docker镜像源

在自动化构建和部署流程中，配置Docker镜像源可以显著提高构建速度和稳定性。

### GitHub Actions

在GitHub Actions工作流中配置Docker镜像源：

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
        with:
          driver-opts: |
            registry-mirrors=https://dockerpull.cn

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          push: true
          tags: your-image:latest
```

### GitLab CI/CD

在GitLab CI/CD配置文件`.gitlab-ci.yml`中：

```yaml
build:
  stage: build
  image: docker:20.10.16
  services:
    - name: docker:20.10.16-dind
      command: ["--registry-mirror=https://dockerpull.cn"]
  script:
    - docker build -t your-image:latest .
    - docker push your-image:latest
```

### Jenkins

在Jenkins Pipeline中配置Docker镜像源：

```groovy
pipeline {
    agent any

    stages {
        stage('Build') {
            steps {
                sh '''
                mkdir -p /etc/docker
                echo '{"registry-mirrors": ["https://dockerpull.cn"]}' > /etc/docker/daemon.json
                systemctl restart docker
                docker build -t your-image:latest .
                '''
            }
        }
    }
}
```

## 在Kubernetes环境中配置镜像源

在Kubernetes集群中，您可以通过以下方式配置Docker镜像源。

### 配置节点级别的镜像源

对于每个Kubernetes节点，您需要配置Docker守护进程使用镜像源：

1. 在每个节点上创建或编辑Docker配置文件：

```bash
sudo mkdir -p /etc/docker
sudo nano /etc/docker/daemon.json
```

2. 添加镜像源配置：

```json
{
  "registry-mirrors": ["https://dockerpull.cn"]
}
```

3. 重启Docker服务：

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

4. 如果使用kubeadm部署的集群，可能需要重启kubelet：

```bash
sudo systemctl restart kubelet
```

### 使用镜像拉取密钥

如果您的镜像源需要认证，可以创建Kubernetes镜像拉取密钥：

```bash
kubectl create secret docker-registry mirror-secret \
  --docker-server=docker.1panel.live \
  --docker-username=your-username \
  --docker-password=your-password
```

然后在Pod或Deployment中引用该密钥：

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
spec:
  containers:
    - name: app
      image: dockerpull.cn/library/nginx:latest
  imagePullSecrets:
    - name: mirror-secret
```

### 使用containerd作为容器运行时

如果您的Kubernetes集群使用containerd作为容器运行时，配置方式略有不同：

1. 编辑containerd配置文件：

```bash
sudo nano /etc/containerd/config.toml
```

2. 添加或修改镜像源配置：

```toml
[plugins."io.containerd.grpc.v1.cri".registry.mirrors]
  [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"]
    endpoint = ["https://dockerpull.cn"]
```

3. 重启containerd服务：

```bash
sudo systemctl restart containerd
```

### 使用Helm Chart部署应用时指定镜像源

在使用Helm部署应用时，可以在values.yaml中指定使用镜像源：

```yaml
image:
  repository: dockerpull.cn/library/nginx
  tag: latest
```

## 多架构支持

在不同硬件架构上配置Docker镜像源时，需要注意一些特殊情况。

### ARM架构（如树莓派、Apple Silicon）

对于ARM架构的设备，配置方法与x86架构基本相同，但需要确保使用的镜像源支持ARM架构的镜像。

#### 在ARM设备上的Dockerfile示例

```dockerfile
# 使用支持ARM的基础镜像
FROM dockerpull.cn/arm64v8/alpine:latest

# 或者使用多架构支持的镜像
FROM dockerpull.cn/library/node:18-alpine

# 其余配置...
```

#### 在Apple Silicon (M1/M2) Mac上的注意事项

在Apple Silicon Mac上，Docker Desktop默认启用了Rosetta 2兼容层，可以运行x86架构的容器。如果您想使用原生ARM64容器，可以在Dockerfile中明确指定：

```dockerfile
FROM --platform=linux/arm64 dockerpull.cn/oven/bun:1-alpine
```

### 多架构构建

如果您需要为不同架构构建Docker镜像，可以使用Docker Buildx：

```bash
# 设置Buildx构建器
docker buildx create --name mybuilder --use

# 构建并推送多架构镜像
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag your-image:latest \
  --push .
```

在CI/CD环境中的多架构构建示例（GitHub Actions）：

```yaml
name: Build Multi-Arch Image

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2
        with:
          driver-opts: |
            registry-mirrors=https://dockerpull.cn

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: your-image:latest
```

## 验证配置

配置完成后，可以通过以下命令验证镜像源是否生效：

```bash
docker info
```

在输出中查找"Registry Mirrors"部分，应该能看到您配置的镜像源地址。

## 故障排除

如果遇到镜像拉取问题，请尝试以下步骤：

1. 确保网络连接正常
2. 检查镜像源地址是否正确
3. 尝试重启Docker服务
4. 检查Docker日志以获取更多信息：
   ```bash
   sudo journalctl -u docker.service
   ```

## 注意事项

- 不同的镜像源可能有不同的同步策略和延迟
- 建议配置多个镜像源作为备用
- 某些私有镜像可能无法通过镜像源访问，需要直接从原始源拉取
- 在生产环境中使用镜像源前，请先在测试环境验证其稳定性和可靠性

## 总结

配置Docker镜像源是提高Docker镜像拉取速度和稳定性的有效方法，特别是在网络条件不佳的环境中。本文档提供了在各种环境下配置Docker镜像源的详细指南，包括：

- 不同操作系统（Linux、macOS、Windows）的配置方法
- 在Dockerfile和Docker Compose中使用镜像源
- 在CI/CD环境（GitHub Actions、GitLab CI/CD、Jenkins）中配置镜像源
- 在Kubernetes环境中配置镜像源
- 多架构（ARM、x86）支持的配置方法

通过正确配置Docker镜像源，您可以：

- 加快镜像拉取速度，减少等待时间
- 提高构建和部署的稳定性
- 降低网络带宽消耗
- 减少因网络问题导致的构建失败

请根据您的具体环境和需求，选择适合的配置方法，并定期检查镜像源的可用性和性能。
