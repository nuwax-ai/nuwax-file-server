# Environment variables — full reference

nuwax-file-server can be configured entirely through environment variables. This document lists every supported variable.

## Precedence

From highest to lowest:

1. **CLI arguments**
2. **Process environment variables**
3. **Env files** (`.env.production`, `.env.development`, `.env.test` — loaded according to project conventions; see `src/env.*`)
4. **Built-in defaults**

## Env files

Files under `src/` are selected based on `NODE_ENV`:

| Mode | File | Purpose |
| ---- | ---- | ------- |
| development | `env.development` | Local development |
| production | `env.production` | Production |
| test | `env.test` | Tests |

## Core settings

### Server

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `NODE_ENV` | `development` | `development` / `production` / `test` |
| `PORT` | `60000` | HTTP listen port |
| `REQUEST_BODY_LIMIT` | `2000mb` | Express body size limit |

### Logging

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `LOG_BASE_DIR` | — | Base directory for log files |
| `LOG_LEVEL` | `debug` | `error` / `warn` / `info` / `debug` |
| `LOG_CONSOLE_ENABLED` | `true` | Mirror logs to console |
| `LOG_PREFIX_API` | `api` | Prefix for API logs |
| `LOG_PREFIX_BUILD` | `build` | Prefix for build logs |

### Project paths

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `INIT_PROJECT_NAME_REACT` | `react-vite-template` | Built-in scaffold name for React projects |
| `INIT_PROJECT_NAME_VUE3` | `vue3-vite-template` | Built-in scaffold name for Vue3 projects |
| `INIT_PROJECT_DIR` | — | Scaffold / init project directory |
| `UPLOAD_PROJECT_DIR` | — | Directory for uploaded project archives |
| `PROJECT_SOURCE_DIR` | — | Unpacked / working project sources |
| `DIST_TARGET_DIR` | — | Build output directory (e.g. served by nginx) |
| `COMPUTER_WORKSPACE_DIR` | — | “Computer” feature workspace |
| `COMPUTER_LOG_DIR` | — | “Computer” feature logs |

### Build

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `MAX_BUILD_CONCURRENCY` | `20` | Max concurrent builds |
| `DEV_SERVER_PORT_TIMEOUT` | `5000` | Dev-server port probe timeout (ms) |
| `DEV_SERVER_STOP_TIMEOUT` | `5000` | Dev-server stop timeout (ms) |
| `DEV_SERVER_STOP_CHECK_INTERVAL` | `100` | Poll interval while stopping dev server (ms) |
| `DEV_SERVER_STOP_MAX_ATTEMPTS` | `50` | Max stop retries |

### Uploads

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `MAX_INLINE_FILE_SIZE_BYTES` | `1048576` | Max size (bytes) to return inline; larger files are not inlined |
| `UPLOAD_MAX_FILE_SIZE_BYTES` | `1048576000` | Max archive upload size (bytes) |
| `UPLOAD_ALLOWED_EXTENSIONS` | `.zip` | Allowed extensions (comma-separated) |
| `UPLOAD_SINGLE_FILE_SIZE_BYTES` | `1048576000` | Max single upload size (bytes) |

### Traversal / filters

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `TRAVERSE_EXCLUDE_DIRS` | `dist,node_modules,.pnpm-store,__MACOSX,.attachments` | Comma-separated dirs to skip when traversing |
| `BACKUP_TRAVERSE_EXCLUDE_FILES` | `pnpm-lock.yaml,yarn.lock,package-lock.json` | Comma-separated files to skip in backup traversal |
| `CONTENT_TRAVERSE_EXCLUDE_FILES` | `AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json` | Comma-separated files to skip for content API |
| `INLINE_IMAGE_EXTENSIONS` | `.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif` | Image extensions eligible for inline serving |
| `TOP_LEVEL_NOISE_PATTERNS` | `__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments` | Comma-separated noise patterns for top-level flattening after unzip |

