# test-cli.sh 使用说明

`test-cli.sh` 是 nuwax-file-server 的 CLI 自动化测试脚本，用于在本地验证 `nuwax-file-server` 的启动、状态查询、健康检查、重启、停止等能力。

---

## 快速开始

```bash
# 赋予执行权限（首次需要）
chmod +x scripts/test-cli.sh

# 默认模式：pnpm install + pnpm link 后测试
./scripts/test-cli.sh

# 直接运行 dist（无需全局链接）
./scripts/test-cli.sh --direct

# 已全局安装，跳过安装步骤
./scripts/test-cli.sh --installed
```

---

## 环境要求

| 依赖   | 说明                          |
|--------|-------------------------------|
| bash   | 脚本运行环境                  |
| curl   | 用于请求健康检查端点          |
| jq     | 用于解析 JSON 输出            |
| pnpm   | 模式一、模式二需要（模式三可选） |
| node   | 建议 v22+                     |

安装示例（macOS）：

```bash
brew install curl jq
# pnpm / node 按项目要求安装
```

---

## 三种测试模式

### 模式一：默认（pnpm link）

- **命令**：`./scripts/test-cli.sh`（无额外参数）
- **行为**：
  - 在项目根目录执行 `pnpm install`
  - 执行 `pnpm run build` 编译到 `dist/`
  - 执行 `pnpm link --global` 使 `nuwax-file-server` 全局可用
  - 使用全局命令 `nuwax-file-server` 进行测试
- **适用**：本地开发、首次验证、未全局安装时

### 模式二：直接运行（--direct）

- **命令**：`./scripts/test-cli.sh --direct`
- **行为**：
  - 不执行 `pnpm link`，直接使用 `node dist/cli.js` 运行
  - 要求项目已构建：存在 `dist/` 且存在 `dist/cli.js`
- **前置**：先执行 `pnpm run build`
- **适用**：不想改全局命令、只测当前构建结果时

### 模式三：已安装（--installed）

- **命令**：`./scripts/test-cli.sh --installed`
- **行为**：
  - 不安装、不构建、不 link，直接调用已安装的 `nuwax-file-server`
  - 若未找到 `nuwax-file-server` 会报错并提示安装
- **前置**：已通过 `npm install -g nuwax-file-server` 或 `pnpm link --global` 安装
- **适用**：验证全局安装版本、CI 或已安装环境

---

## 命令行选项

| 选项 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--port <端口>` | `-p` | 测试用服务端口 | `60000` |
| `--direct` | - | 使用模式二：node 直接运行 dist | - |
| `--installed` | - | 使用模式三：已全局安装 | - |
| `--project-dir <目录>` | - | 项目目录 | `./test-projects` |
| `--nginx-dir <目录>` | - | Nginx 目录 | `./test-nginx` |
| `--upload-dir <目录>` | - | 上传目录 | `./test-uploads` |
| `--help` | `-h` | 显示帮助信息 | - |

---

## 环境变量

以下环境变量会覆盖默认值（与命令行选项等效）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `60000` |
| `PROJECT_DIR` | 项目目录 | `./test-projects` |
| `NGINX_DIR` | Nginx 目录 | `./test-nginx` |
| `UPLOAD_DIR` | 上传目录 | `./test-uploads` |

示例：

```bash
PORT=60001 ./scripts/test-cli.sh --installed
```

---

## 测试流程说明

脚本会按顺序执行：

1. **测试 1：启动服务**  
   使用 `start --env production --port <PORT>` 启动服务，等待约 3 秒。
2. **测试 2：健康检查**  
   请求 `http://localhost:<PORT>/health`，校验返回 JSON 中 `status === "ok"`。
3. **测试 3：状态查询**  
   执行 `status` 命令，检查输出正常。
4. **测试 4：重启服务**  
   执行 `restart`，再等待约 3 秒。
5. **测试 5：重启后健康检查**  
   再次请求 `/health`，确认重启后服务正常。
6. **测试 6：停止服务**  
   执行 `stop`，结束服务。

脚本结束或异常退出时会做清理（停止服务；模式一还会执行 `pnpm unlink --global`）。

---

## 使用示例

```bash
# 默认模式，使用默认端口 60000
./scripts/test-cli.sh

# 模式二，指定端口 60001
./scripts/test-cli.sh --direct --port 60001

# 模式三，指定端口
./scripts/test-cli.sh --installed -p 60001

# 自定义项目/nginx/上传目录
./scripts/test-cli.sh --project-dir ./my-projects --nginx-dir ./my-nginx --upload-dir ./my-uploads

# 查看帮助
./scripts/test-cli.sh --help
```

---

## 常见问题

**Q: 提示 `dist 目录不存在` 或 `dist/cli.js 不存在`？**  
A: 使用 `--direct` 前请先执行 `pnpm run build`，或改用默认模式（会自动 build）。

**Q: 提示未找到 `nuwax-file-server` 命令？**  
A: 使用 `--installed` 前需先全局安装，例如 `npm install -g nuwax-file-server` 或在本项目执行 `pnpm link --global`。也可改用默认模式或 `--direct`。

**Q: 端口被占用？**  
A: 通过 `-p`/`--port` 或环境变量 `PORT` 指定其他端口，例如 `./scripts/test-cli.sh -p 60001`。

**Q: 缺少 curl / jq？**  
A: 脚本会检查依赖并提示。macOS 可用 `brew install curl jq` 安装。

---

## 相关文档

- [QUICK_START.md](./QUICK_START.md) - 项目快速上手
- [ENV.md](./ENV.md) - 环境与配置说明
- [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) - 项目结构与开发约定
