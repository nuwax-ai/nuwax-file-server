#!/usr/bin/env node

/**
 * nuwax-file-server 发 npm 前编译脚本（ESM）
 *
 * 使用方法:
 *   - 发布（默认）: node scripts/build.js
 *   - 本地调试: node scripts/build.js --all
 *
 * env 文件位于 src/，构建时复制 env.development、env.production 到 dist/
 * 使用 --all 参数会额外复制其余 src/env.*（如 env.test）
 */

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const projectRoot = path.resolve(__dirname, "..");
const distRoot = path.join(projectRoot, "dist");

const pkgPath = path.join(projectRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version;

// 获取命令行参数
const args = process.argv.slice(2);
const debugMode = args.includes("--all");

/**
 * 递归查找目录下所有 .js 文件
 */
function findJsFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) findJsFiles(fullPath, files);
    else if (e.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

/**
 * 使用 esbuild 压缩 JS 文件
 * @param {string} dir 目标目录
 * @param {object} esbuild esbuild 实例
 */
async function compressJsFiles(esbuild, dir) {
  if (!fs.existsSync(dir)) return;

  const jsFiles = findJsFiles(dir);
  let totalSaved = 0;

  for (const file of jsFiles) {
    const code = fs.readFileSync(file, "utf8");
    const result = await esbuild.transform(code, {
      minify: true,
      target: "node22",
    });
    fs.writeFileSync(file, result.code, "utf8");
    const originalSize = Buffer.byteLength(code, "utf8");
    const compressedSize = Buffer.byteLength(result.code, "utf8");
    const saved = originalSize - compressedSize;
    totalSaved += saved;
    console.log(`[build] 压缩 ${path.relative(distRoot, file)}: ${(originalSize / 1024).toFixed(1)}KB -> ${(compressedSize / 1024).toFixed(1)}KB`);
  }
  console.log(`[build] 压缩 ${path.relative(distRoot, dir)} 完成，节省 ${(totalSaved / 1024).toFixed(1)}KB`);
}

/**
 * 复制单个文件
 */
function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/**
 * 复制目录内容（不包含顶层目录）
 * srcDir/abc/xyz.js -> destDir/abc/xyz.js
 */
function copyDirContentsSync(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;

  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const e of entries) {
    const srcPath = path.join(srcDir, e.name);
    const destPath = path.join(destDir, e.name);

    if (e.isDirectory()) {
      copyDirContentsSync(srcPath, destPath);
    } else if (e.isFile() && e.name.endsWith(".js")) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function build() {
  const esbuild = (await import("esbuild")).default;

  // ---------- 0. 清理旧目录 ----------
  const oldSrcDir = path.join(distRoot, "src");
  if (fs.existsSync(oldSrcDir)) {
    fs.rmSync(oldSrcDir, { recursive: true, force: true });
    console.log("[build] 已删除旧 src/ 目录");
  }

  // ---------- 1. 打包 CLI ----------
  await esbuild.build({
    entryPoints: [path.join(projectRoot, "src", "cli.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    outfile: path.join(distRoot, "cli.js"),
    format: "esm",
    external: ["commander", "cross-spawn", "fs-extra", "tree-kill"],
    define: { __BUILD_VERSION__: JSON.stringify(version) },
    minify: true,
    sourcemap: false,
  });
  console.log("[build] 已输出 dist/cli.js");

  // ---------- 2. 复制 src 下的子目录到 dist 根目录 ----------
  // appConfig/* -> dist/appConfig/*  应用配置（环境变量等）
  // config/* -> dist/config/*        Swagger/API 文档
  // routes/* -> dist/routes/*
  // scheduler/* -> dist/scheduler/*
  // service/* -> dist/service/*
  // utils/* -> dist/utils/*
  // server.js -> dist/server.js（单独复制）

  const srcRoot = path.join(projectRoot, "src");

  // 复制子目录（与 src 结构同步：appConfig、routes、scheduler、service、utils）
  const subdirs = ["appConfig", "routes", "scheduler", "service", "utils"];
  for (const subdir of subdirs) {
    const srcPath = path.join(srcRoot, subdir);
    const destPath = path.join(distRoot, subdir);
    copyDirContentsSync(srcPath, destPath);
    console.log(`[build] 已复制 ${subdir}/ -> dist/${subdir}/`);
  }

  // 单独复制 src/config/ 下的 swagger 相关文件（移除遗留的 dist/config/index.js，应用配置已迁至 appConfig）
  const srcConfigPath = path.join(srcRoot, "config");
  const destConfigPath = path.join(distRoot, "config");
  const legacyConfigIndex = path.join(destConfigPath, "index.js");
  if (fs.existsSync(legacyConfigIndex)) fs.rmSync(legacyConfigIndex);
  copyDirContentsSync(srcConfigPath, destConfigPath);
  console.log(`[build] 已复制 config/ -> dist/config/`);

  // 单独复制 server.js 到 dist 根目录（无需修改导入路径，源码已用 ./appConfig）
  const serverJsSrc = path.join(srcRoot, "server.js");
  const serverJsDest = path.join(distRoot, "server.js");
  copyFileSync(serverJsSrc, serverJsDest);
  console.log("[build] 已复制 server.js -> dist/");

  // ---------- 3. 压缩 dist 下所有 JS 文件（CLI 除外） ----------
  const distJsFiles = findJsFiles(distRoot);
  let totalSaved = 0;

  for (const file of distJsFiles) {
    // 跳过已压缩的 cli.js
    if (path.basename(file) === "cli.js") continue;

    const code = fs.readFileSync(file, "utf8");
    const result = await esbuild.transform(code, {
      minify: true,
      target: "node22",
    });
    fs.writeFileSync(file, result.code, "utf8");
    const originalSize = Buffer.byteLength(code, "utf8");
    const compressedSize = Buffer.byteLength(result.code, "utf8");
    const saved = originalSize - compressedSize;
    totalSaved += saved;
    console.log(`[build] 压缩 ${path.relative(distRoot, file)}: ${(originalSize / 1024).toFixed(1)}KB -> ${(compressedSize / 1024).toFixed(1)}KB`);
  }
  console.log(`[build] 压缩完成，共节省 ${(totalSaved / 1024).toFixed(1)}KB`);

  // ---------- 4. 复制 env 文件（从 src/ 到 dist/） ----------
  // 发布包需包含 development + production，以便 CLI --env production 能正常启动
  const envToShip = ["env.development", "env.production"];
  for (const envFile of envToShip) {
    const src = path.join(srcRoot, envFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(distRoot, envFile));
      console.log(`[build] 已复制 ${envFile} -> dist/`);
    }
  }

  // 调试模式下额外复制其余 env.*（如 env.test）
  if (debugMode) {
    const envFiles = fs.readdirSync(srcRoot).filter((f) => f.startsWith("env."));
    for (const envFile of envFiles) {
      if (!envToShip.includes(envFile)) {
        fs.copyFileSync(path.join(srcRoot, envFile), path.join(distRoot, envFile));
        console.log(`[build] 已复制 ${envFile} -> dist/`);
      }
    }
  }

  // ---------- 5. 输出启动说明 ----------
  console.log("");
  console.log("[build] =========================================");
  console.log("[build] 构建完成！");
  console.log("[build] =========================================");
  console.log("[build] 启动服务: cd dist && node server.js");
  console.log("[build] 或使用 CLI: node cli.js start");
  console.log("");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
