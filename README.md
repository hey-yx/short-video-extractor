# typescript-elysia-prisma-starter

这是一个基于 Bun + Elysia + Prisma 的后端项目框架。

## 主要目录结构

```markdown
.
├── src/ # 源代码目录
│ ├── bootstrap/ # 启动相关配置
│ ├── controllers/ # 控制器层
│ ├── emails/ # 邮件模板
│ ├── hooks/ # 中间件钩子
│ ├── models/ # 数据模型定义
│ ├── routes/ # 路由定义
│ ├── types/ # TypeScript 类型定义
│ └── utils/ # 工具函数
├── prisma/ # Prisma ORM 相关
└── public/ # 静态资源目录
```

## 核心功能模块

1. **认证系统**

- JWT 认证实现 (`@elysiajs/jwt`)
- 路由白名单机制 (`auth-whitelist.ts`)
- 验证码功能:
  - 图形验证码 (`captcha.ts`)
  - 邮箱验证码 (`emailCaptcha.ts`)

2. **数据库集成**

- 使用 Prisma ORM
- PostgreSQL 数据库支持
- 自动时区设置为上海时区

3. **邮件系统**

- 基于 ZeptoMail 的邮件发送
- HTML 邮件模板支持
- 验证码邮件功能

4. **API 路由**

- RESTful API 设计
- 路由前缀管理
- 统一的错误处理

5. **开发工具链**

- Prettier 代码格式化
- Husky Git hooks
- dotenvx 环境变量管理
- TypeScript 支持

## 特色功能

1. **环境变量管理**

- 支持开发和生产环境配置
- 环境变量加密功能
- dotenvx 集成

2. **定时任务**

- 使用 `@elysiajs/cron` 实现
- 验证码清理等维护任务

3. **Docker 支持**

- 完整的 Dockerfile 配置
- 多平台构建支持

4. **统一响应格式**

```typescript
interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  errorCode?: number;
}
```

## 技术栈亮点

1. **现代化运行时**

- 使用 Bun 作为 JavaScript/TypeScript 运行时
- 高性能特性

2. **类型安全**

- 完整的 TypeScript 支持
- 自定义类型定义

3. **开发体验**

- 热重载支持
- 完整的开发工具链
- 统一的代码风格

4. **安全性**

- JWT 认证
- 验证码机制
- 环境变量加密

这是一个结构完善的后端项目框架，适合作为中小型项目的起点。它提供了常见的基础设施和最佳实践，同时保持了良好的可扩展性。

## 使用说明

### 安装依赖

> 本项目使用 bun v1.1.21 通过 `bun init` 创建。[Bun](https://bun.sh) 是一个快速的全能 JavaScript 运行时。

```bash
bun install
```

### 环境变量

项目采用dotenvx管理环境变量，你在拉取此项目后，请先修改`.env.development`和`.env.production`文件，添加你的环境变量。

1. DATABASE_URL： 数据库连接字符串，请根据你的数据库类型，修改此字符串，他在`prisma/schema.prisma`中被引用。
2. SERVER_PORT： 服务端口，请根据你的需要，修改此端口。
3. EMAIL：发送功能依赖于ZeptoMail，请先在ZeptoMail注册账号，并添加你的API Token以及其他信息。你也可以移除此模块，使用你自己的邮件发送服务，文件位置：`src/utils/email-sender.ts`。

### 加密和解密说明

注意：请不要将环境变量以明文的形式上传到公开仓库，你可使用`bun run encrypt-dev/encrypt-prod`命令，加密`.env.development/.env.production`文件。

另外，请不要将生成的`.env.keys`文件上传到公开仓库，此文件包含你的加密私钥，请妥善保管。

[dotenvx文档](https://dotenvx.com/)

### Git 提交代码格式化

运行以下命令安装husky

```bash
bun run prepare-fallback
```

### Prisma 配置

请先在`prisma/schema.prisma`中创建model，如下：

```prisma
model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
```

现在你还要留意环境变量`DATABASE_URL`，他需要配置你的数据库连接字符串，请根据你的数据库类型，修改此字符串。

当你每次配置完`schema.prisma`，都要运行命令`bun run migrate-[dev/depl]`，一个是开发环境一个是生产环境。在运行后他会自动执行`bun run generate`这样就可以通过@prisma/client获取到类型提示信息。

> 关于binaryTargets的更多信息，请参考[Prisma文档](https://www.prisma.io/docs/orm/overview/prisma-schema-file-structure/prisma-schema-file-structure#binarytargets)。

### 运行项目

```bash
bun run dev
```

### 构建 Docker 镜像

构建Docker镜像：

```bash
docker buildx build --push --platform linux/amd64 -t domain/project-name:latest .
```

运行镜像：

```bash
docker run -d -e DOTENV_PRIVATE_KEY_PRODUCTION="***" -v volume-name:/usr/src/app/media --restart unless-stopped --privileged -p 10010:7777 --name image-name  domain/project-name:latest
```
