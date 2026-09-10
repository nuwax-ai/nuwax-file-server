import fs from "fs";
import path from "path";
import config from "../../appConfig/index.js";
import { log } from "../log/logUtils.js";
import { ValidationError } from "../error/errorHandler.js";

/**
 * 工作空间项目上下文：按项目类型 + appId 定位工作空间。
 *
 * - 用户维度工作目录（workspacePath，优先认传入；空则按类型默认规则）：
 *   - userapp（子容器）：{USERAPP_WORKSPACE_DIR}/{appId}，日志 {USERAPP_LOG_DIR}
 *   - normalProject（常规项目，主容器）：{COMPUTER_WORKSPACE_DIR}/{userId}/NormalProject/{projectId}
 *   - generalAgent（通用智能体，主容器）：{COMPUTER_WORKSPACE_DIR}/{userId}/{cId}
 *   - pageapp：沿用 {COMPUTER_WORKSPACE_DIR}/{userId}/{cId}
 * - workspacePath 仅做格式校验（绝对路径、无 . / .. 穿越片段、无非法字符），不限制根目录范围。
 *
 * 项目类型来源：header x-service-type 优先，body/query 的 serviceType 兜底，缺省 generalAgent
 * （兼容旧调用方：general 按 generalAgent 处理）。projectId 复用 appId 参数（userapp/normalProject 必带）。
 * workspacePath 来源：body/query 的 workspacePath，或 header x-workspace-path。
 */

export const SERVICE_TYPE = {
  USERAPP: "userapp",
  PAGEAPP: "pageApp",
  NORMAL_PROJECT: "normalProject",
  GENERAL_AGENT: "generalAgent",
};

/**
 * 从请求中解析项目上下文。
 * @param {import("express").Request} req
 * @returns {{ serviceType: string, appId: string|null, workspacePath: string|null, isUserApp: boolean, isNormalProject: boolean }}
 */
export function resolveServiceContext(req) {
  const headerType = req.headers && typeof req.headers["x-service-type"] === "string"
    ? req.headers["x-service-type"].trim()
    : "";
  const bodyType = (req.body?.serviceType ?? req.query?.serviceType ?? "")
    .toString()
    .trim();
  // 大小写不敏感归一到规范值；兼容旧调用方：general 按 generalAgent 处理
  const normalizedType = (t) => {
    const key = t.toLowerCase();
    if (key === "general") {
      return SERVICE_TYPE.GENERAL_AGENT;
    }
    return Object.values(SERVICE_TYPE).find((v) => v.toLowerCase() === key) || "";
  };
  const serviceType = normalizedType(headerType) || normalizedType(bodyType) || SERVICE_TYPE.GENERAL_AGENT;

  const rawAppId =
    (typeof req.headers?.["x-app-id"] === "string" && req.headers["x-app-id"].trim()) ||
    (req.body?.appId ?? req.query?.appId ?? "").toString().trim() ||
    null;
  const appId = rawAppId || null;
  const isUserApp = serviceType === SERVICE_TYPE.USERAPP;
  const isNormalProject = serviceType === SERVICE_TYPE.NORMAL_PROJECT;

  if (isUserApp && !appId) {
    throw new ValidationError("appId is required for userapp workspace", {
      field: "appId",
    });
  }
  if (isNormalProject && !appId) {
    throw new ValidationError("appId(projectId) is required for normalProject workspace", {
      field: "appId",
    });
  }
  if (isUserApp && !isValidAppId(appId)) {
    throw new ValidationError("appId contains illegal path segments", {
      field: "appId",
    });
  }

  const rawWorkspacePath =
    (typeof req.headers?.["x-workspace-path"] === "string" && req.headers["x-workspace-path"].trim()) ||
    (req.body?.workspacePath ?? req.query?.workspacePath ?? "").toString().trim() ||
    null;
  const workspacePath = rawWorkspacePath ? normalizeWorkspacePath(rawWorkspacePath) : null;

  return { serviceType, appId, workspacePath, isUserApp, isNormalProject };
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
function normalizeWorkspacePath(rawDir) {
  let dir = String(rawDir).trim();
  if (dir.length > 512) {
    throw new ValidationError("workspacePath length exceeds 512", {
      field: "workspacePath",
    });
  }
  if (/[\0\x00-\x1f\x7f]/.test(dir)) {
    throw new ValidationError("workspacePath contains illegal characters", {
      field: "workspacePath",
    });
  }
  dir = canonicalizeDir(dir);
  if (!dir.startsWith("/") && !/^[A-Za-z]:\/.*/.test(dir)) {
    throw new ValidationError(
      "workspacePath must be an absolute path (POSIX /a/b, Windows C:/a/b or UNC //server/share/a/b)",
      { field: "workspacePath" }
    );
  }
  if (dir.split("/").some((seg) => seg === "." || seg === "..")) {
    throw new ValidationError("workspacePath must not contain dot segments", {
      field: "workspacePath",
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
 * 传入 workspacePath 时直接使用该目录（优先认传入），替代按类型定位的默认规则。
 */
export function resolveWorkspaceDir(service, userId, cId) {
  if (service?.workspacePath) {
    return service.workspacePath;
  }
  if (service?.isUserApp) {
    return path.join(resolveWorkspaceRoot(service), String(service.appId));
  }
  // 常规项目（主容器）：{root}/{userId}/NormalProject/{projectId}（projectId 复用 appId 参数）
  if (service?.isNormalProject) {
    return path.join(config.COMPUTER_WORKSPACE_DIR, String(userId), "NormalProject", String(service.appId));
  }
  // 通用智能体 / pageapp（主容器）
  return path.join(config.COMPUTER_WORKSPACE_DIR, String(userId), String(cId));
}

/**
 * 确保工作空间根目录存在并返回工作空间目录（对齐原 ensureWorkspaceRoot 行为）。
 * userapp 的工作空间由部署侧按 appId 挂载，目录不存在视为挂载缺失，直接抛错而不是在容器本地创建；
 * 绑定目录（workspacePath）非默认挂载体系，不存在时直接创建。
 */
export async function ensureWorkspaceDir(service, userId, cId, logId = "computer") {
  if (service?.workspacePath) {
    const boundDir = service.workspacePath;
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
  // 常规项目/通用智能体按类型默认规则定位并确保目录存在
  const dir = resolveWorkspaceDir(service, userId, cId);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  return dir;
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
  if (!config.COMPUTER_WORKSPACE_DIR) {
    return null;
  }
  // 日志跟随工作空间（含传入目录与按类型默认规则）
  return path.join(resolveWorkspaceDir(service, userId, cId), ".logs");
}
