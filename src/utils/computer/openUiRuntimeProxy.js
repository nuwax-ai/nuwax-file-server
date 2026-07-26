import http from "http";

const OPENUI_ARTIFACT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 将公开静态文件路径限制到 OpenUI Runtime 的只读资源白名单。
 *
 * @param {string} pathname 静态文件挂载点之后的路径
 * @returns {string|null} 可转发的 Runtime 路径
 */
export function parseOpenUiRuntimePath(pathname) {
  const segments = String(pathname || "")
    .split("/")
    .filter(Boolean);
  if (segments[0] !== "openui" || segments.length !== 3) return null;

  const [, resource, leaf] = segments;
  if (
    (resource === "pages" || resource === "artifacts") &&
    OPENUI_ARTIFACT_ID_PATTERN.test(leaf)
  ) {
    return `/openui/${resource}/${leaf}`;
  }
  if (
    resource === "assets" &&
    (leaf === "sidecar.js" || leaf === "sidecar.css")
  ) {
    return `/openui/assets/${leaf}`;
  }
  return null;
}

/**
 * 将受控 OpenUI 静态请求转发到用户电脑本机 Runtime。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} targetPath
 */
export function proxyOpenUiRuntimeRequest(req, res, targetPath) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.status(405).type("text/plain").send("Method Not Allowed");
    return;
  }

  const port = Number.parseInt(process.env.NUWAX_OPENUI_PORT || "8787", 10);
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.authorization;
  delete headers.cookie;
  delete headers["x-api-key"];
  delete headers["proxy-authorization"];

  const proxyRequest = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: targetPath,
      method,
      headers,
      timeout: 5000,
    },
    (proxyResponse) => {
      const responseHeaders = { ...proxyResponse.headers };
      delete responseHeaders["set-cookie"];
      res.writeHead(proxyResponse.statusCode || 502, responseHeaders);
      proxyResponse.pipe(res);
    }
  );

  proxyRequest.on("timeout", () => {
    proxyRequest.destroy(new Error("OpenUI Runtime request timed out"));
  });
  proxyRequest.on("error", () => {
    if (!res.headersSent) {
      res.status(502).type("text/plain").send("OpenUI Runtime is unavailable");
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyRequest);
}