### pnpm prune scheduler

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PNPM_PRUNE_ENABLED` | `true` | Enable scheduled `pnpm store` maintenance |
| `PNPM_PRUNE_SCHEDULE` | `0 2 * * *` | Cron expression |
| `PNPM_PRUNE_TIMEZONE` | `Asia/Shanghai` | Time zone for the schedule |
| `PNPM_PRUNE_RUN_ON_START` | `false` | Run once immediately on startup |

**Example cron expressions:**

| Expression | Meaning |
| ---------- | ------- |
| `0 2 * * 0` | Every Sunday 02:00 |
| `0 3 * * *` | Every day 03:00 |
| `0 2 1 * *` | 1st of month 02:00 |
| `0 */6 * * *` | Every 6 hours |

### Log cache

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `LOG_CACHE_ENABLED` | `true` | Enable in-memory log cache |
| `LOG_CACHE_DURATION` | `180000` | TTL (ms); default 3 minutes |
| `LOG_CACHE_MAX_ENTRIES` | `100` | Max cached entries |
| `LOG_CACHE_MAX_FILE_SIZE` | `2097152` | Max cached file size (bytes); default 2 MB |

### CLI-only

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `CLI_PID_DIR` | system temp | Directory for PID file |
| `CLI_PID_FILE` | `server.pid` | PID filename |
| `CLI_STOP_TIMEOUT` | `30000` | Graceful stop timeout (ms) |
| `CLI_CHECK_INTERVAL` | `500` | Poll interval when stopping (ms) |
| `CLI_LOG_DIR` | system temp | CLI log directory |

## Extra CLI environment

| Variable | Description |
| -------- | ----------- |
| `CONFIG_FILE` | Optional path to an extra env file (CLI) |

## Examples

### Use production defaults but override paths

In real deployments you often keep `env.production` as the base and only override paths:

#### Example A: production + custom paths

```bash
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/my-projects \
  DIST_TARGET_DIR=/var/www/my-app \
  UPLOAD_PROJECT_DIR=/data/uploads \
  LOG_BASE_DIR=/var/log/nuwax
```

#### Example B: multiple instances on one host

```bash
# Instance 1 — main
nuwax-file-server start \
  --env production \
  --port 60001 \
  PROJECT_SOURCE_DIR=/data/main-site \
  DIST_TARGET_DIR=/var/www/main-site

# Instance 2 — staging
nuwax-file-server start \
  --env production \
  --port 60002 \
  PROJECT_SOURCE_DIR=/data/test-site \
  DIST_TARGET_DIR=/var/www/test-site

# Instance 3 — internal
nuwax-file-server start \
  --env production \
  --port 60003 \
  PROJECT_SOURCE_DIR=/data/internal \
  DIST_TARGET_DIR=/var/www/internal
```

> Only pass `--port` and the paths you need; everything else comes from `env.production`.

#### Example C: override file

```bash
cat > env.override << 'EOF'
# Path overrides for production
PROJECT_SOURCE_DIR=/data/override-projects
DIST_TARGET_DIR=/var/www/override-nginx
UPLOAD_PROJECT_DIR=/data/override-uploads
LOG_BASE_DIR=/var/log/override
EOF

nuwax-file-server start --env production --env-file ./env.override
```

#### Example D: Kubernetes ConfigMap

```bash
kubectl create configmap nuwax-overrides \
  --from-literal=PROJECT_SOURCE_DIR=/data/k8s-projects \
  --from-literal=DIST_TARGET_DIR=/usr/share/nginx/apps \
  --from-literal=UPLOAD_PROJECT_DIR=/data/k8s-uploads \
  --from-literal=LOG_BASE_DIR=/var/log/nuwax
```

Reference it in the Deployment:

```yaml
envFrom:
  - configMapRef:
      name: nuwax-overrides
```

#### Example E: full path set (illustrative)

Below lists path-related variables you might set. Trim to what you actually need:

```bash
# Production with defaults from env.production, paths overridden
nuwax-file-server start \
  --env production \
  --port 60000

