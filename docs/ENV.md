# 环境变量配置完整指南

nuwax-file-server 支持通过环境变量进行完整的配置管理。本文档详细介绍所有可用的环境变量配置项。

## 配置优先级

配置可以通过以下方式设置，优先级从高到低：

1. **命令行参数**（最高）
2. **系统环境变量**
3. **配置文件**（`.env.production`、`.env.development`、`.env.test`）
4. **默认值**（最低）

## 配置文件

根据 `NODE_ENV` 加载对应的配置文件：

| 环境 | 配置文件 | 说明 |
|------|----------|------|
| development | `env.development` | 开发环境配置 |
| production | `env.production` | 生产环境配置 |
| test | `env.test` | 测试环境配置 |

## 核心配置项

### 服务配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `NODE_ENV` | `development` | 环境模式（development/production/test） |
| `PORT` | `60000` | 服务监听端口 |
| `REQUEST_BODY_LIMIT` | `2000mb` | 请求体大小限制（Express 格式） |

### 日志配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `LOG_BASE_DIR` | - | 日志基础目录 |
| `LOG_LEVEL` | `debug` | 日志级别（error/warn/info/debug） |
| `LOG_CONSOLE_ENABLED` | `true` | 是否启用控制台日志输出 |
| `LOG_PREFIX_API` | `api` | API 日志前缀 |
| `LOG_PREFIX_BUILD` | `build` | 构建日志前缀 |

### 项目路径配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `INIT_PROJECT_NAME` | `react-vite-template` | 系统内置初始化工程名称 |
| `INIT_PROJECT_DIR` | - | 初始化工程目录 |
| `UPLOAD_PROJECT_DIR` | - | 上传的项目压缩包所在路径 |
| `PROJECT_SOURCE_DIR` | - | 项目源文件所在路径 |
| `DIST_TARGET_DIR` | - | 构建产物目标目录（nginx 加载） |
| `COMPUTER_WORKSPACE_DIR` | - | computer 工作目录 |
| `COMPUTER_LOG_DIR` | - | computer 日志目录 |

### 构建配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `MAX_BUILD_CONCURRENCY` | `20` | 最大并发构建数 |
| `DEV_SERVER_PORT_TIMEOUT` | `5000` | 开发服务器端口解析超时（毫秒） |
| `DEV_SERVER_STOP_TIMEOUT` | `5000` | 开发服务器停止超时（毫秒） |
| `DEV_SERVER_STOP_CHECK_INTERVAL` | `100` | 开发服务器停止检查间隔（毫秒） |
| `DEV_SERVER_STOP_MAX_ATTEMPTS` | `50` | 开发服务器停止最大重试次数 |

### 文件上传配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `MAX_INLINE_FILE_SIZE_BYTES` | `1048576` | 单文件大小限制（字节），超过则不返回内容 |
| `UPLOAD_MAX_FILE_SIZE_BYTES` | `1048576000` | 上传压缩包大小限制（字节） |
| `UPLOAD_ALLOWED_EXTENSIONS` | `.zip` | 允许的上传文件扩展名（逗号分隔） |
| `UPLOAD_SINGLE_FILE_SIZE_BYTES` | `1048576000` | 单文件上传大小限制（字节） |

### 目录/文件过滤配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `TRAVERSE_EXCLUDE_DIRS` | `dist,node_modules,.pnpm-store,__MACOSX,.attachments` | 目录遍历排除列表（逗号分隔） |
| `BACKUP_TRAVERSE_EXCLUDE_FILES` | `pnpm-lock.yaml,yarn.lock,package-lock.json` | 归档遍历排除文件（逗号分隔） |
| `CONTENT_TRAVERSE_EXCLUDE_FILES` | `AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json` | 返回项目内容遍历排除文件（逗号分隔） |
| `INLINE_IMAGE_EXTENSIONS` | `.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif` | 允许内联返回的图片扩展名（逗号分隔） |
| `TOP_LEVEL_NOISE_PATTERNS` | `__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments` | 顶层噪声条目（逗号分隔，用于解压后扁平化判断） |

