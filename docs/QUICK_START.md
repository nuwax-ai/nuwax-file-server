# 快速开始指南

本指南将帮助你快速上手使用 nuwax-file-server CLI 工具。

## 1. 本地测试

在项目根目录执行以下命令：

```bash
# 安装依赖
pnpm install

# 启动服务（开发环境）
pnpm run cli:start:dev

# 查看服务状态
pnpm run cli:status

# 测试健康检查
curl http://localhost:60000/health

# 停止服务
pnpm run cli:stop
```

## 2. 全局安装使用

```bash
# 全局安装
npm install -g .

# 或
pnpm add -g .

# 然后在任何目录使用
nuwax-file-server start --env development
nuwax-file-server status
nuwax-file-server stop
```

## 3. 命令说明

| 命令                                | 说明                     |
| ----------------------------------- | ------------------------ |
| `nuwax-file-server start`           | 启动服务（默认生产环境） |
| `nuwax-file-server start --env dev` | 启动服务（开发环境）     |
| `nuwax-file-server stop`            | 停止服务                 |
| `nuwax-file-server restart`         | 重启服务                 |
| `nuwax-file-server status`          | 查看服务状态             |
| `nuwax-file-server --help`          | 查看帮助                 |

## 4. 健康检查

```bash
curl http://localhost:60000/health
```

### 响应示例

```json
{
  "status": "ok",
  "timestamp": 1738600000000,
  "uptime": 3600,
  "version": "1.0.0",
  "platform": "darwin",
  "nodeVersion": "v22.0.0",
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

## 5. 环境变量配置

### 使用默认配置

```bash
# 使用 env.production 的所有默认值
nuwax-file-server start --env production --port 60000
```

### 自定义路径配置

```bash
# 根据实际需求覆盖路径变量
nuwax-file-server start --env production --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads
```

详细配置说明请参考：[环境变量配置文档](./ENV.md)

## 6. 常见问题

### 服务无法启动

检查端口是否被占用：

```bash
# 查看端口占用
lsof -i :60000

# 或使用 netstat
netstat -tlnp | grep 60000
```

### 服务停止失败

使用强制停止：

```bash
nuwax-file-server stop --force
```

### 查看服务日志

```bash
# 查看服务状态
nuwax-file-server status

# 查看健康端点
curl http://localhost:60000/health
```

## 7. Docker 部署

```yaml
# docker-compose.yml
version: "3.8"

services:
  nuwax-file-server:
    image: nuwax-file-server:latest
    container_name: nuwax-file-server
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=60000
      - PROJECT_SOURCE_DIR=/app/projects
      - DIST_TARGET_DIR=/var/www/html
      - UPLOAD_PROJECT_DIR=/app/uploads
      - LOG_BASE_DIR=/app/logs
    volumes:
      - ./projects:/app/projects
      - ./logs:/app/logs
    ports:
      - "60000:60000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:60000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## 8. 测试脚本

项目提供了多种测试脚本来验证 CLI 功能。

### 8.1 运行所有测试

```bash
# 运行所有测试
pnpm run test:run

# 运行单元测试
pnpm run test:unit

# 运行集成测试
pnpm run test:integration
```

### 8.2 CLI 单元测试

```bash
# 运行 CLI 专用测试
npx jest tests/unit/cli.test.js

# 或使用 npm script
pnpm run test:unit -- --testPathPattern=cli.test.js
```

**CLI 测试覆盖范围：**

| 测试组            | 内容                                   |
| ----------------- | -------------------------------------- |
| Service Manager   | PID 文件、进程状态、服务状态           |
| Environment Utils | 环境变量获取、类型转换、命令行参数解析 |
| Cross-Platform    | 平台检测、路径处理                     |
| Config            | CLI 专用配置验证                       |

### 8.3 手动测试脚本

#### 开发环境测试

```bash
# 1. 启动开发环境服务
pnpm run cli:start:dev

# 2. 检查服务状态
pnpm run cli:status

# 3. 测试健康检查
curl http://localhost:60000/health

# 4. 停止服务
pnpm run cli:stop
```

#### 生产环境测试

```bash
# 1. 启动生产环境服务
pnpm run cli:start:prod

# 2. 检查服务状态
pnpm run cli:status

# 3. 测试健康检查
curl http://localhost:60000/health

# 4. 重启服务
pnpm run cli:restart

# 5. 停止服务
pnpm run cli:stop
```

#### 自定义配置测试

```bash
# 使用自定义端口启动
nuwax-file-server start --env development --port 60001

# 使用自定义路径配置启动
nuwax-file-server start --env development --port 60002 \
  PROJECT_SOURCE_DIR=/data/test-projects \
  DIST_TARGET_DIR=/var/www/test-nginx

# 检查状态
nuwax-file-server status

# 停止
nuwax-file-server stop
```

### 8.4 测试健康检查端点

```bash
# 基础健康检查
curl http://localhost:60000/health

# 格式化输出（需要 jq）
curl http://localhost:60000/health | jq

# 检查特定字段
curl http://localhost:60000/health | jq '.status'
curl http://localhost:60000/health | jq '.uptime'
curl http://localhost:60000/health | jq '.memory'
```

### 8.5 跨平台测试

#### macOS/Linux

```bash
# 启动服务
nuwax-file-server start --env production

# 查看进程
ps aux | grep nuwax-file-server

# 停止服务
nuwax-file-server stop
```

#### Windows

```cmd
:: 启动服务
nuwax-file-server start --env production

:: 查看进程
tasklist | findstr nuwax-file-server

:: 停止服务
nuwax-file-server stop --force
```

### 8.6 自动化测试脚本

创建一个测试脚本 `test-cli.sh`：

```bash
#!/bin/bash

# nuwax-file-server CLI 自动化测试脚本

set -e

echo "=== nuwax-file-server CLI 测试 ==="

# 配置
PORT=60000
HEALTH_URL="http://localhost:${PORT}/health"

# 测试函数
test_command() {
    local cmd=$1
    local description=$2
    echo "测试: ${description}"
    echo "命令: ${cmd}"
    eval "${cmd}"
    echo "✓ 完成"
    echo ""
}

# 停止可能运行的服务
echo "清理环境..."
nuwax-file-server stop 2>/dev/null || true
sleep 1

# 启动服务
test_command "nuwax-file-server start --env production --port ${PORT}" "启动服务"

# 等待服务启动
sleep 3

# 测试健康检查
echo "测试: 健康检查"
curl -s "${HEALTH_URL}" | jq '.status'
echo "✓ 健康检查通过"
echo ""

# 测试状态查询
test_command "nuwax-file-server status" "查询服务状态"

# 测试重启
test_command "nuwax-file-server restart" "重启服务"
sleep 3

# 再次检查健康
echo "测试: 重启后健康检查"
curl -s "${HEALTH_URL}" | jq '.status'
echo "✓ 重启后健康检查通过"
echo ""

# 停止服务
test_command "nuwax-file-server stop" "停止服务"

echo "=== 所有测试通过 ==="
```

运行测试脚本：

```bash
# 赋予执行权限
chmod +x test-cli.sh

# 运行测试
./test-cli.sh
```

## 9. 相关文档

- [README.md](../README.md) - 项目主文档
- [ENV.md](./ENV.md) - 环境变量配置完整指南
- [CHANGELOG.md](../CHANGELOG.md) - 更新日志
