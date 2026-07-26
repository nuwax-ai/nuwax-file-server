import { parseOpenUiRuntimePath } from "../../src/utils/computer/openUiRuntimeProxy.js";

const artifactId = "550e8400-e29b-41d4-a716-446655440000";

describe("OpenUI Runtime proxy allowlist", () => {
  test("accepts pages, artifacts and bundled assets", () => {
    expect(parseOpenUiRuntimePath(`/openui/pages/${artifactId}`)).toBe(
      `/openui/pages/${artifactId}`
    );
    expect(parseOpenUiRuntimePath(`/openui/artifacts/${artifactId}`)).toBe(
      `/openui/artifacts/${artifactId}`
    );
    expect(parseOpenUiRuntimePath("/openui/assets/sidecar.js")).toBe(
      "/openui/assets/sidecar.js"
    );
  });

  test("rejects arbitrary paths and traversal", () => {
    expect(parseOpenUiRuntimePath("/openui/admin")).toBeNull();
    expect(parseOpenUiRuntimePath("/openui/assets/other.js")).toBeNull();
    expect(parseOpenUiRuntimePath("/openui/pages/../../admin")).toBeNull();
    expect(parseOpenUiRuntimePath("/openui/pages/not-a-uuid")).toBeNull();
  });
});
