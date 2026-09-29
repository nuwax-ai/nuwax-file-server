import fs from "fs";

/**
 * multer 临时文件统一清理（请求级 finally）：
 * - trackMulterTempPath(req, fullPath)：由各 diskStorage 的 filename 回调在 multer 写盘时
 *   登记暂存路径——此刻的快照不受后续 handler 改写 req.file.path 的影响
 *   （如 /project/upload-project 移库后会回填新路径，绝不能删到移库后的正式文件）
 * - cleanupMulterFiles：router 级中间件，响应结束（成功/失败/客户端断开，res "close"
 *   必然触发）时删除本次登记的全部暂存文件，防止 .tmp / UPLOAD_PROJECT_DIR/temp 残留。
 *   consumer 正常流程均为"读取/解压/移动后转存"，源暂存文件请求结束即可删；
 *   个别 util 内已有自身 unlink（幂等，ENOENT 静默忽略）。
 */
function trackMulterTempPath(req, fullPath) {
  (req._multerTempPaths ??= []).push(fullPath);
}

function cleanupMulterFiles(req, res, next) {
  res.on("close", () => {
    for (const tempPath of req._multerTempPaths || []) {
      fs.promises.unlink(tempPath).catch(() => {
        // 已被 util 清理 / 已被移动 / 并发删除（ENOENT）：无需处理
      });
    }
  });
  next();
}

export { trackMulterTempPath, cleanupMulterFiles };
