# 应用构建系统 API 文档

## 访问 API 文档

启动服务后，访问以下地址查看完整的 API 文档：

```
http://localhost:10001/api-docs
```

## API 概览

### 1. Build 相关接口

#### 启动开发服务器

- **接口**: `GET /api/build/start-dev`
- **参数**: `projectId` (必填), `basePath` (可选)
- **说明**: 启动指定项目的开发服务器

#### 构建项目

- **接口**: `GET /api/build/build`
- **参数**: `projectId` (必填), `basePath` (可选)
- **说明**: 构建指定项目

#### 停止开发服务器

- **接口**: `GET /api/build/stop-dev`
- **参数**: `projectId` (必填), `pid` (必填)
- **说明**: 停止指定项目的开发服务器

#### 重启开发服务器

- **接口**: `GET /api/build/restart-dev`
- **参数**: `projectId` (必填), `pid` (可选), `basePath` (可选)
- **说明**: 重启指定项目的开发服务器

#### 列出运行中的开发服务器

- **接口**: `GET /api/build/list-dev`
- **说明**: 获取所有运行中的开发服务器列表

#### 解析构建错误

- **接口**: `POST /api/build/parse-build-error`
- **参数**: `projectId`, `errorMessage`
- **说明**: 解析构建错误信息，返回用户友好的错误提示

#### 获取开发日志

- **接口**: `GET /api/build/get-dev-log`
- **参数**: `projectId` (必填), `startIndex` (可选，默认为1)
- **说明**: 获取指定项目的开发服务器日志
- **返回**: 
  - `logs`: 日志数组（包含行号和内容）
  - `totalLines`: 总行数
  - `startIndex`: 起始行号
  - `cacheHit`: 是否命中缓存
  - `fileTooLarge`: 文件是否过大（超大文件不缓存）

#### 查询日志缓存统计

- **接口**: `GET /api/build/get-log-cache-stats`
- **说明**: 获取日志缓存的统计信息
- **返回**: 
  - `enabled`: 是否启用缓存
  - `cacheSize`: 当前缓存的项目数量
  - `maxCacheEntries`: 最大缓存项目数量
  - `cacheDuration`: 缓存过期时间（毫秒）
  - `maxFileSizeMB`: 当前缓存中最大的文件大小（MB）
  - `totalCacheSizeMB`: 当前总缓存大小（MB）

#### 清除所有日志缓存

- **接口**: `POST /api/build/clear-all-log-cache`
- **说明**: 清除所有日志缓存（用于调试或手动释放内存）
- **返回**: 成功消息

### 2. Project 相关接口

#### 创建项目

- **接口**: `POST /api/project/create-project`
- **参数**: `projectId`
- **说明**: 创建新项目目录

#### 上传并启动

- **接口**: `POST /api/project/upload-start-dev`
- **类型**: multipart/form-data
- **参数**: `projectId`, `codeVersion`, `file` (zip 文件)
- **说明**: 上传项目压缩包并启动开发服务器

#### 获取项目内容

- **接口**: `GET /api/project/get-project-content`
- **参数**: `projectId`
- **说明**: 获取项目的文件列表和内容

#### 备份当前版本

- **接口**: `POST /api/project/backup-current-version`
- **参数**: `projectId`, `codeVersion`
- **说明**: 备份当前项目版本为 zip 文件

#### 导出项目

- **接口**: `POST /api/project/export-project`
- **参数**: `projectId`, `codeVersion`
- **说明**: 导出项目为 zip 文件下载

#### 获取历史版本内容

- **接口**: `GET /api/project/get-project-content-by-version`
- **参数**: `projectId`, `codeVersion`
- **说明**: 获取指定版本的项目内容

### 3. Code 相关接口

#### 提交文件更新

- **接口**: `POST /api/project/submit-files-update`
- **类型**: application/json
- **参数**: `projectId`, `codeVersion`, `files` (数组)
- **说明**: 批量提交文件更新，自动判断是否需要重启开发服务器

#### 上传单个文件

- **接口**: `POST /api/project/upload-single-file`
- **类型**: multipart/form-data
- **参数**: `projectId`, `codeVersion`, `file`, `filePath`
- **说明**: 上传单个文件（支持二进制文件）

## 错误响应格式

所有接口在出错时返回统一的错误格式：

```json
{
  "success": false,
  "error": {
    "type": "VALIDATION_ERROR",
    "message": "项目ID不能为空",
    "timestamp": "2025-10-16T10:00:00.000Z",
    "requestId": "abc123",
    "details": {
      "field": "projectId"
    }
  }
}
```

## 成功响应格式

成功时返回格式：

```json
{
  "success": true,
  "message": "操作成功",
  "data": {}
}
```

## 配置说明

### 环境变量

主要配置项（详见 `env.development`）：

- `PORT`: 服务端口 (默认: 10001)
- `PROJECT_SOURCE_DIR`: 项目源文件目录
- `UPLOAD_PROJECT_DIR`: 上传文件目录
- `DIST_TARGET_DIR`: 构建产物目录
- `MAX_BUILD_CONCURRENCY`: 最大并发构建数 (默认: 20)
- `DEV_SERVER_PORT_TIMEOUT`: 端口解析超时 (默认: 15000ms)
- `DEV_SERVER_STOP_MAX_ATTEMPTS`: 停止进程最大重试次数 (默认: 50)

### 文件上传限制

- **项目压缩包**: 最大 100MB
- **单个文件**: 最大 10MB
- **请求体**: 最大 100MB

### 支持的文件格式

- **项目包**: .zip
- **单文件**: 所有文本和二进制文件

## 开发模式

### 启动服务

```bash
# 开发环境
npm run dev

# 测试环境
npm run test

# 生产环境
npm run prod
```

### 查看日志

日志文件位置：`{LOG_BASE_DIR}/{projectId}/`

- `api-{date}.log`: API 请求日志
- `build-{date}.log`: 构建日志
- `dev-{date}.log`: 开发服务器日志

## 注意事项

1. **并发限制**: 同一项目不能同时启动多个开发服务器
2. **构建限制**: 全局最大并发构建数由 `MAX_BUILD_CONCURRENCY` 控制
3. **文件编码**: 文件内容建议使用 UTF-8 编码
4. **路径安全**: 所有文件路径都会进行安全检查，防止路径遍历攻击
5. **自动重启**: 修改配置文件、package.json 等会自动触发开发服务器重启

## 技术栈

- **框架**: Express 5.x
- **进程管理**: 自定义进程管理器
- **文件上传**: Multer
- **压缩**: Archiver, Yauzl
- **日志**: 自定义日志工具
- **文档**: Swagger/OpenAPI 3.0

## 更多信息

详细的交互式 API 文档请访问: http://localhost:10001/api-docs
