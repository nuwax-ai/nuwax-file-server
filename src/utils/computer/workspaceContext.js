import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";

/**
 * 工作空间项目上下文：按项目类型 + appId 定位工作空间。
 *
 * - 项目绑定目录（workspaceDir，跨平台绝对路径：POSIX /a/b、Windows 盘符 C:/a/b、UNC //server/share/a/b）：
 *   非空时工作空间直接使用该目录；空则按默认规则：
 *   - userapp：工作空间 {USERAPP_WORKSPACE_DIR}/{appId}，日志 {USERAPP_LOG_DIR}
 *   - pageapp / general：沿用原路径 {COMPUTER_WORKSPACE_DIR}/{userId}/{cId}（日志为其下 .logs/）
 * - workspaceDir 仅做格式校验（绝对路径、无 . / .. 穿越片段、无非法字符），不限制根目录范围。
 *
 * 项目类型来源：header x-service-type（java 端 userapp 调用必带）优先，
 * body/query 的 serviceType 兜底，缺省 general（兼容未改造的调用方）。
 * workspaceDir 来源：body/query 的 workspaceDir，或 header x-workspace-dir。
 */

export const SERVICE_TYPE = {
  USERAPP: "userapp",
  PAGEAPP: "pageapp",
  GENERAL: "general",
};

/**
 * 从请求中解析项目上下文。
 * @param {import("express").Request} req
 * @returns {{ serviceType: string, appId: string|null, workspaceDir: string|null, isUserApp: boolean }}
 */
