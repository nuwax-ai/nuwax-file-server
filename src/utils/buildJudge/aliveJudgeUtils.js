import http from "http";
import https from "https";
import { URL } from "url";
import { log } from "../log/logUtils.js";

/**
 * 通过对本地端口发起 HTTP 请求判断项目是否存活
 * 返回 2xx/3xx 视为存活，其余或超时/异常视为不存活
 */
async function isProjectAlive(projectId, port, basePath, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 1500;
  const portNum = Number(port);
  if (!Number.isFinite(portNum) || portNum <= 0) return false;

  // 规范化 basePath，确保以 / 开头
  const normalizedBase = basePath
    ? ("/" + String(basePath).replace(/^\/+/, ""))
    : "/";

  // 默认用 http://127.0.0.1:port/basePath
  const urlStr = `http://127.0.0.1:${portNum}${normalizedBase}`;

  return new Promise((resolve) => {
    let finished = false;
    const urlObj = new URL(urlStr);
    const client = urlObj.protocol === "https:" ? https : http;

    const req = client.request(
      {
        method: "GET",
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        headers: { "User-Agent": "xagi-keepalive-check" },
      },
      (res) => {
        if (finished) return;
        finished = true;
        // 2xx/3xx 认为服务存活
        const alive = res.statusCode >= 200 && res.statusCode < 300;
        log(projectId, "INFO", "Alive detection HTTP response", { statusCode: res.statusCode, url: urlStr, alive });
        // 消耗数据并结束
        res.resume();
        resolve(alive);
      }
    );

    req.on("error", (err) => {
      if (finished) return;
      finished = true;
      log(projectId, "WARN", "Alive detection HTTP request error", { error: err && err.message, url: urlStr, });
      resolve(false);
    });

    req.setTimeout(timeoutMs, () => {
      if (finished) return;
      finished = true;
      log(projectId, "INFO", "Alive detection HTTP request timeout", { url: urlStr, timeoutMs });
      req.destroy();
      resolve(false);
    });

    try {
      req.end();
    } catch (_) {
      if (!finished) {
        finished = true;
        resolve(false);
      }
    }
  });
}

export { isProjectAlive };


