import { describe, expect, it } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import { resolveBaseBranch } from "#app/mcp/pr";

describe("resolveBaseBranch (deterministic PR base)", () => {
  const ctx = (over: {
    baseBranch?: string;
    initialHead?: ToolContext["toolState"]["initialHead"];
    defaultBranch?: string;
  }): ToolContext =>
    ({
      payload: { baseBranch: over.baseBranch },
      toolState: { initialHead: over.initialHead },
      repo: { data: { default_branch: over.defaultBranch } },
    }) as unknown as ToolContext;

  it("prefers the explicit base_branch override", () => {
    expect(
      resolveBaseBranch(
        ctx({ baseBranch: "release", initialHead: { kind: "branch", name: "pr-1" }, defaultBranch: "main" })
      )
    ).toBe("release");
  });

  it("falls back to the branch the run started on", () => {
    expect(resolveBaseBranch(ctx({ initialHead: { kind: "branch", name: "pr-1" }, defaultBranch: "main" }))).toBe(
      "pr-1"
    );
  });

  it("falls back to the default branch when the run started detached", () => {
    expect(resolveBaseBranch(ctx({ initialHead: { kind: "detached", sha: "abc123" }, defaultBranch: "main" }))).toBe(
      "main"
    );
  });

  it("falls back to the default branch when there is no captured initial head", () => {
    expect(resolveBaseBranch(ctx({ defaultBranch: "trunk" }))).toBe("trunk");
  });

  it("ultimately defaults to main", () => {
    expect(resolveBaseBranch(ctx({}))).toBe("main");
  });
});