export function resolveServiceContext(req) {
  const headerType = req.headers && typeof req.headers["x-service-type"] === "string"
    ? req.headers["x-service-type"].trim().toLowerCase()
    : "";
  const bodyType = (req.body?.serviceType ?? req.query?.serviceType ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const serviceType = headerType || bodyType || SERVICE_TYPE.GENERAL;

  const rawAppId =
    (typeof req.headers?.["x-app-id"] === "string" && req.headers["x-app-id"].trim()) ||
    (req.body?.appId ?? req.query?.appId ?? "").toString().trim() ||
    null;
  const appId = rawAppId || null;

  if (serviceType === SERVICE_TYPE.USERAPP && !appId) {
    throw new ValidationError("appId is required for userapp workspace", {
      field: "appId",
    });
  }
  if (serviceType === SERVICE_TYPE.USERAPP && !isValidAppId(appId)) {
    throw new ValidationError("appId contains illegal path segments", {
      field: "appId",
    });
  }

  const rawWorkspaceDir =
    (typeof req.headers?.["x-workspace-dir"] === "string" && req.headers["x-workspace-dir"].trim()) ||
    (req.body?.workspaceDir ?? req.query?.workspaceDir ?? "").toString().trim() ||
    null;
  const workspaceDir = rawWorkspaceDir ? normalizeWorkspaceDir(rawWorkspaceDir) : null;

  return { serviceType, appId, workspaceDir, isUserApp: serviceType === SERVICE_TYPE.USERAPP };
}

/** appId 直接参与路径拼接（{根目录}/{appId}），禁止路径分隔符与 . / .. 等穿越片段 */
function isValidAppId(appId) {
  return (
    !!appId &&
    !/[\/\\\0]/.test(appId) &&
    appId !== "." &&
    appId !== ".."
  );
}

/**
 * 项目绑定目录校验并归一化：跨平台绝对路径（POSIX /a/b、Windows 盘符 C:/a/b、UNC //server/share/a/b），
 * 无 . / .. 片段、无非法字符；分隔符统一规范为 /（Windows 侧 fs/API 均接受正斜杠）、盘符统一大写。
 * 只做格式校验，不限制目录范围（通用产品，用户可绑定沙箱内任意绝对路径）。
 * @param {string} rawDir
 * @returns {string} 归一化后的绝对路径
 */
function normalizeWorkspaceDir(rawDir) {
  let dir = String(rawDir).trim();
  if (dir.length > 512) {
    throw new ValidationError("workspaceDir length exceeds 512", {
      field: "workspaceDir",
    });
  }
  if (/[\0\x00-\x1f\x7f]/.test(dir)) {
    throw new ValidationError("workspaceDir contains illegal characters", {
      field: "workspaceDir",
    });
  }
  dir = canonicalizeDir(dir);
  if (!dir.startsWith("/") && !/^[A-Za-z]:\/.*/.test(dir)) {
    throw new ValidationError(
      "workspaceDir must be an absolute path (POSIX /a/b, Windows C:/a/b or UNC //server/share/a/b)",
      { field: "workspaceDir" }
    );
  }
  if (dir.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new ValidationError("workspaceDir must not contain dot segments", {
      field: "workspaceDir",
    });
  }
  return dir;
}

/** 分隔符统一为 / 并折叠连续分隔符（保留 UNC 的前导 //）；Windows 盘符统一大写（大小写不敏感），不做宿主机语义解析 */
function canonicalizeDir(dir) {
  const unc = dir.startsWith("//") || dir.startsWith("\\\\");
  let collapsed = dir.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (unc) {
    collapsed = "/" + collapsed;
  }
  if (/^[a-z]:\//.test(collapsed)) {
    collapsed = collapsed.charAt(0).toUpperCase() + collapsed.slice(1);
  }
  return collapsed;
}

function requireUserAppDir(envValue, fieldName) {
  if (!envValue) {
    throw new ValidationError(`${fieldName} configuration does not exist`, {
      field: fieldName,
    });
  }
  return envValue;
}

/**
 * 计算工作空间根目录（userapp 为 USERAPP_WORKSPACE_DIR，其余为 COMPUTER_WORKSPACE_DIR），不创建目录。
 */
export function resolveWorkspaceRoot(service) {
  if (service?.isUserApp) {
    return requireUserAppDir(config.USERAPP_WORKSPACE_DIR, "USERAPP_WORKSPACE_DIR");
  }
  return config.COMPUTER_WORKSPACE_DIR;
}

/**
 * 计算工作空间目录（纯路径计算，不创建、不校验根目录存在）。
 * 项目绑定了 workspaceDir 时直接使用该目录，替代按类型定位的默认规则。
 */
export function resolveWorkspaceDir(service, userId, cId) {
  if (service?.workspaceDir) {
    return service.workspaceDir;
  }
  if (service?.isUserApp) {
    return path.join(resolveWorkspaceRoot(service), String(service.appId));
  }
  return path.join(config.COMPUTER_WORKSPACE_DIR, String(userId), String(cId));
}

/**
 * 确保工作空间根目录存在并返回工作空间目录（对齐原 ensureWorkspaceRoot 行为）。
 * userapp 的工作空间由部署侧按 appId 挂载，目录不存在视为挂载缺失，直接抛错而不是在容器本地创建；
 * 项目绑定目录（workspaceDir）非默认挂载体系，不存在时直接创建。
 */
export async function ensureWorkspaceDir(service, userId, cId, logId = "computer") {
  if (service?.workspaceDir) {
    const boundDir = service.workspaceDir;
    if (!fs.existsSync(boundDir)) {
      await fs.promises.mkdir(boundDir, { recursive: true });
      log(logId, "INFO", "Created bound workspace directory", { boundDir });
    }
    return boundDir;
  }

  const workspaceRoot = resolveWorkspaceRoot(service);

  if (!workspaceRoot) {
    throw new ValidationError("COMPUTER_WORKSPACE_DIR configuration does not exist", {
      field: "COMPUTER_WORKSPACE_DIR",
    });
  }

  if (!fs.existsSync(workspaceRoot)) {
    await fs.promises.mkdir(workspaceRoot, { recursive: true });
    log(logId, "INFO", "Created user workspace root directory", { workspaceRoot });
  }

  if (service?.isUserApp) {
    const appDir = path.join(workspaceRoot, String(service.appId));
    if (!fs.existsSync(appDir)) {
      throw new ValidationError(`userapp workspace mount does not exist: ${appDir}`, {
        field: "USERAPP_WORKSPACE_DIR",
      });
    }
    return appDir;
  }
  return path.join(workspaceRoot, String(userId), String(cId));
}

/**
 * 计算日志目录：userapp 直接使用 {USERAPP_LOG_DIR}（env 已是按 appId 挂载的具体路径），
 * 其余为工作空间下 .logs/（含项目绑定目录：日志跟随工作空间）。
 * general 且 COMPUTER_WORKSPACE_DIR 未配置时返回 null（由调用方按未配置处理）。
 */
export function resolveLogDir(service, userId, cId) {
  if (service?.isUserApp) {
    return requireUserAppDir(config.USERAPP_LOG_DIR, "USERAPP_LOG_DIR");
  }
  if (service?.workspaceDir) {
    return path.join(service.workspaceDir, ".logs");
  }
  if (!config.COMPUTER_WORKSPACE_DIR) {
    return null;
  }
  return path.join(
    config.COMPUTER_WORKSPACE_DIR,
    String(userId),
    String(cId),
    ".logs"
  );
}