# Or set paths explicitly
nuwax-file-server start \
  --env production \
  --port 60000 \
  INIT_PROJECT_NAME_REACT=react-vite-template \
  INIT_PROJECT_NAME_VUE3=vue3-vite-template \
  INIT_PROJECT_DIR=/app/project_init \
  UPLOAD_PROJECT_DIR=/app/project_zips \
  PROJECT_SOURCE_DIR=/app/project_workspace \
  DIST_TARGET_DIR=/app/project_nginx \
  LOG_BASE_DIR=/app/logs/project_logs \
  COMPUTER_WORKSPACE_DIR=/app/computer-project-workspace \
  COMPUTER_LOG_DIR=/app/logs/computer_logs
```

#### Path variables as documented for `env.production`

| Variable | Example default | Description |
| -------- | --------------- | ----------- |
| `INIT_PROJECT_NAME_REACT` | `react-vite-template` | Built-in scaffold name for React projects |
| `INIT_PROJECT_NAME_VUE3` | `vue3-vite-template` | Built-in scaffold name for Vue3 projects |
| `INIT_PROJECT_DIR` | `/app/project_init` | Init project directory |
| `UPLOAD_PROJECT_DIR` | `/app/project_zips` | Uploaded zips |
| `PROJECT_SOURCE_DIR` | `/app/project_workspace` | Project workspace |
| `DIST_TARGET_DIR` | `/app/project_nginx` | Build output (nginx root) |
| `LOG_BASE_DIR` | `/app/logs/project_logs` | Log root |
| `COMPUTER_WORKSPACE_DIR` | `/app/computer-project-workspace` | Computer workspace |
| `COMPUTER_LOG_DIR` | `/app/logs/computer_logs` | Computer logs |

#### Path-only snippets

```bash
# 1) Only change project sources
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/my-projects

# 2) Several paths
nuwax-file-server start \
  --env production \
  --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads

# 3) Full path set
nuwax-file-server start \
  --env production \
  --port 60000 \
  INIT_PROJECT_NAME_REACT=my-react-template \
  INIT_PROJECT_NAME_VUE3=my-vue3-template \
  INIT_PROJECT_DIR=/data/init \
  UPLOAD_PROJECT_DIR=/data/zips \
  PROJECT_SOURCE_DIR=/data/workspace \
  DIST_TARGET_DIR=/var/www/nginx \
  LOG_BASE_DIR=/var/logs/project_logs \
  COMPUTER_WORKSPACE_DIR=/data/computer \
  COMPUTER_LOG_DIR=/var/logs/computer
```

> `--port` selects the HTTP port; unset path keys keep their values from `env.production`.

#### Verify overrides

```bash
nuwax-file-server status
curl http://localhost:60000/health | jq

# Check startup logs for loaded env (messages are in English, e.g. "Loaded environment files: ...")
grep -E "Loaded environment|Environment configuration file" /var/log/nuwax/server.log
```

### CLI overrides precedence

CLI wins over env files and plain env:

```bash
nuwax-file-server start --port 8080

nuwax-file-server start --env production

nuwax-file-server start --env production --port 8080
```

### Shell environment

#### Linux / macOS

```bash
export PORT=8080
export NODE_ENV=production
export LOG_LEVEL=info

# Persist in ~/.bashrc or ~/.zshrc
echo 'export PORT=8080' >> ~/.bashrc
source ~/.bashrc
```

#### Windows

```cmd
set PORT=8080
set NODE_ENV=production

setx PORT 8080
setx NODE_ENV production
```

### Docker / Compose

#### docker-compose.yml

```yaml
version: '3.8'