### pnpm 清理配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `PNPM_PRUNE_ENABLED` | `true` | 是否启用 pnpm prune 定时任务 |
| `PNPM_PRUNE_SCHEDULE` | `0 2 * * *` | 定时任务 cron 表达式 |
| `PNPM_PRUNE_TIMEZONE` | `Asia/Shanghai` | 时区 |
| `PNPM_PRUNE_RUN_ON_START` | `false` | 启动时是否立即执行清理 |

**常用 cron 表达式：**

| 表达式 | 说明 |
|--------|------|
| `0 2 * * 0` | 每周日凌晨 2 点 |
| `0 3 * * *` | 每天凌晨 3 点 |
| `0 2 1 * *` | 每月 1 号凌晨 2 点 |
| `0 */6 * * *` | 每 6 小时 |

### 日志缓存配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `LOG_CACHE_ENABLED` | `true` | 是否启用日志缓存 |
| `LOG_CACHE_DURATION` | `180000` | 缓存过期时间（毫秒），默认 3 分钟 |
| `LOG_CACHE_MAX_ENTRIES` | `100` | 最大缓存项目数量 |
| `LOG_CACHE_MAX_FILE_SIZE` | `2097152` | 最大缓存文件大小（字节），默认 2MB |

### CLI 专用配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CLI_PID_DIR` | 临时目录 | CLI PID 文件目录 |
| `CLI_PID_FILE` | `server.pid` | CLI PID 文件名 |
| `CLI_STOP_TIMEOUT` | `30000` | CLI 停止超时时间（毫秒） |
| `CLI_CHECK_INTERVAL` | `500` | CLI 检查进程间隔（毫秒） |
| `CLI_LOG_DIR` | 临时目录 | CLI 日志目录 |

## CLI 专用环境变量

| 环境变量 | 说明 |
|----------|------|
| `CONFIG_FILE` | 指定自定义配置文件路径（CLI 使用） |

## 使用示例

### 场景：使用 production 环境配置并覆盖路径变量

在实际部署中，经常需要使用 production 的环境配置，但覆盖部分路径变量以适应不同的部署环境。以下是常见场景的解决方案：

#### 场景一：使用生产环境但自定义路径

假设生产环境配置文件（`env.production`）中的路径是默认配置，但部署时需要指向实际的目录：

```bash
# 加载 env.production 配置，但覆盖项目路径
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/my-projects \
  DIST_TARGET_DIR=/var/www/my-app \
  UPLOAD_PROJECT_DIR=/data/uploads \
  LOG_BASE_DIR=/var/log/nuwax
```

#### 场景二：多环境部署示例

同一个服务器上部署多个实例，使用不同的目录：

```bash
# 实例 1：主站
nuwax-file-server start \
  --env production \
  --port 60001 \
  PROJECT_SOURCE_DIR=/data/main-site \
  DIST_TARGET_DIR=/var/www/main-site

# 实例 2：测试站
nuwax-file-server start \
  --env production \
  --port 60002 \
  PROJECT_SOURCE_DIR=/data/test-site \
  DIST_TARGET_DIR=/var/www/test-site

# 实例 3：内部站
nuwax-file-server start \
  --env production \
  --port 60003 \
  PROJECT_SOURCE_DIR=/data/internal \
  DIST_TARGET_DIR=/var/www/internal
```

> **说明**：只需指定 `--port` 和需要自定义的路径变量，其他配置将使用 `env.production` 中的默认值。

#### 场景三：通过环境变量文件覆盖

创建一个覆盖配置文件，然后在启动时指定：

```bash
# 创建 env.override 文件（只包含需要覆盖的变量）
cat > env.override << 'EOF'
# 覆盖 production 的路径配置
PROJECT_SOURCE_DIR=/data/override-projects
DIST_TARGET_DIR=/var/www/override-nginx
UPLOAD_PROJECT_DIR=/data/override-uploads
LOG_BASE_DIR=/var/log/override
EOF

# 启动时使用覆盖配置
nuwax-file-server start --env production --env-file ./env.override
```

#### 场景四：Kubernetes ConfigMap 覆盖

在 Kubernetes 中，可以使用 ConfigMap 来覆盖默认配置：

