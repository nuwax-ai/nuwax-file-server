import express from "express";
import { asyncHandler, ValidationError } from "../utils/error/errorHandler.js";
import gitService from "../service/gitService.js";
import { log } from "../utils/log/logUtils.js";
import { extractIsolationContext } from "../utils/common/projectPathUtils.js";

const gitRouter = express.Router();

/**
 * 从请求中提取 Git 操作所需的通用参数：
 * - workspaceType: 必传，"pageApp" 或 "taskAgent"
 * - pageApp 模式：projectId + isolationContext
 * - taskAgent 模式：userId + cId
 */
function extractGitParams(source) {
  const { workspaceType, projectId, userId, cId } = source || {};
  const isolationContext = extractIsolationContext(source || {});

  return {
    workspaceType: workspaceType ? String(workspaceType) : undefined,
    projectId: projectId ? String(projectId) : undefined,
    userId: userId ? String(userId) : undefined,
    cId: cId ? String(cId) : undefined,
    isolationContext,
  };
}

// 路由配置
const routes = [
  {
    path: "/init",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const params = extractGitParams(req.body);
      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git init", params);

      const result = await gitService.init(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/status",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const params = extractGitParams(req.query);
      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git status", params);

      const result = await gitService.status(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/commit",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { message, files, authorName, authorEmail } = req.body || {};
      const params = { ...extractGitParams(req.body), message, files, authorName, authorEmail };

      if (!message) {
        throw new ValidationError("Commit message cannot be empty", { field: "message" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git commit", {
        ...params,
        filesCount: files ? files.length : "all",
      });

      const result = await gitService.commit(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/add",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { files } = req.body || {};
      const params = { ...extractGitParams(req.body), files };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git add", {
        ...params,
        filesCount: files ? files.length : "all",
      });

      const result = await gitService.add(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/unstage",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { files } = req.body || {};
      const params = { ...extractGitParams(req.body), files };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git unstage", {
        ...params,
        filesCount: files ? files.length : "all",
      });

      const result = await gitService.unstage(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/discard",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { files } = req.body || {};
      const params = { ...extractGitParams(req.body), files };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git discard", {
        ...params,
        filesCount: files ? files.length : "all",
      });

      const result = await gitService.discard(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/log",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const { maxCount, branch, skip, filePath } = req.query || {};
      const params = {
        ...extractGitParams(req.query),
        maxCount: maxCount ? parseInt(maxCount, 10) : 50,
        skip: skip ? parseInt(skip, 10) : 0,
        branch,
        filePath,
      };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git log", params);

      const result = await gitService.logHistory(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/diff",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { from, to, paths, source } = req.body || {};
      const params = { ...extractGitParams(req.body), from, to, paths, source };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git diff", { from, to });

      const result = await gitService.diff(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/file-content",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { ref, filePath } = req.body || {};
      const params = { ...extractGitParams(req.body), ref, filePath };

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git file content", { ref, filePath });

      const result = await gitService.fileContent(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/reset",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { target, mode } = req.body || {};
      const params = { ...extractGitParams(req.body), target, mode: mode || "mixed" };

      if (!target) {
        throw new ValidationError("Reset target cannot be empty", { field: "target" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git reset", { target, mode });

      const result = await gitService.reset(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/revert",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { target, message, authorName, authorEmail } = req.body || {};
      const params = { ...extractGitParams(req.body), target, message, authorName, authorEmail };

      if (!target) {
        throw new ValidationError("Revert target cannot be empty", { field: "target" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git revert", { target });

      const result = await gitService.revert(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/checkout",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { target } = req.body || {};
      const params = { ...extractGitParams(req.body), target };

      if (!target) {
        throw new ValidationError("Checkout target cannot be empty", { field: "target" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git checkout files", { target });

      const result = await gitService.checkout(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/tags",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const params = extractGitParams(req.query);
      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git list tags", params);

      const result = await gitService.listTags(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/tag-create",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { tagName, message: tagMessage } = req.body || {};
      const params = { ...extractGitParams(req.body), tagName, message: tagMessage };

      if (!tagName) {
        throw new ValidationError("Tag name cannot be empty", { field: "tagName" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git create tag", { tagName });

      const result = await gitService.createTag(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/tag-delete",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { tagName } = req.body || {};
      const params = { ...extractGitParams(req.body), tagName };

      if (!tagName) {
        throw new ValidationError("Tag name cannot be empty", { field: "tagName" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git delete tag", { tagName });

      const result = await gitService.deleteTag(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/branches",
    method: "get",
    handler: asyncHandler(async (req, res) => {
      const params = extractGitParams(req.query);
      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git list branches", params);

      const result = await gitService.listBranches(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/branch-create",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { branchName, startPoint } = req.body || {};
      const params = { ...extractGitParams(req.body), branchName, startPoint };

      if (!branchName) {
        throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git create branch", { branchName, startPoint });

      const result = await gitService.createBranch(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/branch-switch",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { branchName } = req.body || {};
      const params = { ...extractGitParams(req.body), branchName };

      if (!branchName) {
        throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git switch branch", { branchName });

      const result = await gitService.switchBranch(params);
      res.status(200).json(result);
    }),
  },
  {
    path: "/branch-delete",
    method: "post",
    handler: asyncHandler(async (req, res) => {
      const { branchName, force } = req.body || {};
      const params = { ...extractGitParams(req.body), branchName, force: force === true };

      if (!branchName) {
        throw new ValidationError("Branch name cannot be empty", { field: "branchName" });
      }

      log(params.projectId || `computer:${params.userId}:${params.cId}`, "INFO", "Git delete branch", { branchName, force });

      const result = await gitService.deleteBranch(params);
      res.status(200).json(result);
    }),
  },
];

// 注册路由
routes.forEach((route) => {
  if (route.middleware) {
    gitRouter[route.method](route.path, route.middleware, route.handler);
  } else {
    gitRouter[route.method](route.path, route.handler);
  }
});

export default gitRouter;