services:
  nuwax-file-server:
    image: nuwax-file-server:latest
    container_name: nuwax-file-server
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=60000

      - LOG_BASE_DIR=/app/logs
      - LOG_LEVEL=info
      - LOG_CONSOLE_ENABLED=false

      - PROJECT_SOURCE_DIR=/app/projects
      - DIST_TARGET_DIR=/app/nginx
      - UPLOAD_PROJECT_DIR=/app/uploads
      - INIT_PROJECT_DIR=/app/init
      - COMPUTER_WORKSPACE_DIR=/app/computer
      - COMPUTER_LOG_DIR=/app/computer-logs

      - MAX_BUILD_CONCURRENCY=20

      - PNPM_PRUNE_ENABLED=true
      - PNPM_PRUNE_SCHEDULE=0 3 * * *
      - PNPM_PRUNE_TIMEZONE=Asia/Shanghai

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

WORKDIR /app

COPY package*.json ./

RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY . .

RUN mkdir -p /app/logs /app/projects /app/nginx /app/uploads /app/init /app/computer

EXPOSE 60000

CMD ["node", "scripts/start-cli.js"]
```

### Sample env files

#### .env.production

```bash
# ==================== Server ====================
NODE_ENV=production
PORT=60000
REQUEST_BODY_LIMIT=2000mb

# ==================== Logging ====================
LOG_BASE_DIR=/app/logs
LOG_LEVEL=info
LOG_CONSOLE_ENABLED=false
LOG_PREFIX_API=api
LOG_PREFIX_BUILD=build

# ==================== Paths ====================
INIT_PROJECT_NAME_REACT=react-vite-template
INIT_PROJECT_NAME_VUE3=vue3-vite-template
INIT_PROJECT_DIR=/app/project_init
UPLOAD_PROJECT_DIR=/app/project_zips
PROJECT_SOURCE_DIR=/app/project_workspace
DIST_TARGET_DIR=/app/project_nginx
COMPUTER_WORKSPACE_DIR=/app/computer-project-workspace
COMPUTER_LOG_DIR=/app/logs/computer_logs

# ==================== Build ====================
MAX_BUILD_CONCURRENCY=20
DEV_SERVER_PORT_TIMEOUT=5000
DEV_SERVER_STOP_TIMEOUT=5000
DEV_SERVER_STOP_CHECK_INTERVAL=100
DEV_SERVER_STOP_MAX_ATTEMPTS=50

# ==================== Uploads ====================
MAX_INLINE_FILE_SIZE_BYTES=1048576
UPLOAD_MAX_FILE_SIZE_BYTES=1048576000
UPLOAD_ALLOWED_EXTENSIONS=.zip
UPLOAD_SINGLE_FILE_SIZE_BYTES=1048576000

# ==================== Traversal / filters ====================
TRAVERSE_EXCLUDE_DIRS=dist,node_modules,.pnpm-store,__MACOSX,.attachments
BACKUP_TRAVERSE_EXCLUDE_FILES=pnpm-lock.yaml,yarn.lock,package-lock.json
CONTENT_TRAVERSE_EXCLUDE_FILES=AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json
INLINE_IMAGE_EXTENSIONS=.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif
TOP_LEVEL_NOISE_PATTERNS=__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments

# ==================== pnpm prune ====================
PNPM_PRUNE_ENABLED=true
PNPM_PRUNE_SCHEDULE=0 2 * * *
PNPM_PRUNE_TIMEZONE=Asia/Shanghai
PNPM_PRUNE_RUN_ON_START=false

# ==================== Log cache ====================
LOG_CACHE_ENABLED=true
LOG_CACHE_DURATION=180000
LOG_CACHE_MAX_ENTRIES=100
LOG_CACHE_MAX_FILE_SIZE=2097152

# ==================== CLI ====================
CLI_PID_DIR=/tmp/nuwax-file-server
CLI_STOP_TIMEOUT=30000
CLI_CHECK_INTERVAL=500
CLI_LOG_DIR=/tmp/nuwax-file-server/logs
```

#### .env.development

```bash
# ==================== Server ====================
NODE_ENV=development
PORT=60000
REQUEST_BODY_LIMIT=2000mb

