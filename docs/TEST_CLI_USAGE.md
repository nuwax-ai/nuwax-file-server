# test-cli.sh usage

`test-cli.sh` is the CLI automation test script for nuwax-file-server. It verifies locally that `nuwax-file-server` can start, report status, answer health checks, restart, and stop.

---

## Quick start

```bash
# Grant execute permission (first time only)
chmod +x scripts/test-cli.sh

# Default: pnpm install + pnpm link, then test
./scripts/test-cli.sh

# Run dist directly (no global link)
./scripts/test-cli.sh --direct

# Already installed globally; skip install steps
./scripts/test-cli.sh --installed
```

---

## Requirements

| Dependency | Notes |
|------------|--------|
| bash | Script runtime |
| curl | Health endpoint requests |
| jq | JSON parsing |
| pnpm | Required for modes 1 and 2 (optional for mode 3) |
| node | v22+ recommended |

Install example (macOS):

```bash
brew install curl jq
# Install pnpm / node per project requirements
```

---

## Three test modes

### Mode 1: Default (pnpm link)

- **Command**: `./scripts/test-cli.sh` (no extra flags)
- **Behavior**:
  - Runs `pnpm install` in the project root
  - Runs `pnpm run build` to compile into `dist/`
  - Runs `pnpm link --global` so `nuwax-file-server` is available globally
  - Tests using the global `nuwax-file-server` command
- **Use when**: Local development, first-time verification, or when not installed globally

### Mode 2: Direct run (`--direct`)

- **Command**: `./scripts/test-cli.sh --direct`
- **Behavior**:
  - Does not run `pnpm link`; runs `node dist/cli.js` directly
  - Requires a built project: `dist/` exists and `dist/cli.js` exists
- **Prerequisite**: Run `pnpm run build` first
- **Use when**: You do not want to change global commands and only want to test the current build

### Mode 3: Installed (`--installed`)

- **Command**: `./scripts/test-cli.sh --installed`
- **Behavior**:
  - No install, no build, no link; calls the installed `nuwax-file-server` directly
  - Fails with a hint if `nuwax-file-server` is not found
- **Prerequisite**: Installed via `npm install -g nuwax-file-server` or `pnpm link --global`
- **Use when**: Verifying a global install, CI, or an environment where the CLI is already installed

---

## Command-line options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--port <port>` | `-p` | Port for the test server | `60000` |
| `--direct` | — | Mode 2: run dist with Node directly | — |
| `--installed` | — | Mode 3: use globally installed CLI | — |
| `--project-dir <dir>` | — | Project directory | `./test-projects` |
| `--nginx-dir <dir>` | — | Nginx directory | `./test-nginx` |
| `--upload-dir <dir>` | — | Upload directory | `./test-uploads` |
| `--help` | `-h` | Show help | — |

---

## Environment variables

These override defaults (equivalent to CLI options where applicable):

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `60000` |
| `PROJECT_DIR` | Project directory | `./test-projects` |
| `NGINX_DIR` | Nginx directory | `./test-nginx` |
| `UPLOAD_DIR` | Upload directory | `./test-uploads` |

Example:

```bash
PORT=60001 ./scripts/test-cli.sh --installed
```

---

## Test flow

The script runs in order:

1. **Test 1: Start** — `start --env production --port <PORT>`, wait ~3 seconds.
2. **Test 2: Health** — `GET http://localhost:<PORT>/health`, assert `status === "ok"` in JSON.
3. **Test 3: Status** — `status`, check output looks normal.
4. **Test 4: Restart** — `restart`, wait ~3 seconds.
5. **Test 5: Health after restart** — `GET /health` again.
6. **Test 6: Stop** — `stop`.

On exit or error, cleanup runs (stop service; mode 1 also runs `pnpm unlink --global`).

---

## Examples

```bash
# Default mode, default port 60000
./scripts/test-cli.sh

# Mode 2, custom port 60001
./scripts/test-cli.sh --direct --port 60001

# Mode 3, custom port
./scripts/test-cli.sh --installed -p 60001

# Custom project/nginx/upload dirs
./scripts/test-cli.sh --project-dir ./my-projects --nginx-dir ./my-nginx --upload-dir ./my-uploads

# Help
./scripts/test-cli.sh --help
```

---

## FAQ

**Q: `dist` missing or `dist/cli.js` missing?**  
A: Run `pnpm run build` before `--direct`, or use the default mode (builds automatically).

**Q: `nuwax-file-server` command not found?**  
A: For `--installed`, install globally first, e.g. `npm install -g nuwax-file-server` or `pnpm link --global` in this repo. Or use default mode or `--direct`.

**Q: Port in use?**  
A: Use `-p`/`--port` or `PORT`, e.g. `./scripts/test-cli.sh -p 60001`.

**Q: Missing curl / jq?**  
A: The script checks dependencies and reports. On macOS: `brew install curl jq`.

---

## Related docs

- [QUICK_START.md](./QUICK_START.md) — Quick start
- [ENV.md](./ENV.md) — Environment and configuration
- [CLAUDE.md](../CLAUDE.md) / [AGENTS.md](../AGENTS.md) — Project layout and conventions