```bash
# 创建 ConfigMap（只包含需要覆盖的路径）
kubectl create configmap nuwax-overrides \
  --from-literal=PROJECT_SOURCE_DIR=/data/k8s-projects \
  --from-literal=DIST_TARGET_DIR=/usr/share/nginx/apps \
  --from-literal=UPLOAD_PROJECT_DIR=/data/k8s-uploads \
  --from-literal=LOG_BASE_DIR=/var/log/nuwax
```

然后在 Deployment 中通过环境变量引用：

```yaml
envFrom:
  - configMapRef:
      name: nuwax-overrides
```

#### 场景五：完整的部署命令示例

以下示例包含 `env.production` 中所有路径相关的环境变量。真实业务场景中可根据需要删减不需要的变量：

```bash
# 生产环境部署
# 使用 env.production 的所有默认值，只覆盖路径配置
nuwax-file-server start \
  --env production \
  --port 60000

# 或自定义所有路径配置
nuwax-file-server start \
  --env production \
  --port 60000 \
  INIT_PROJECT_NAME=react-vite-template \
  INIT_PROJECT_DIR=/app/project_init \
  UPLOAD_PROJECT_DIR=/app/project_zips \
  PROJECT_SOURCE_DIR=/app/project_workspace \
  DIST_TARGET_DIR=/app/project_nginx \
  LOG_BASE_DIR=/app/logs/project_logs \
  COMPUTER_WORKSPACE_DIR=/app/computer-project-workspace \
  COMPUTER_LOG_DIR=/app/logs/computer_logs
```

#### env.production 中所有路径变量

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `INIT_PROJECT_NAME` | `react-vite-template` | 系统内置初始化工程名称 |
| `INIT_PROJECT_DIR` | `/app/project_init` | 初始化工程目录 |
| `UPLOAD_PROJECT_DIR` | `/app/project_zips` | 上传的项目压缩包所在路径 |
| `PROJECT_SOURCE_DIR` | `/app/project_workspace` | 项目源文件所在路径 |
| `DIST_TARGET_DIR` | `/app/project_nginx` | 构建产物目标目录（nginx 加载） |
| `LOG_BASE_DIR` | `/app/logs/project_logs` | 日志基础目录 |
| `COMPUTER_WORKSPACE_DIR` | `/app/computer-project-workspace` | computer 工作目录 |
| `COMPUTER_LOG_DIR` | `/app/logs/computer_logs` | computer 日志目录 |

#### 路径变量使用示例

```bash
# 示例 1：只修改项目源文件目录
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/my-projects

# 示例 2：修改多个路径
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads

# 示例 3：修改所有路径（完整配置）
nuwax-file-server start \
  --env production \
  --port 60000 \
  INIT_PROJECT_NAME=my-template \
  INIT_PROJECT_DIR=/data/init \
  UPLOAD_PROJECT_DIR=/data/zips \
  PROJECT_SOURCE_DIR=/data/workspace \
  DIST_TARGET_DIR=/var/www/nginx \
  LOG_BASE_DIR=/var/logs/project_logs \
  COMPUTER_WORKSPACE_DIR=/data/computer \
  COMPUTER_LOG_DIR=/var/logs/computer
```

> **提示**：`--port` 用于指定服务端口，其他路径变量根据实际需求选择设置。未设置的路径将使用 `env.production` 中的默认值。

#### 验证覆盖配置

启动后可以通过以下命令验证配置是否正确应用：

```bash
# 查看服务状态
nuwax-file-server status

# 检查健康端点
curl http://localhost:60000/health | jq

# 查看实际加载的配置（通过日志）
cat /var/log/nuwax/server.log | grep "已加载环境配置文件"
```

### 命令行参数覆盖

命令行参数优先级高于环境变量：

```bash
# 端口优先级: 命令行 > 环境变量 > 默认值
nuwax-file-server start --port 8080

# 环境优先级: 命令行 > 环境文件 > 系统环境变量
nuwax-file-server start --env production

# 组合使用
nuwax-file-server start --env production --port 8080
```

### 系统环境变量设置

#### Linux/macOS