# ==================== Logging ====================
LOG_BASE_DIR=./logs
LOG_LEVEL=debug
LOG_CONSOLE_ENABLED=true
LOG_PREFIX_API=api
LOG_PREFIX_BUILD=build

# ==================== Paths ====================
INIT_PROJECT_NAME_REACT=react-vite-template
INIT_PROJECT_NAME_VUE3=vue3-vite-template
INIT_PROJECT_DIR=./project_init
UPLOAD_PROJECT_DIR=./project_zips
PROJECT_SOURCE_DIR=./project_workspace
DIST_TARGET_DIR=./project_nginx
COMPUTER_WORKSPACE_DIR=./computer-project-workspace
COMPUTER_LOG_DIR=./computer_logs

# ==================== Build ====================
MAX_BUILD_CONCURRENCY=20
DEV_SERVER_PORT_TIMEOUT=5000
DEV_SERVER_STOP_TIMEOUT=5000
DEV_SERVER_STOP_CHECK_INTERVAL=100
DEV_SERVER_STOP_MAX_ATTEMPTS=50

# ==================== Uploads ====================
MAX_INLINE_FILE_SIZE_BYTES=1048576
UPLOAD_MAX_FILE_SIZE_BYTES=1048576000
UPLOAD_ALLOWED_EXTENSIONS=.zip
UPLOAD_SINGLE_FILE_SIZE_BYTES=1048576000

# ==================== Traversal / filters ====================
TRAVERSE_EXCLUDE_DIRS=dist,node_modules,.pnpm-store,__MACOSX,.attachments
BACKUP_TRAVERSE_EXCLUDE_FILES=pnpm-lock.yaml,yarn.lock,package-lock.json
CONTENT_TRAVERSE_EXCLUDE_FILES=AGENT.md,AGENTS.md,CLAUDE.md,pnpm-lock.yaml,yarn.lock,package-lock.json
INLINE_IMAGE_EXTENSIONS=.png,.jpg,.jpeg,.gif,.bmp,.svg,.ico,.webp,.avif
TOP_LEVEL_NOISE_PATTERNS=__MACOSX,Thumbs.db,node_modules,.pnpm-store,.attachments

# ==================== pnpm prune ====================
PNPM_PRUNE_ENABLED=false
PNPM_PRUNE_SCHEDULE=0 2 * * *
PNPM_PRUNE_TIMEZONE=Asia/Shanghai
PNPM_PRUNE_RUN_ON_START=false

# ==================== Log cache ====================
LOG_CACHE_ENABLED=true
LOG_CACHE_DURATION=180000
LOG_CACHE_MAX_ENTRIES=100
LOG_CACHE_MAX_FILE_SIZE=2097152

# ==================== CLI ====================
CLI_PID_DIR=./tmp
CLI_STOP_TIMEOUT=30000
CLI_CHECK_INTERVAL=500
CLI_LOG_DIR=./tmp/logs
```

### Kubernetes example

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

## Verifying configuration

```bash
curl http://localhost:60000/health
```

The JSON body includes the active environment name (e.g. `"env": "production"`).

## Troubleshooting

### Changes not applied

1. Confirm the correct env file path and `NODE_ENV`.
2. Variable names are case-sensitive.
3. Validate YAML/JSON if you embed config in manifests.
4. Read server logs for load errors.

### Port already in use

If `PORT` is taken, startup fails. Pick another port or free the listener.

### Permissions

Ensure log and data directories are writable:

```bash
chmod -R 755 /path/to/logs
mkdir -p /path/to/logs /path/to/projects
```

### Docker env not visible

Pass variables with `environment:` or `envFrom:`:

```yaml
environment:
  - NODE_ENV=production
  - PORT=60000

envFrom:
  - configMapRef:
      name: my-config
```

## Related docs

- [README.md](../README.md) — Overview
- [PNPM_CHECK.md](./PNPM_CHECK.md) — pnpm disk usage helper
