# Quick start

This guide helps you get started with the nuwax-file-server CLI.

## 1. Local testing

From the project root:

```bash
# Install dependencies
pnpm install

# Start the server (development)
pnpm run cli:start:dev

# Check status
pnpm run cli:status

# Health check
curl http://localhost:60000/health

# Stop the server
pnpm run cli:stop
```

## 2. Global install

```bash
# Global install
npm install -g .

# or
pnpm add -g .

# Then run from any directory
nuwax-file-server start --env development
nuwax-file-server status
nuwax-file-server stop
```

## 3. Commands

| Command | Description |
| ------- | ----------- |
| `nuwax-file-server start` | Start (default: production) |
| `nuwax-file-server start --env dev` | Start (development) |
| `nuwax-file-server stop` | Stop |
| `nuwax-file-server restart` | Restart |
| `nuwax-file-server status` | Status |
| `nuwax-file-server --help` | Help |

## 4. Health check

```bash
curl http://localhost:60000/health
```

### Example response

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

## 5. Environment variables

### Defaults

```bash
# Use defaults from env.production
nuwax-file-server start --env production --port 60000
```

### Override paths

```bash
# Override path-related variables as needed
nuwax-file-server start --env production --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads
```

See the full reference: [Environment variables](./ENV.md)

## 6. Troubleshooting

### Server will not start

Check if the port is in use:

```bash
lsof -i :60000

# or
netstat -tlnp | grep 60000
```

### Stop fails

Force stop:

```bash
nuwax-file-server stop --force
```

### Logs / sanity check

```bash
nuwax-file-server status
curl http://localhost:60000/health
```

## 7. Docker

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

## 8. Tests

The repo includes several ways to exercise the CLI.

### 8.1 Run all tests

```bash
pnpm run test:run

pnpm run test:unit

pnpm run test:integration
```

### 8.2 CLI unit tests

```bash
npx jest tests/unit/cli.test.js

pnpm run test:unit -- --testPathPattern=cli.test.js
```

**Coverage areas:**

| Group | Topics |
| ----- | ------ |
| Service Manager | PID file, process state, service status |
| Environment Utils | Env resolution, typing, CLI parsing |
| Cross-Platform | Platform detection, paths |
| Config | CLI-specific config validation |

### 8.3 Manual checks

#### Development

```bash
pnpm run cli:start:dev
pnpm run cli:status
curl http://localhost:60000/health
pnpm run cli:stop
```

#### Production

```bash
pnpm run cli:start:prod
pnpm run cli:status
curl http://localhost:60000/health
pnpm run cli:restart
pnpm run cli:stop
```

#### Custom config

```bash
nuwax-file-server start --env development --port 60001

nuwax-file-server start --env development --port 60002 \
  PROJECT_SOURCE_DIR=/data/test-projects \
  DIST_TARGET_DIR=/var/www/test-nginx

nuwax-file-server status
nuwax-file-server stop
```

### 8.4 Health endpoint

```bash
curl http://localhost:60000/health

curl http://localhost:60000/health | jq

curl http://localhost:60000/health | jq '.status'
curl http://localhost:60000/health | jq '.uptime'
curl http://localhost:60000/health | jq '.memory'
```

### 8.5 Cross-platform

#### macOS / Linux

```bash
nuwax-file-server start --env production
ps aux | grep nuwax-file-server
nuwax-file-server stop
```

#### Windows

```cmd
nuwax-file-server start --env production
tasklist | findstr nuwax-file-server
nuwax-file-server stop --force
```

### 8.6 Automation script (`test-cli.sh`)

Create `test-cli.sh`:

```bash
#!/bin/bash

# nuwax-file-server CLI smoke test

set -e

echo "=== nuwax-file-server CLI test ==="

PORT=60000
HEALTH_URL="http://localhost:${PORT}/health"

test_command() {
    local cmd=$1
    local description=$2
    echo "Test: ${description}"
    echo "Command: ${cmd}"
    eval "${cmd}"
    echo "✓ done"
    echo ""
}

echo "Cleaning up..."
nuwax-file-server stop 2>/dev/null || true
sleep 1

test_command "nuwax-file-server start --env production --port ${PORT}" "start server"

sleep 3

echo "Test: health check"
curl -s "${HEALTH_URL}" | jq '.status'
echo "✓ health OK"
echo ""

test_command "nuwax-file-server status" "status"

test_command "nuwax-file-server restart" "restart"
sleep 3

echo "Test: health after restart"
curl -s "${HEALTH_URL}" | jq '.status'
echo "✓ health OK after restart"
echo ""

test_command "nuwax-file-server stop" "stop"

echo "=== All tests passed ==="
```

Run it:

```bash
chmod +x test-cli.sh
./test-cli.sh
```

## 9. Related docs

- [README.md](../README.md) — Main readme
- [ENV.md](./ENV.md) — Environment variables
- [CHANGELOG.md](../CHANGELOG.md) — Changelog
