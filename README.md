# nuwax-file-server

跨平台的文件服务部署工具，支持 Windows、Linux、macOS 操作系统。

## 功能特性

- **CLI 命令行操作**: 支持 start / stop / restart / status 命令
- **跨平台支持**: Windows、Linux、macOS 完美兼容
- **环境变量配置**: 支持通过环境变量和命令行参数配置
- **健康检查端点**: 提供 /health 接口用于服务检活
- **PID 文件管理**: 自动管理服务进程 ID

## 安装部署

### 本地开发安装

```bash
# 克隆项目
git clone <repository-url>
cd nuwax-file-server

# 安装依赖
npm install

# 本地运行（开发模式）
npm run dev

# 本地运行（生产模式）
npm run prod
```

### 全局安装 CLI 工具

```bash
# 在项目根目录执行
npm install -g .

# 然后可以在任何位置使用
nuwax-file-server --help
```

### 系统要求

- Node.js >= 22.0.0（ES Module 原生支持）
- zip/unzip 工具（用于项目打包）
- pnpm（推荐）或 npm/yarn

## CLI 命令

nuwax-file-server 提供以下 CLI 命令：

### 基本命令

```bash
# 启动服务（默认使用 env.production 配置）
nuwax-file-server start

# 启动服务（指定环境）
nuwax-file-server start --env development
nuwax-file-server start --env production
nuwax-file-server start --env test

# 停止服务
nuwax-file-server stop

# 强制停止服务
nuwax-file-server stop --force

# 重启服务
nuwax-file-server restart

# 查看服务状态
nuwax-file-server status
```

### 高级选项

```bash
# 指定端口启动
nuwax-file-server start --port 8080

# 指定配置文件
nuwax-file-server start --config /path/to/config.json

# 组合使用
nuwax-file-server start --env development --port 3000
```

### 使用 npm scripts

```bash
# 启动服务
npm run cli:start
npm run cli:start:dev    # 开发环境
npm run cli:start:prod   # 生产环境
npm run cli:start:test   # 测试环境

# 停止服务
npm run cli:stop

# 重启服务
npm run cli:restart

# 查看状态
npm run cli:status
```

## 环境变量配置

完整的环境变量配置说明请参考：[环境变量配置文档](./docs/ENV.md)

### 快速使用示例

```bash
# 使用 env.production 默认配置（推荐）
nuwax-file-server start --env production --port 60000

# 自定义路径配置（根据实际需求删减）
nuwax-file-server start --env production --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads
```

### 核心路径变量

| 环境变量                 | 说明                           |
| ------------------------ | ------------------------------ |
| `INIT_PROJECT_DIR`       | 初始化工程目录                 |
| `UPLOAD_PROJECT_DIR`     | 上传的项目压缩包路径           |
| `PROJECT_SOURCE_DIR`     | 项目源文件路径                 |
| `DIST_TARGET_DIR`        | 构建产物目标目录（nginx 加载） |
| `LOG_BASE_DIR`           | 日志基础目录                   |
| `COMPUTER_WORKSPACE_DIR` | computer 工作目录              |
| `COMPUTER_LOG_DIR`       | computer 日志目录              |

完整配置项和场景示例请参阅：[环境变量配置文档](./docs/ENV.md)

### 命令行覆盖

```bash
# 端口优先级: 命令行 > 环境变量 > 默认值
nuwax-file-server start --env production --port 8080
```

## 健康检查端点

服务提供 `/health` 端点用于健康检查和监控。

### 请求

```bash
curl http://localhost:60000/health
```

### 响应

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

### 响应字段说明

| 字段        | 类型   | 说明                              |
| ----------- | ------ | --------------------------------- |
| status      | string | 服务状态，ok 表示正常             |
| timestamp   | number | 当前时间戳（毫秒）                |
| uptime      | number | 服务运行时间（秒）                |
| version     | string | 服务版本号                        |
| platform    | string | 操作系统平台 (darwin/linux/win32) |
| nodeVersion | string | Node.js 版本                      |
| pid         | number | 进程 ID                           |
| memory      | object | 内存使用情况（MB）                |
| env         | string | 当前环境                          |

