import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";

/**
 * 工作空间项目上下文：按项目类型 + appId 定位工作空间。
 *
 * - userapp：工作空间 {USERAPP_WORKSPACE_DIR}/{appId}，日志 {USERAPP_LOG_DIR}
 * - pageapp / general：沿用原路径 {COMPUTER_WORKSPACE_DIR}/{userId}/{cId}（日志为其下 .logs/）
 *
 * 项目类型来源：header x-service-type（java 端 userapp 调用必带）优先，
 * body/query 的 serviceType 兜底，缺省 general（兼容未改造的调用方）。
 */

export const SERVICE_TYPE = {
  USERAPP: "userapp",
  PAGEAPP: "pageapp",
  GENERAL: "general",
};

/**
 * 从请求中解析项目上下文。
 * @param {import("express").Request} req
 * @returns {{ serviceType: string, appId: string|null, isUserApp: boolean }}
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

  return { serviceType, appId, isUserApp: serviceType === SERVICE_TYPE.USERAPP };
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
 */
export function resolveWorkspaceDir(service, userId, cId) {
  if (service?.isUserApp) {
    return path.join(resolveWorkspaceRoot(service), String(service.appId));
  }
  return path.join(config.COMPUTER_WORKSPACE_DIR, String(userId), String(cId));
}

/**
 * 确保工作空间根目录存在并返回工作空间目录（对齐原 ensureWorkspaceRoot 行为）。
 * userapp 的工作空间由部署侧按 appId 挂载，目录不存在视为挂载缺失，直接抛错而不是在容器本地创建。
 */
export async function ensureWorkspaceDir(service, userId, cId, logId = "computer") {
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
 * 其余为工作空间下 .logs/。general 且 COMPUTER_WORKSPACE_DIR 未配置时返回 null（由调用方按未配置处理）。
 */
export function resolveLogDir(service, userId, cId) {
  if (service?.isUserApp) {
    return requireUserAppDir(config.USERAPP_LOG_DIR, "USERAPP_LOG_DIR");
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
