# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.3] - 2026-03-06

### Changed

- **发布与包管理**
  - 移除 `packageManager` 与 `preinstall` 的 pnpm 强约束，支持使用 npm 安装与发布
  - `prepublishOnly` 改为 `npm run build`，便于 npm 发布流程

## [1.2.2] - 2026-03-06

### Added

- **性能耗时日志**
  - 所有关键 API 接口（项目初始化、更新、目录/文件列表）添加 INFO 级别耗时日志，包含 `elapsedMs` 数值字段
  - 中间步骤（备份、解压、文件写入、清理等）添加 DEBUG 级别耗时日志
  - 错误路径统一添加 `elapsedMs` 字段，便于排查超时和异常耗时问题

### Changed

- **日志级别优化**
  - 中间步骤日志（备份、解压、文件写入等"开始"类日志）从 INFO 降级为 DEBUG，减少生产环境日志噪音
  - 通过 `LOG_LEVEL` 环境变量控制日志输出级别（error > warn > info > debug）

- **日志格式统一**
  - 所有耗时字段统一使用 `elapsedMs`（数值类型，单位毫秒），便于日志聚合和监控系统解析
  - 移除冗余的重复日志输出

### Fixed

- **downloadAllFiles 耗时统计修正**
  - 将耗时记录从压缩准备阶段移至 `archive.on("end")` 事件，准确反映实际压缩完成时间

## [1.2.0] - 2026-02-06

### Added

- **CLI 参数解析增强**
  - 支持在命令行中传递 `--KEY=VALUE` 格式的参数
  - 自动将这些参数写入 `process.env` 环境变量
  - 可以在启动服务时通过命令行覆盖环境变量配置

### Changed

- **命令灵活性提升**
  - `start` 和 `restart` 命令现在允许接受未知选项
  - 允许传递额外的自定义参数给服务

## [1.1.1] - 2026-02-04

### Added

- **CLI 版本查询增强**
  - 新增 `-v` 参数作为查看版本的快捷方式（支持 `-v, --version`）

## [1.1.0] - 2026-02-03

### Changed

- **ES Module 迁移**
  - 全面迁移到 ES Module (ESM) 语法
  - 所有 `require` 替换为 `import`
  - 所有 `module.exports` 替换为 `export`
  - 更新 Node.js 版本要求至 >= 22.0.0
  - `package.json` 添加 `"type": "module"`

- **构建流程更新**
  - 新增 `scripts/build.js` 使用 esbuild 打包
  - 输出格式设置为 ESM
  - 支持代码压缩和发布优化

### Added

- **LOG_BASE_DIR 容错增强**
  - 当配置路径无法创建时自动回退到系统临时目录
  - 避免因路径问题导致服务启动失败

## [1.0.0] - 2025-02-03

### Added

- **CLI 工具支持**
  - 新增 `nuwax-file-server` CLI 命令行工具
  - 支持 `start`、`stop`、`restart`、`status` 命令
  - 支持 `--port`、`--env`、`--config` 等命令行参数
  - 支持通过命令行参数覆盖环境变量配置

- **跨平台支持**
  - 支持 Windows、Linux、macOS 三大平台
  - 使用 `cross-spawn` 确保跨平台命令执行
  - 使用 `tree-kill` 实现跨平台进程终止
  - PID 文件管理支持多平台临时目录

- **健康检查端点**
  - 新增 `/health` HTTP 端点
  - 返回服务状态、版本、运行时间、内存使用等信息

- **环境变量配置**
  - 完整的配置文件加载机制
  - 支持 `env.development`、`env.production`、`env.test`
  - 详细的路径配置项说明
  - CLI 专用配置项

- **项目文档**
  - 新增 `docs/ENV.md` 完整的环境变量配置指南
  - 更新 `README.md` 包含 CLI 使用说明
  - 新增 `AGENTS.md` 和 `CLAUDE.md` 软链接

- **测试**
  - 新增 `tests/unit/cli.test.js` 单元测试
  - 覆盖服务管理器、环境变量工具、跨平台兼容性等

### Changed

- **包配置**
  - `package.json` 新增 `bin` 字段支持 CLI 全局安装
  - 新增 `commander`、`cross-spawn`、`fs-extra`、`tree-kill` 依赖

### Fixed

- **启动脚本**
  - 修复 `scripts/start-cli.js` 实际加载 server.js 的问题
  - 修复 `router.js` 中 package.json 路径解析问题

### Security

- 使用 `path.resolve` 和 `fs.readFileSync` 替代 `require` 确保安全性

## [0.1.0] - 2024-XX-XX

Initial release of nuwax-file-server project.

### Added

- 项目基础结构
- Express 服务器配置
- 构建路由、项目路由、代码路由
- pnpm 磁盘空间优化功能
- 日志缓存管理