## 跨平台说明

### Windows

- PID 文件存储在 `%TEMP%\nuwax-file-server\`
- 进程停止使用 `taskkill /F /PID` 命令
- 路径分隔符使用反斜杠 `\`

### Linux/macOS

- PID 文件存储在 `/tmp/nuwax-file-server/`
- 进程停止使用 kill 信号 (SIGTERM/SIGKILL)
- 路径分隔符使用正斜杠 `/`

### 通用

- 所有路径使用 `path.join()` 处理
- 使用 `os.tmpdir()` 获取临时目录
- 使用 `cross-spawn` 执行 shell 命令
- 使用 `tree-kill` 杀死进程树

## pnpm 磁盘空间优化

本项目自动为所有创建、上传或复制的项目注入优化的 `.npmrc` 配置文件，以优化 pnpm 的磁盘空间使用。

### 自动优化

在以下操作中，系统会自动为项目创建 `.npmrc` 配置文件：

- **创建项目** (`/create-project`)
- **上传项目** (`/upload-project`)
- **复制项目** (`/copy-project`)

### 检查磁盘使用

```bash
# 自动检测当前环境配置
npm run pnpm:check

# 或指定特定环境
npm run pnpm:check:dev   # 开发环境
npm run pnpm:check:prod  # 生产环境
npm run pnpm:check:test  # 测试环境

# 或手动指定目录
bash scripts/pnpm-check.sh /path/to/projects
```

### 清理未使用的包

```bash
# 立即清理
npm run pnpm:prune

# 查看日志的清理（推荐）
npm run pnpm:prune:log
```

### 定时清理（自动集成）

定时任务已集成到主应用，随应用启动自动运行，通过环境变量配置：

```yaml
# docker-compose.yml 或 .env 文件
environment:
  PNPM_PRUNE_ENABLED: "true" # 启用定时清理（默认 true）
  PNPM_PRUNE_SCHEDULE: "0 2 * * 0" # 每周日凌晨 2 点
  PNPM_PRUNE_TIMEZONE: "Asia/Shanghai" # 时区（默认 Asia/Shanghai）
  PNPM_PRUNE_RUN_ON_START: "false" # 启动时立即执行（默认 false）
```

**常用时间配置：**

```bash
"0 2 * * 0"    # 每周日凌晨 2 点
"0 3 * * *"    # 每天凌晨 3 点
"0 2 1 * *"    # 每月 1 号凌晨 2 点
"0 */6 * * *"  # 每 6 小时
```

### 预期效果

- 磁盘空间节省 50-70%（多项目共享依赖）
- 安装速度提升（使用国内镜像）
- 完全自动化，无需手动配置
- 定期清理，保持 store 整洁

## 故障排除

### 服务无法启动

1. 检查端口是否被占用
2. 检查日志文件权限
3. 检查环境配置文件是否存在

```bash
# 查看详细日志
nuwax-file-server start --env development
```

### 服务无法停止

```bash
# 使用强制停止
nuwax-file-server stop --force

# 手动查找并停止进程
ps aux | grep nuwax-file-server
kill -9 <pid>
```

### 健康检查失败

1. 检查服务是否正在运行
2. 检查端口是否正确
3. 检查防火墙设置

```bash
# 查看服务状态
nuwax-file-server status

# 测试健康检查
curl http://localhost:60000/health
```

## 开发指南

### 添加新命令

在 `src/cli.js` 中使用 commander 定义新命令：

```javascript
program
  .command("newcommand")
  .description("新命令描述")
  .option("--option", "选项描述")
  .action((options) => {
    // 命令逻辑
  });
```

### 添加新配置项

1. 在 `env.development` / `env.production` / `env.test` 中添加环境变量
2. 在 `config/index.js` 中读取配置
3. 在文档中说明

## 许可证

ISC
