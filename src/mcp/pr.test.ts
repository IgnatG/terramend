import { describe, expect, it } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import { pickBaseBranch, resolveBaseBranch } from "#app/mcp/pr";

describe("pickBaseBranch (deterministic base: declared → default → main → master → main)", () => {
  it("an explicit declaration always wins", () => {
    expect(
      pickBaseBranch({ declared: "release", defaultBranch: "main", mainExists: true, masterExists: true })
    ).toBe("release");
  });

  it("uses the repository default branch when nothing is declared", () => {
    expect(pickBaseBranch({ defaultBranch: "master", mainExists: true, masterExists: true })).toBe("master");
  });

  it("prefers main when neither a declaration nor a default branch is known", () => {
    expect(pickBaseBranch({ mainExists: true, masterExists: true })).toBe("main");
  });

  it("falls back to master when main does not exist", () => {
    expect(pickBaseBranch({ mainExists: false, masterExists: true })).toBe("master");
  });

  it("ultimately defaults to main", () => {
    expect(pickBaseBranch({ mainExists: false, masterExists: false })).toBe("main");
  });
});

describe("resolveBaseBranch (ctx wiring; git not probed when a declaration or default exists)", () => {
  const ctx = (over: { baseBranch?: string; defaultBranch?: string }): ToolContext =>
    ({
      payload: { baseBranch: over.baseBranch },
      repo: { data: { default_branch: over.defaultBranch } },
    }) as unknown as ToolContext;

  it("prefers the explicit base_branch override", () => {
    expect(resolveBaseBranch(ctx({ baseBranch: "release", defaultBranch: "main" }))).toBe("release");
  });

  it("trims the override", () => {
    expect(resolveBaseBranch(ctx({ baseBranch: "  release  ", defaultBranch: "main" }))).toBe("release");
  });

  it("uses the repository default branch when no override is set", () => {
    expect(resolveBaseBranch(ctx({ defaultBranch: "master" }))).toBe("master");
  });
});
