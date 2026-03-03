import { isPortListening } from "../buildArg/portUtils.js";
import { log } from "../log/logUtils.js";
import { deleteRunningProcess, isProcessRunning } from "./processManager.js";
import { isProjectAlive } from "../buildJudge/aliveJudgeUtils.js";
import { restartDevServer } from "./restartDevUtils.js";
import { startDevServer } from "./startDevUtils.js";
import { stopDevServer } from "./stopDevUtils.js";

/**
 * 保持开发服务器活跃
 * @param {Object} req 请求对象
 * @param {string} projectId 项目ID
 * @param {number|string} pid 进程ID
 * @param {number|string} port 端口号
 * @returns {Promise<Object>} 检查结果
 */
async function keepAliveDevServer(req, projectId, pid, port, basePath) {
  const pidNum = Number(pid);
  const portNum = Number(port);

  log(projectId, "INFO", "开始检查开发服务器状态", {
    projectId,
    pid: pidNum,
    port: portNum,
    requestId: req.requestId,
  });

  // 检查项目是否存活
  const projectAlive = await isProjectAlive(projectId, portNum, basePath);
  if (projectAlive) {
    log(projectId, "INFO", "dev服务器存活，直接返回成功", {
      projectId,
      pid: pidNum,
      port: portNum,
      requestId: req.requestId,
    });

    return {
      success: true,
      message: "开发服务器存活",
      projectId,
      pid: pidNum,
      port: portNum,
    };
  }

  log(projectId, "INFO", "dev服务器不存活，重新启动", {
    projectId,
    pid: pidNum,
    port: portNum,
    requestId: req.requestId,
  });

  deleteRunningProcess(projectId);

  if(pidNum > 0) {
    await stopDevServer(req, projectId, pidNum, {
      strict: false,
      waitForStop: true,
    });
  }

  const result = await startDevServer(req, projectId);
  return {
    ...result,
    action: "start",
  };

}

export { keepAliveDevServer };
