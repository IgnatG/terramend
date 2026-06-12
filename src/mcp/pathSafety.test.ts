import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWithinCwd } from "#app/mcp/pathSafety";

// `resolve("workspace-root")` yields an absolute path under the test cwd, so the
// assertions are drive-correct on Windows and POSIX alike.
const base = resolve("workspace-root");

describe("resolveWithinCwd", () => {
  it("allows a relative child path", () => {
    expect(resolveWithinCwd(base, "findings.json")).toBe(resolve(base, "findings.json"));
  });

  it("allows a nested relative child path", () => {
    expect(resolveWithinCwd(base, "reports/out.sarif")).toBe(resolve(base, "reports/out.sarif"));
  });

  it("allows the workspace root itself", () => {
    expect(resolveWithinCwd(base, ".")).toBe(base);
  });

  it("allows traversal that resolves back inside the workspace", () => {
    expect(resolveWithinCwd(base, "a/../b.json")).toBe(resolve(base, "b.json"));
  });

  it("allows an absolute path that is inside the workspace", () => {
    const inside = resolve(base, "deep/x.json");
    expect(resolveWithinCwd(base, inside)).toBe(inside);
  });

  it("rejects parent traversal", () => {
    expect(() => resolveWithinCwd(base, "../escape")).toThrow(/escapes the workspace/);
  });

  it("rejects deep traversal that resolves outside", () => {
    expect(() => resolveWithinCwd(base, "a/../../escape")).toThrow(/escapes the workspace/);
  });

  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveWithinCwd(base, resolve(base, "../sibling/x"))).toThrow(
      /escapes the workspace/,
    );
  });
});
