import fs from "fs";
import os from "os";
import path from "path";
import {
  IMPORT_PROJECT_PRESERVED_ENTRIES,
  removeTopLevelDir,
} from "../../src/utils/computer/computerFileUtils.js";

describe("importProjectUtils", () => {
  describe("IMPORT_PROJECT_PRESERVED_ENTRIES", () => {
    test("contains required preserved directories", () => {
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".git")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".agents")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".claude")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".codex")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".opencode")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".tmp")).toBe(true);
      expect(IMPORT_PROJECT_PRESERVED_ENTRIES.has(".logs")).toBe(true);
    });
  });

  describe("removeTopLevelDir", () => {
    let workspaceDir;

    beforeEach(async () => {
      workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "import-project-test-"));
    });

    afterEach(async () => {
      await fs.promises.rm(workspaceDir, { recursive: true, force: true });
    });

    test("flattens single top-level directory", async () => {
      const projectRoot = path.join(workspaceDir, "my-project");
      await fs.promises.mkdir(path.join(projectRoot, "src"), { recursive: true });
      await fs.promises.writeFile(path.join(projectRoot, "src", "index.js"), "console.log(1);", "utf8");

      await removeTopLevelDir(workspaceDir, "test-log");

      expect(fs.existsSync(path.join(workspaceDir, "my-project"))).toBe(false);
      expect(fs.existsSync(path.join(workspaceDir, "src", "index.js"))).toBe(true);
    });

    test("keeps multiple top-level entries unchanged", async () => {
      await fs.promises.mkdir(path.join(workspaceDir, "my-project"), { recursive: true });
      await fs.promises.writeFile(path.join(workspaceDir, "README.md"), "readme", "utf8");

      await removeTopLevelDir(workspaceDir, "test-log");

      expect(fs.existsSync(path.join(workspaceDir, "my-project"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "README.md"))).toBe(true);
    });
  });
});
