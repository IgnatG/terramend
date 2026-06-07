import { describe, expect, it } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import {
  assertNoBlockedDestroy,
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

describe("destroy-block guardrail (§2.5 — never delete/replace a stateful resource)", () => {
  // assertNoBlockedDestroy reads only toolState.plannedDestroy + payload.allowReplace.
  const ctx = (
    selectedMode: string | undefined,
    plannedDestroy: ToolContext["toolState"]["plannedDestroy"],
    allowReplace?: string[]
  ) =>
    ({
      toolState: { selectedMode, plannedDestroy },
      payload: { allowReplace },
    }) as unknown as ToolContext;

  const statefulDestroy = {
    stateful: [{ address: "aws_db_instance.main", action: "delete", type: "aws_db_instance" }],
    ephemeral: [],
  };

  it("blocks a push that would destroy/replace a stateful resource", () => {
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy))).toThrow(
      /DESTROY or REPLACE 1 stateful/
    );
    expect(() => assertNoBlockedDestroy(ctx(GENERATE_MODE, statefulDestroy))).toThrow(
      /aws_db_instance\.main/
    );
  });

  it("allows the destroy when the operator opted in via allow_replace (address, glob, or *)", () => {
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.main"]))
    ).not.toThrow();
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.*"]))
    ).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["*"]))).not.toThrow();
  });

  it("never engages for ephemeral-only destroys (recreatable resources)", () => {
    const ephemeralOnly = {
      stateful: [],
      ephemeral: [{ address: "aws_instance.web", action: "replace", type: "aws_instance" }],
    };
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, ephemeralOnly))).not.toThrow();
  });

  it("no-ops when no plan ran, or outside a guarded mode", () => {
    expect(() => assertNoBlockedDestroy(ctx(REMEDIATE_MODE, undefined))).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx("Build", statefulDestroy))).not.toThrow();
    expect(() => assertNoBlockedDestroy(ctx(undefined, statefulDestroy))).not.toThrow();
  });
});
