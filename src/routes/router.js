import express from "express";
import buildRouter from "./buildRoutes.js";
import projectRouter from "./projectRoutes.js";
import codeRouter from "./codeRoutes.js";
import computerRouter from "./computerRoutes.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 package.json 获取版本号（使用绝对路径确保跨场景兼容）
let version = "1.0.0";
try {
  const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  version = packageJson.version || "1.0.0";
} catch (err) {
  // 使用默认值
}

const router = express.Router();

router.get("/", (req, res) => {
  res.send("Hello");
});

router.get("/health", (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const memoryUsage = process.memoryUsage();
  const memory = {
    heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024 * 100) / 100,
    rss: Math.round(memoryUsage.rss / 1024 / 1024 * 100) / 100,
    external: Math.round(memoryUsage.external / 1024 / 1024 * 100) / 100,
  };
  const healthData = {
    status: "ok",
    timestamp: Date.now(),
    uptime: uptimeSeconds,
    version: version,
    platform: process.platform,
    nodeVersion: process.version,
    pid: process.pid,
    memory: memory,
    env: process.env.NODE_ENV || "unknown",
  };
  res.json(healthData);
});

router.use("/api/build", buildRouter);
router.use("/api/project", projectRouter);
router.use("/api/project", codeRouter);
router.use("/api/computer", computerRouter);

export default router;
