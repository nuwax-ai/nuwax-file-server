# AI Assistant Instructions for nuwax-file-server Project

## Project Overview

nuwax-file-server 是一个跨平台的文件服务部署工具，支持 Windows、Linux、macOS 操作系统，提供 start/stop/restart 命令行操作。

## Core Commands

```bash
nuwax-file-server start              # 启动服务 (默认 env.production)
nuwax-file-server start --env dev    # 启动服务 (开发环境)
nuwax-file-server stop               # 停止服务
nuwax-file-server restart            # 重启服务
nuwax-file-server status             # 查看服务状态
```

## Project Structure

```
nuwax-file-server/
├── src/
│   ├── cli.js                      # CLI 入口 (跨平台兼容)
│   ├── server.js                   # 主服务器
│   ├── routes/
│   │   └── router.js               # 路由定义 (含 /health 端点)
│   ├── utils/
│   │   ├── serviceManager.js       # 服务管理 (跨平台)
│   │   ├── envUtils.js             # 环境变量工具
│   │   ├── build/                  # 构建相关工具
│   │   ├── buildArg/               # 构建参数工具
│   │   ├── buildDependency/        # 依赖管理
│   │   ├── buildJudge/             # 构建判断工具
│   │   ├── buildPermission/        # 权限管理
│   │   ├── common/                 # 公共工具
│   │   ├── computer/               # 计算机工具
│   │   ├── error/                  # 错误处理
│   │   └── log/                    # 日志工具
│   ├── appConfig/                  # 应用配置 (环境变量等)
│   ├── config/
│   │   └── swagger/                # Swagger 文档配置
│   ├── env.development             # 开发环境配置
│   ├── env.production              # 生产环境配置
│   └── env.test                    # 测试环境配置
├── scripts/
│   ├── start-prod.js               # 生产环境启动脚本
│   ├── start-dev.js                # 开发环境启动脚本
│   └── pnpm-check.sh               # pnpm 检查脚本
├── tests/                          # 测试文件
└── package.json                   # 项目配置
```

## Key Implementation Details

### 1. Cross-Platform Compatibility

所有代码必须支持 Windows、Linux、macOS：

- **路径处理**: 使用 `path.join()`, `path.resolve()`, `os.tmpdir()`, `os.homedir()`
- **进程管理**: 使用 `tree-kill` 杀进程组，Windows 使用 `taskkill`，Linux/macOS 使用 `kill` 信号
- **命令执行**: 使用 `cross-spawn` 执行 shell 命令
- **文件操作**: 使用 `fs-extra` 增强文件系统操作

### 2. Environment Configuration

- 环境变量优先级: 命令行参数 > 环境变量文件 > 默认值
- 支持通过 `--env` 参数指定环境 (development/production/test)
- 支持通过 `--env-file` 指定自定义配置文件
- 配置通过 `src/appConfig/index.js` 统一管理，环境文件位于 `src/env.*`

### 3. CLI Design

- 使用 `commander.js` 解析命令行参数
- 命令结构: `nuwax-file-server <command> [options]`
- 支持的命令: start, stop, restart, status
- 全局选项: `--env`, `--port`, `--config`, `--help`

### 4. Health Check Endpoint

健康检查端点位于 `/health`，返回格式:

```json
{
  "status": "ok",
  "timestamp": 1738600000000,
  "uptime": 3600,
  "version": "1.0.0",
  "platform": "darwin"
}
```

### 5. Service Management

- PID 文件存储在临时目录 (`os.tmpdir()`)
- 启动时检查服务是否已运行
- 停止时支持优雅退出 (30秒超时)
- 重启组合 stop + start 操作

## Development Guidelines

### Code Style

- 使用中文注释（根据项目规则）
- 函数必须添加 JSDoc 注释
- 跨平台代码必须包含平台检测逻辑
- 错误处理必须包含详细日志

### Testing

- 单元测试放置在 `tests/unit/` 目录
- 测试框架使用 Jest
- 关键函数必须编写单元测试

### Logging

- 使用 `src/utils/log/logUtils.js` 中的 `log()` 函数
- 日志级别: error, warn, info, debug
- 日志文件按日期分割，存储在 `LOG_BASE_DIR`

## Common Tasks

### Adding a New Route

1. 在 `src/routes/` 目录下创建新的路由文件
2. 在 `router.js` 中挂载路由
3. 添加相应的服务逻辑到 `src/service/` 目录

### Adding a New CLI Command

1. 在 `src/cli.js` 中使用 `commander` 定义命令
2. 在 `src/utils/serviceManager.js` 中实现服务逻辑
3. 更新 `README.md` 文档

### Modifying Configuration

1. 在 `src/env.production` / `src/env.development` / `src/env.test` 中添加环境变量
2. 在 `config/index.js` 中读取配置
3. 更新 `README.md` 文档

## Build and Deploy

```bash
# 开发环境运行
npm run dev

# 生产环境运行
npm run prod

# 运行测试
npm run test

# 发布到 npm
npm publish
```

## Important Notes

- 所有平台相关代码必须使用条件判断 (`process.platform`)
- 避免使用 Unix 特定命令（grep, sed, awk 等）
- Windows 环境使用 `cross-spawn` 执行命令
- 确保日志目录有写入权限