```bash
# 临时设置
export PORT=8080
export NODE_ENV=production
export LOG_LEVEL=info

# 永久设置（添加到 ~/.bashrc 或 ~/.zshrc）
echo 'export PORT=8080' >> ~/.bashrc
echo 'export NODE_ENV=production' >> ~/.bashrc
source ~/.bashrc
```

#### Windows

```cmd
:: 临时设置
set PORT=8080
set NODE_ENV=production

:: 永久设置（系统属性 -> 环境变量）
setx PORT 8080
setx NODE_ENV production
```

### Docker/容器环境配置

#### docker-compose.yml

```yaml
version: '3.8'

services:
  nuwax-file-server:
    image: nuwax-file-server:latest
    container_name: nuwax-file-server
    restart: unless-stopped
    environment:
      # 服务配置
      - NODE_ENV=production
      - PORT=60000

      # 日志配置
      - LOG_BASE_DIR=/app/logs
      - LOG_LEVEL=info
      - LOG_CONSOLE_ENABLED=false

      # 项目路径配置
      - PROJECT_SOURCE_DIR=/app/projects
      - DIST_TARGET_DIR=/app/nginx
      - UPLOAD_PROJECT_DIR=/app/uploads
      - INIT_PROJECT_DIR=/app/init
      - COMPUTER_WORKSPACE_DIR=/app/computer
      - COMPUTER_LOG_DIR=/app/computer-logs

      # 构建配置
      - MAX_BUILD_CONCURRENCY=20

      # pnpm 清理配置
      - PNPM_PRUNE_ENABLED=true
      - PNPM_PRUNE_SCHEDULE=0 3 * * *
      - PNPM_PRUNE_TIMEZONE=Asia/Shanghai

      # 日志缓存配置
      - LOG_CACHE_ENABLED=true
      - LOG_CACHE_DURATION=180000
      - LOG_CACHE_MAX_ENTRIES=100
      - LOG_CACHE_MAX_FILE_SIZE=2097152

    volumes:
      - ./projects:/app/projects
      - ./logs:/app/logs
      - ./nginx:/app/nginx
      - ./uploads:/app/uploads
      - ./init:/app/init
      - ./computer:/app/computer

    ports:
      - "60000:60000"

    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:60000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

#### Dockerfile

```dockerfile
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# 复制应用代码
COPY . .

# 创建必要目录
RUN mkdir -p /app/logs /app/projects /app/nginx /app/uploads /app/init /app/computer

# 暴露端口
EXPOSE 60000

# 启动命令
CMD ["node", "scripts/start-cli.js"]
```

### 环境变量文件示例

#### .env.production

```bash
# ==================== 服务配置 ====================
NODE_ENV=production
PORT=60000
REQUEST_BODY_LIMIT=2000mb

# ==================== 日志配置 ====================
LOG_BASE_DIR=/app/logs
LOG_LEVEL=info
LOG_CONSOLE_ENABLED=false
LOG_PREFIX_API=api
LOG_PREFIX_BUILD=build

# ==================== 项目路径配置 ====================
INIT_PROJECT_NAME=react-vite-template
INIT_PROJECT_DIR=/app/project_init
UPLOAD_PROJECT_DIR=/app/project_zips
PROJECT_SOURCE_DIR=/app/project_workspace
DIST_TARGET_DIR=/app/project_nginx
COMPUTER_WORKSPACE_DIR=/app/computer-project-workspace
COMPUTER_LOG_DIR=/app/logs/computer_logs

# ==================== 构建配置 ====================
MAX_BUILD_CONCURRENCY=20
DEV_SERVER_PORT_TIMEOUT=5000
DEV_SERVER_STOP_TIMEOUT=5000
DEV_SERVER_STOP_CHECK_INTERVAL=100
DEV_SERVER_STOP_MAX_ATTEMPTS=50

# ==================== 文件上传配置 ====================
MAX_INLINE_FILE_SIZE_BYTES=1048576
UPLOAD_MAX_FILE_SIZE_BYTES=1048576000
UPLOAD_ALLOWED_EXTENSIONS=.zip
UPLOAD_SINGLE_FILE_SIZE_BYTES=1048576000

