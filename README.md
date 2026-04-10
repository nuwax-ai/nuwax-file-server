# nuwax-file-server

Cross-platform file service deployment tooling for Windows, Linux, and macOS.

## Features

- **CLI**: `start`, `stop`, `restart`, `status`
- **Cross-platform**: Windows, Linux, and macOS
- **Configuration**: Environment variables and CLI flags
- **Health endpoint**: `GET /health` for liveness checks
- **PID file**: Tracks and manages the server process

## Installation

### Local development

```bash
git clone <repository-url>
cd nuwax-file-server

npm install

# Development mode
npm run dev

# Production mode (local)
npm run prod
```

### Global CLI install

```bash
# From the project root
npm install -g .

# Then run from anywhere
nuwax-file-server --help
```

### Requirements

- Node.js >= 22.0.0 (native ES modules)
- zip/unzip (for project archives)
- pnpm (recommended) or npm/yarn

## CLI

Available commands:

### Basics

```bash
# Start (defaults to env.production)
nuwax-file-server start

# Start with a specific env
nuwax-file-server start --env development
nuwax-file-server start --env production
nuwax-file-server start --env test

# Stop
nuwax-file-server stop

# Force stop
nuwax-file-server stop --force

# Restart
nuwax-file-server restart

# Status
nuwax-file-server status
```

### Advanced

```bash
# Custom port
nuwax-file-server start --port 8080

# Custom config file
nuwax-file-server start --config /path/to/config.json

# Combined
nuwax-file-server start --env development --port 3000
```

### npm scripts

```bash
npm run cli:start
npm run cli:start:dev    # development
npm run cli:start:prod   # production
npm run cli:start:test   # test

npm run cli:stop
npm run cli:restart
npm run cli:status
```

## Environment variables

Full reference: [Environment variables](./docs/ENV.md)

### Quick example

```bash
# Defaults from env.production (typical)
nuwax-file-server start --env production --port 60000

# Override paths (trim to what you need)
nuwax-file-server start --env production --port 60000 \
  PROJECT_SOURCE_DIR=/data/projects \
  DIST_TARGET_DIR=/var/www/html \
  UPLOAD_PROJECT_DIR=/data/uploads
```

### Core path variables

| Variable | Purpose |
| -------- | ------- |
| `INIT_PROJECT_DIR` | Scaffold / init project directory |
| `UPLOAD_PROJECT_DIR` | Uploaded project archives |
| `PROJECT_SOURCE_DIR` | Project source tree |
| `DIST_TARGET_DIR` | Build output (e.g. nginx root) |
| `LOG_BASE_DIR` | Log directory root |
| `COMPUTER_WORKSPACE_DIR` | “Computer” workspace |
| `COMPUTER_LOG_DIR` | “Computer” logs |

More options and scenarios: [Environment variables](./docs/ENV.md)

### CLI precedence

```bash
# Port: CLI > env > default
nuwax-file-server start --env production --port 8080
```

## Health check

The server exposes `GET /health` for monitoring and probes.

### Request

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

### Response fields

| Field | Type | Description |
| ----- | ---- | ----------- |
| status | string | `"ok"` when healthy |
| timestamp | number | Unix time (ms) |
| uptime | number | Uptime in seconds |
| version | string | Server version |
| platform | string | `darwin` / `linux` / `win32` |
| nodeVersion | string | Node.js version |
| pid | number | Process ID |
| memory | object | Memory usage (MB) |
| env | string | Active environment name |

## Cross-platform notes

### Windows

- PID file under `%TEMP%\nuwax-file-server\`
- Stop uses `taskkill /F /PID`
- Paths use backslashes `\`

### Linux / macOS

- PID file under `/tmp/nuwax-file-server/`
- Stop uses signals (SIGTERM / SIGKILL)
- Paths use `/`

### General

- Paths built with `path.join()`
- Temp dir from `os.tmpdir()`
- Shell commands via `cross-spawn`
- Process trees via `tree-kill`

## pnpm disk usage

Created, uploaded, or copied projects get an optimized `.npmrc` to reduce pnpm disk footprint.

### Automatic injection

`.npmrc` is applied when:

- **Create project** (`/create-project`)
- **Upload project** (`/upload-project`)
- **Copy project** (`/copy-project`)

### Inspect disk usage

```bash
npm run pnpm:check

npm run pnpm:check:dev   # development
npm run pnpm:check:prod  # production
npm run pnpm:check:test  # test

bash scripts/pnpm-check.sh /path/to/projects
```

### Prune unused packages

```bash
npm run pnpm:prune

npm run pnpm:prune:log
```

### Scheduled prune (built-in)

The app can run a cron-style prune job. Configure with env vars, for example:

```yaml
# docker-compose.yml or .env
environment:
  PNPM_PRUNE_ENABLED: "true"
  PNPM_PRUNE_SCHEDULE: "0 2 * * 0"
  PNPM_PRUNE_TIMEZONE: "Asia/Shanghai"
  PNPM_PRUNE_RUN_ON_START: "false"
```

**Example schedules:**

```bash
"0 2 * * 0"    # Sunday 02:00
"0 3 * * *"    # Daily 03:00
"0 2 1 * *"    # 1st of month 02:00
"0 */6 * * *"  # Every 6 hours
```

### Expected benefits

- Lower disk use when many projects share dependencies (often a large share of savings vs naive installs)
- Faster installs when using a nearby registry mirror
- Automated `.npmrc`; periodic store maintenance when enabled

## Troubleshooting

### Server will not start

1. Check the port is free
2. Check log directory permissions
3. Confirm env files exist

```bash
nuwax-file-server start --env development
```

### Server will not stop

```bash
nuwax-file-server stop --force

ps aux | grep nuwax-file-server
kill -9 <pid>
```

### Health check fails

1. Confirm the process is running
2. Confirm host/port
3. Check firewall rules

```bash
nuwax-file-server status
curl http://localhost:60000/health
```

## Development

### Adding a command

In `src/cli.js`, use Commander:

```javascript
program
  .command("newcommand")
  .description("Description of the new command")
  .option("--option", "Option description")
  .action((options) => {
    // handler
  });
```

### Adding a setting

1. Add variables to `src/env.development` / `src/env.production` / `src/env.test`
2. Wire them through `src/appConfig/index.js` as needed
3. Document the change

## License

ISC
