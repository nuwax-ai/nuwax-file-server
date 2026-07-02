import fs from "fs";
import os from "os";
import path from "path";
import {
  assertSafeZipEntryPath,
  movePath,
} from "../../src/utils/common/fileSystemUtils.js";
import { FileError } from "../../src/utils/error/errorHandler.js";

describe("fileSystemUtils", () => {
  describe("assertSafeZipEntryPath", () => {
    const extractPath = path.join(os.tmpdir(), "zip-safe-test");

    test("allows normal nested paths", () => {
      const target = assertSafeZipEntryPath(extractPath, "project/src/index.js");
      expect(target).toBe(path.resolve(extractPath, "project/src/index.js"));
    });

    test("rejects path traversal", () => {
      expect(() => assertSafeZipEntryPath(extractPath, "../outside.txt")).toThrow(FileError);
      expect(() => assertSafeZipEntryPath(extractPath, "project/../../outside.txt")).toThrow(FileError);
    });

    test("rejects absolute paths", () => {
      expect(() => assertSafeZipEntryPath(extractPath, "/etc/passwd")).toThrow(FileError);
    });
  });

  describe("movePath", () => {
    let workspaceDir;

    beforeEach(async () => {
      workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "move-path-test-"));
    });

    afterEach(async () => {
      await fs.promises.rm(workspaceDir, { recursive: true, force: true });
    });

    test("moves file to destination", async () => {
      const src = path.join(workspaceDir, "src.txt");
      const dest = path.join(workspaceDir, "nested", "dest.txt");
      await fs.promises.writeFile(src, "hello", "utf8");

      await movePath(src, dest);

      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readFileSync(dest, "utf8")).toBe("hello");
    });
  });
});