# ==================== 目录/文件过滤配置 ====================
TRAVERSE_EXCLUDE_DIRS=dist,node_modules,.pnpm-store,__MACOSX,.attachments
BACKUP_TRAVERSE_EXCLUDE_FILES=pnpm-lock.yaml,yarn.lock,package-lock.json
CONTENT_TRAVERSE_EXCLUDE_FILES=AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json
INLINE_IMAGE_EXTENSIONS=.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif
TOP_LEVEL_NOISE_PATTERNS=__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments

# ==================== pnpm 清理配置 ====================
PNPM_PRUNE_ENABLED=true
PNPM_PRUNE_SCHEDULE=0 2 * * *
PNPM_PRUNE_TIMEZONE=Asia/Shanghai
PNPM_PRUNE_RUN_ON_START=false

# ==================== 日志缓存配置 ====================
LOG_CACHE_ENABLED=true
LOG_CACHE_DURATION=180000
LOG_CACHE_MAX_ENTRIES=100
LOG_CACHE_MAX_FILE_SIZE=2097152

# ==================== CLI 专用配置 ====================
CLI_PID_DIR=/tmp/nuwax-file-server
CLI_STOP_TIMEOUT=30000
CLI_CHECK_INTERVAL=500
CLI_LOG_DIR=/tmp/nuwax-file-server/logs
```

#### .env.development

```bash
# ==================== 服务配置 ====================
NODE_ENV=development
PORT=60000
REQUEST_BODY_LIMIT=2000mb

# ==================== 日志配置 ====================
LOG_BASE_DIR=./logs
LOG_LEVEL=debug
LOG_CONSOLE_ENABLED=true
LOG_PREFIX_API=api
LOG_PREFIX_BUILD=build

# ==================== 项目路径配置 ====================
INIT_PROJECT_NAME=react-vite-template
INIT_PROJECT_DIR=./project_init
UPLOAD_PROJECT_DIR=./project_zips
PROJECT_SOURCE_DIR=./project_workspace
DIST_TARGET_DIR=./project_nginx
COMPUTER_WORKSPACE_DIR=./computer-project-workspace
COMPUTER_LOG_DIR=./computer_logs

# ==================== 构建配置 ====================
MAX_BUILD_CONCURRENCY=20
DEV_SERVER_PORT_TIMEOUT=5000
DEV_SERVER_STOP_TIMEOUT=5000
DEV_SERVER_STOP_CHECK_INTERVAL=100
DEV_SERVER_STOP_MAX_ATTEMPTS=50

# ==================== 文件上传配置 ====================
MAX_INLINE_FILE_SIZE_BYTES=1048576
UPLOAD_MAX_FILE_SIZE_BYTES=1048576000
UPLOAD_ALLOWED_EXTENSIONS=.zip
UPLOAD_SINGLE_FILE_SIZE_BYTES=1048576000

# ==================== 目录/文件过滤配置 ====================
TRAVERSE_EXCLUDE_DIRS=dist,node_modules,.pnpm-store,__MACOSX,.attachments
BACKUP_TRAVERSE_EXCLUDE_FILES=pnpm-lock.yaml,yarn.lock,package-lock.json
CONTENT_TRAVERSE_EXCLUDE_FILES=AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json
INLINE_IMAGE_EXTENSIONS=.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif
TOP_LEVEL_NOISE_PATTERNS=__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments

# ==================== pnpm 清理配置 ====================
PNPM_PRUNE_ENABLED=false
PNPM_PRUNE_SCHEDULE=0 2 * * *
PNPM_PRUNE_TIMEZONE=Asia/Shanghai
PNPM_PRUNE_RUN_ON_START=false

# ==================== 日志缓存配置 ====================
LOG_CACHE_ENABLED=true
LOG_CACHE_DURATION=180000
LOG_CACHE_MAX_ENTRIES=100
LOG_CACHE_MAX_FILE_SIZE=2097152

