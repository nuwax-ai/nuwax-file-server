# pnpm-check 使用说明

## 功能说明

`pnpm-check` 脚本用于检查和分析 pnpm 的磁盘空间使用情况，支持多环境配置。

## 使用方法

### 方法 1: 使用 npm 脚本（推荐）

脚本会自动从当前 NODE_ENV 环境配置中读取项目目录。

```bash
# 自动检测当前环境（默认 development）
npm run pnpm:check

# 指定开发环境
npm run pnpm:check:dev

# 指定生产环境
npm run pnpm:check:prod

# 指定测试环境
npm run pnpm:check:test
```

### 方法 2: 直接调用包装脚本

```bash
# 使用当前环境变量
node scripts/pnpm-check-wrapper.js

# 指定环境
NODE_ENV=production node scripts/pnpm-check-wrapper.js
```

### 方法 3: 直接调用 bash 脚本

```bash
# 手动指定项目目录
bash scripts/pnpm-check.sh /path/to/projects

# 使用环境变量
PROJECT_SOURCE_DIR=/path/to/projects bash scripts/pnpm-check.sh
```

## 输出说明

### 1. pnpm 版本信息

```
✅ pnpm 版本: 10.18.2
```

显示当前安装的 pnpm 版本。

### 2. pnpm Store 信息

```
📁 pnpm Store 路径:
   /Users/xxx/.pnpm-store
   Store 大小: 2.5G
```

- **Store 路径**: pnpm 全局依赖包存储位置
- **Store 大小**: 这是**真实的磁盘占用**，所有项目共享这个 store

### 3. Store 状态

```
📊 pnpm Store 状态:
Packages in the store are untouched
```

显示 store 中的包使用情况。

### 4. 项目 node_modules 占用

```
📦 各项目 node_modules 占用（表面大小）:
   ⚠️  注意：du 命令会重复计算硬链接，实际占用远小于此
   [project-a] 500MB (包含硬链接重复计算)
   [project-b] 500MB (包含硬链接重复计算)
```

⚠️ **重要**: 这里显示的是 `du` 命令的输出，会**重复计算硬链接**！

### 5. .pnpm 文件夹占用

```
🗂️  各项目 .pnpm 文件夹占用（表面大小）:
   ⚠️  注意：.pnpm 中都是硬链接，实际不占额外空间
   [project-a] 400MB (硬链接，实际共享)
   [project-b] 400MB (硬链接，实际共享)
```

⚠️ **重要**: `.pnpm` 文件夹中的文件都是硬链接，实际只占用一份空间！

### 6. 实际磁盘占用

```
💾 实际磁盘占用情况:
   使用 df 命令查看整个文件系统（更准确）:
   文件系统: /dev/disk1 | 已用: 150GB | 可用: 200GB | 使用率: 43%
```

这是查看真实磁盘占用的最准确方法。
