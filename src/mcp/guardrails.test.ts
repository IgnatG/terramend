import { describe, expect, it } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import {
  assertUnderPrCap,
  DEFAULT_ALLOWED_PATHS,
  GENERATE_MODE,
  globToRegex,
  isPathAllowed,
  recordRemediationPrOpened,
  REMEDIATE_MODE,
} from "#app/mcp/guardrails";

describe("globToRegex", () => {
  it("matches **/*.tf at any depth", () => {
    const re = globToRegex("**/*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("main.tfvars")).toBe(false);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches a directory subtree with **", () => {
    const re = globToRegex("modules/**");
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("modules/x")).toBe(true);
    expect(re.test("other/x.tf")).toBe(false);
  });

  it("single * stays within a path segment", () => {
    const re = globToRegex("*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/main.tf")).toBe(false);
  });
});

describe("isPathAllowed (default Terraform allow-list)", () => {
  const globs = [...DEFAULT_ALLOWED_PATHS];

  it("allows .tf and .tfvars at any depth", () => {
    expect(isPathAllowed("main.tf", globs)).toBe(true);
    expect(isPathAllowed("modules/net/vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("envs/prod.tfvars", globs)).toBe(true);
  });

  it("rejects anything that isn't Terraform", () => {
    expect(isPathAllowed(".github/workflows/ci.yml", globs)).toBe(false);
    expect(isPathAllowed("src/index.ts", globs)).toBe(false);
    expect(isPathAllowed("README.md", globs)).toBe(false);
  });

  it("normalizes windows separators and leading ./", () => {
    expect(isPathAllowed("modules\\net\\vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("./main.tf", globs)).toBe(true);
  });
});

describe("PR-cap guardrail is scoped to the Terraform-write modes", () => {
  // assertUnderPrCap / recordRemediationPrOpened only read toolState + payload
  // (no git / no I/O), so a minimal cast context exercises the mode gate.
  const ctx = (selectedMode: string | undefined, opened: number, maxPrs = 1) =>
    ({
      toolState: { selectedMode, remediationPrsOpened: opened },
      payload: { maxPrs },
    }) as unknown as ToolContext;

  it("throws at the cap for both Remediate and GenerateTerraform", () => {
    expect(() => assertUnderPrCap(ctx(REMEDIATE_MODE, 1))).toThrow(/PR limit reached/);
    expect(() => assertUnderPrCap(ctx(GENERATE_MODE, 1))).toThrow(/PR limit reached/);
  });

  it("allows opening up to the cap", () => {
    expect(() => assertUnderPrCap(ctx(GENERATE_MODE, 0))).not.toThrow();
    expect(() => assertUnderPrCap(ctx(REMEDIATE_MODE, 0))).not.toThrow();
  });

  it("never engages for non-guarded modes (Build/Review/etc.), even over cap", () => {
    expect(() => assertUnderPrCap(ctx("Build", 5))).not.toThrow();
    expect(() => assertUnderPrCap(ctx(undefined, 5))).not.toThrow();
  });

  it("only counts PRs for guarded modes", () => {
    const guarded = ctx(GENERATE_MODE, 0);
    recordRemediationPrOpened(guarded);
    expect(guarded.toolState.remediationPrsOpened).toBe(1);

    const unguarded = ctx("Build", 0);
    recordRemediationPrOpened(unguarded);
    expect(unguarded.toolState.remediationPrsOpened).toBe(0);
  });
});