# ==================== CLI 专用配置 ====================
CLI_PID_DIR=./tmp
CLI_STOP_TIMEOUT=30000
CLI_CHECK_INTERVAL=500
CLI_LOG_DIR=./tmp/logs
```

### Kubernetes 配置示例

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: nuwax-file-server-config
data:
  NODE_ENV: "production"
  PORT: "60000"
  LOG_BASE_DIR: "/app/logs"
  LOG_LEVEL: "info"
  LOG_CONSOLE_ENABLED: "false"
  PROJECT_SOURCE_DIR: "/app/projects"
  DIST_TARGET_DIR: "/app/nginx"
  UPLOAD_PROJECT_DIR: "/app/uploads"
  INIT_PROJECT_DIR: "/app/init"
  COMPUTER_WORKSPACE_DIR: "/app/computer"
  COMPUTER_LOG_DIR: "/app/computer-logs"
  MAX_BUILD_CONCURRENCY: "20"
  PNPM_PRUNE_ENABLED: "true"
  PNPM_PRUNE_SCHEDULE: "0 3 * * *"
  PNPM_PRUNE_TIMEZONE: "Asia/Shanghai"
  LOG_CACHE_ENABLED: "true"
  LOG_CACHE_DURATION: "180000"
  LOG_CACHE_MAX_ENTRIES: "100"
  LOG_CACHE_MAX_FILE_SIZE: "2097152"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nuwax-file-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: nuwax-file-server
  template:
    metadata:
      labels:
        app: nuwax-file-server
    spec:
      containers:
      - name: nuwax-file-server
        image: nuwax-file-server:latest
        ports:
        - containerPort: 60000
        envFrom:
        - configMapRef:
            name: nuwax-file-server-config
        volumeMounts:
        - name: projects
          mountPath: /app/projects
        - name: logs
          mountPath: /app/logs
        - name: nginx
          mountPath: /app/nginx
        - name: uploads
          mountPath: /app/uploads
        - name: init
          mountPath: /app/init
        - name: computer
          mountPath: /app/computer
        livenessProbe:
          httpGet:
            path: /health
            port: 60000
          initialDelaySeconds: 10
          periodSeconds: 30
        readinessProbe:
          httpGet:
            path: /health
            port: 60000
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes:
      - name: projects
        hostPath:
          path: /data/projects
      - name: logs
        hostPath:
          path: /data/logs
      - name: nginx
        hostPath:
          path: /data/nginx
      - name: uploads
        hostPath:
          path: /data/uploads
      - name: init
        hostPath:
          path: /data/init
      - name: computer
        hostPath:
          path: /data/computer
```

## 验证配置

启动服务后，可以通过健康检查端点验证配置是否正确生效：

```bash
curl http://localhost:60000/health
```

响应中将包含当前环境配置信息：

```json
{
  "status": "ok",
  "timestamp": 1738600000000,
  "uptime": 3600,
  "version": "1.0.0",
  "platform": "darwin",
  "nodeVersion": "v20.0.0",
  "pid": 12345,
  "memory": {
    "heapUsed": 25.5,
    "heapTotal": 50.0,
    "rss": 100.0,
    "external": 5.0
  },
  "env": "production"
}
```

## 故障排除

### 配置未生效

1. 检查配置文件路径是否正确
2. 确认环境变量名称拼写正确（大小写敏感）
3. 验证配置文件语法（JSON/YAML 格式）
4. 查看服务日志中的配置加载信息

### 端口冲突

如果 `PORT` 配置的端口已被占用，服务将启动失败。请使用其他端口或停止占用端口的进程。

### 路径权限问题

确保日志目录、配置目录有写入权限：

```bash
# Linux/macOS
chmod -R 755 /path/to/logs

# 创建目录
mkdir -p /path/to/logs /path/to/projects
```

### Docker 环境变量读取问题

在 Docker 中，确保使用 `environment` 或 `envFrom` 正确传递环境变量：

```yaml
environment:
  - NODE_ENV=production
  - PORT=60000

# 或使用 envFrom
envFrom:
  - configMapRef:
      name: my-config
```

## 相关文档

- [README.md](../README.md) - 主文档
- [PNPM_CHECK.md](./PNPM_CHECK.md) - pnpm 磁盘空间优化
