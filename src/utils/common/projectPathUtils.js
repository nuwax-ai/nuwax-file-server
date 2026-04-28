import path from "path";
import config from "../../appConfig/index.js";

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  const str = String(value).trim();
  return str;
}

function extractIsolationContext(source = {}) {
  return {
    tenantId: normalizeValue(source.tenantId),
    spaceId: normalizeValue(source.spaceId),
    isolationType: normalizeValue(source.isolationType),
  };
}

function shouldUseIsolationPath(isolationContext = {}) {
  const tenantId = normalizeValue(isolationContext.tenantId);
  const spaceId = normalizeValue(isolationContext.spaceId);
  const isolationType = normalizeValue(isolationContext.isolationType);
  return Boolean(tenantId && spaceId && isolationType);
}

function resolveProjectPath(projectId, isolationContext = {}) {
  const normalizedProjectId = normalizeValue(projectId);
  if (!normalizedProjectId) {
    return path.join(config.PROJECT_SOURCE_DIR, "");
  }

  if (shouldUseIsolationPath(isolationContext)) {
    return path.join(
      config.PROJECT_SOURCE_DIR,
      normalizeValue(isolationContext.tenantId),
      normalizeValue(isolationContext.spaceId),
      normalizedProjectId
    );
  }

  return path.join(config.PROJECT_SOURCE_DIR, normalizedProjectId);
}

export { extractIsolationContext, shouldUseIsolationPath, resolveProjectPath };
