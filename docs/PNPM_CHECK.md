# pnpm-check usage

## Overview

The `pnpm-check` script inspects and analyzes pnpm disk usage. It supports multiple environment configurations.

## How to run

### Option 1: npm scripts (recommended)

The script reads the project directory from the current `NODE_ENV` configuration.

```bash
# Auto-detect current environment (defaults to development)
npm run pnpm:check

# Development
npm run pnpm:check:dev

# Production
npm run pnpm:check:prod

# Test
npm run pnpm:check:test
```

### Option 2: Wrapper script

```bash
# Use current environment variables
node scripts/pnpm-check-wrapper.js

# Pin environment
NODE_ENV=production node scripts/pnpm-check-wrapper.js
```

### Option 3: Bash script directly

```bash
# Pass project directory explicitly
bash scripts/pnpm-check.sh /path/to/projects

# Via environment variable
PROJECT_SOURCE_DIR=/path/to/projects bash scripts/pnpm-check.sh
```

## Output

### 1. pnpm version

```
✅ pnpm version: 10.18.2
```

Shows the installed pnpm version.

### 2. pnpm store

```
📁 pnpm Store path:
   /Users/xxx/.pnpm-store
   Store size: 2.5G
```

- **Store path**: Global content-addressable store location
- **Store size**: **Actual disk usage**; all projects share this store

### 3. Store status

```
📊 pnpm Store status:
Packages in the store are untouched
```

Shows how packages in the store are used (`pnpm store status`).

### 4. Per-project `node_modules` size

```
📦 Per-project node_modules (apparent size):
   ⚠️  Note: du double-counts hard links; real usage is much lower
   [project-a] 500MB (includes hard-link double counting)
   [project-b] 500MB (includes hard-link double counting)
```

⚠️ **Important**: Figures come from `du` and **double-count hard links**; real usage is usually much lower.

### 5. `.pnpm` folder size

```
🗂️  Per-project .pnpm folders (apparent size):
   ⚠️  Note: entries in .pnpm are hard links; little extra space per project
   [project-a] 400MB (hard links, shared in store)
   [project-b] 400MB (hard links, shared in store)
```

⚠️ **Important**: Files under `.pnpm` are hard links; they do not each consume separate space on disk.

### 6. Real disk usage

```
💾 Filesystem usage (df):
   Filesystem: /dev/disk1 | Used: 150GB | Avail: 200GB | Use%: 43%
```

Using `df` on the filesystem is the most reliable way to see actual free space.
