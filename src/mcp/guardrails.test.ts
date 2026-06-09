import { describe, expect, it } from "vitest";
import {
  assertNoBlockedDestroy,
  assertUnderPrCap,
  DEFAULT_ALLOWED_PATHS,
  enforceProtectedPaths,
  GENERATE_MODE,
  globToRegex,
  isPathAllowed,
  parseGitleaksReport,
  REMEDIATE_MODE,
  recordRemediationPrOpened,
  scanDiffForSecrets,
} from "#app/mcp/guardrails";
import type { ToolContext } from "#app/mcp/server";

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

// Adversarial coverage for the hand-rolled glob compiler — it backs the path
// allow-list and the protected-paths deny-list, so a regex-injection or a
// segment-crossing bypass here would defeat those guardrails.
describe("globToRegex (adversarial / injection)", () => {
  it("escapes regex metacharacters in the glob (no injection from the pattern)", () => {
    // `.` is a literal dot, not 'any char'
    expect(globToRegex("a.tf").test("axtf")).toBe(false);
    expect(globToRegex("a.tf").test("a.tf")).toBe(true);
    // anchors/alternation/group chars from the pattern are treated literally
    const re = globToRegex("a(b|c)$.tf");
    expect(re.test("a(b|c)$.tf")).toBe(true);
    expect(re.test("ab.tf")).toBe(false);
    // `+` is a literal plus, not a regex quantifier
    expect(globToRegex("a+.tf").test("a+.tf")).toBe(true);
    expect(globToRegex("a+.tf").test("aaaa.tf")).toBe(false);
  });

  it("is fully anchored — no partial-match bypass", () => {
    const re = globToRegex("*.tf");
    expect(re.test("main.tf.bak")).toBe(false);
    expect(re.test("evil/main.tf")).toBe(false);
    // a separator anywhere defeats a single-segment glob, so a slash-bearing
    // suffix can't be smuggled past the anchored pattern
    expect(re.test("main.tf/../etc/passwd")).toBe(false);
    expect(re.test("main.tf\n/etc/passwd")).toBe(false);
  });

  it("`*`/`?` never cross a path separator, blocking `../` traversal", () => {
    // single-segment globs reject any path containing a separator…
    expect(isPathAllowed("../secret.tf", ["*.tf"])).toBe(false);
    expect(isPathAllowed("..\\secret.tf", ["*.tf"])).toBe(false); // windows sep normalized then rejected
    expect(isPathAllowed("a/b.tf", ["*.tf"])).toBe(false);
    expect(globToRegex("?.tf").test("/.tf")).toBe(false);
  });

  it("`**` deliberately spans separators (documented power of the deny-list)", () => {
    // protected-paths rely on this: `prod/**` must catch nested files. The
    // safety of the allow-list against `..` does NOT come from `**` globs — it
    // comes from changed-file paths being git-relative (no `..`), which is
    // enforced upstream in changedFilesSinceRunStart.
    expect(isPathAllowed("prod/db/main.tf", ["prod/**"])).toBe(true);
    expect(isPathAllowed("prod/a/b/c/secret", ["prod/**"])).toBe(true);
    expect(isPathAllowed("staging/main.tf", ["prod/**"])).toBe(false);
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
    allowReplace?: string[],
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
      /DESTROY or REPLACE 1 stateful/,
    );
    expect(() => assertNoBlockedDestroy(ctx(GENERATE_MODE, statefulDestroy))).toThrow(
      /aws_db_instance\.main/,
    );
  });

  it("allows the destroy when the operator opted in via allow_replace (address, glob, or *)", () => {
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.main"])),
    ).not.toThrow();
    expect(() =>
      assertNoBlockedDestroy(ctx(REMEDIATE_MODE, statefulDestroy, ["aws_db_instance.*"])),
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

describe("protected-paths guardrail (§2.7) — gating", () => {
  // enforceProtectedPaths reaches git only AFTER the mode + empty-list gates,
  // so these no-op cases exercise the gate without any git I/O.
  const ctx = (selectedMode: string | undefined, protectedPaths?: string[]) =>
    ({
      toolState: { selectedMode },
      payload: { protectedPaths },
    }) as unknown as ToolContext;

  it("no-ops outside a guarded mode (even with protected paths set)", () => {
    expect(() => enforceProtectedPaths(ctx("Build", ["prod/**"]))).not.toThrow();
    expect(() => enforceProtectedPaths(ctx(undefined, ["prod/**"]))).not.toThrow();
  });

  it("no-ops in a guarded mode when no protected paths are configured", () => {
    expect(() => enforceProtectedPaths(ctx(REMEDIATE_MODE, undefined))).not.toThrow();
    expect(() => enforceProtectedPaths(ctx(REMEDIATE_MODE, []))).not.toThrow();
  });

  it("a protected glob matches via the same engine as allowed_paths (inverse semantics)", () => {
    // matching a protected glob means BLOCKED — verify the matcher the guardrail
    // uses (isPathAllowed) behaves as expected for the protected-list direction.
    expect(isPathAllowed("prod/main.tf", ["prod/**"])).toBe(true);
    expect(isPathAllowed("dev/main.tf", ["prod/**"])).toBe(false);
    expect(isPathAllowed("modules/db/main.tf", ["**/db/**"])).toBe(true);
  });
});

describe("scanDiffForSecrets (§2.8)", () => {
  const diff = (...lines: string[]) => lines.join("\n");

  it("flags an inlined AWS access key id on an added line, with file:line", () => {
    const d = diff(
      "diff --git a/main.tf b/main.tf",
      "--- a/main.tf",
      "+++ b/main.tf",
      "@@ -1,2 +1,3 @@",
      ' resource "aws_iam_user" "x" {',
      '+  access_key = "AKIAIOSFODNN7EXAMPLE"',
      " }",
    );
    const hits = scanDiffForSecrets(d);
    expect(hits).toHaveLength(2); // AKIA value pattern + sensitive-assignment
    expect(hits.some((h) => h.rule === "aws-access-key-id")).toBe(true);
    expect(hits[0].file).toBe("main.tf");
    expect(hits[0].line).toBe(2); // second new-side line in the hunk
  });

  it("flags a hardcoded password literal but NOT a variable reference", () => {
    const literal = diff("+++ b/x.tf", "@@ -0,0 +1 @@", '+  password = "hunter2"');
    expect(scanDiffForSecrets(literal).map((h) => h.rule)).toContain("hardcoded-secret-assignment");

    const ref = diff("+++ b/x.tf", "@@ -0,0 +1 @@", "+  password = var.db_password");
    expect(scanDiffForSecrets(ref)).toEqual([]);

    const interp = diff("+++ b/x.tf", "@@ -0,0 +1 @@", '+  password = "${var.db_password}"');
    expect(scanDiffForSecrets(interp)).toEqual([]);
  });

  it("flags a PEM private-key header", () => {
    const d = diff("+++ b/key.tf", "@@ -0,0 +1 @@", '+  key = "-----BEGIN RSA PRIVATE KEY-----"');
    expect(scanDiffForSecrets(d).some((h) => h.rule === "pem-private-key")).toBe(true);
  });

  it("ignores secrets on removed/context lines (only ADDED lines count)", () => {
    const d = diff(
      "+++ b/main.tf",
      "@@ -1,2 +1,1 @@",
      '-  password = "hunter2"', // removed — pre-existing, not this run's doing
      ' resource "x" "y" {}',
    );
    expect(scanDiffForSecrets(d)).toEqual([]);
  });

  it("returns nothing for a clean diff", () => {
    const d = diff("+++ b/main.tf", "@@ -0,0 +1 @@", "+  bucket = var.bucket_name");
    expect(scanDiffForSecrets(d)).toEqual([]);
  });
});

describe("parseGitleaksReport (§2.8 — optional gitleaks engine)", () => {
  it("maps gitleaks findings to SecretHit with a gitleaks: rule prefix", () => {
    const report = JSON.stringify([
      { RuleID: "aws-access-token", File: "main.tf", StartLine: 12, Description: "AWS" },
      { RuleID: "generic-api-key", File: "modules/db/main.tf", StartLine: 4 },
    ]);
    expect(parseGitleaksReport(report)).toEqual([
      { file: "main.tf", line: 12, rule: "gitleaks:aws-access-token" },
      { file: "modules/db/main.tf", line: 4, rule: "gitleaks:generic-api-key" },
    ]);
  });

  it("tolerates an empty report, empty string, and malformed JSON", () => {
    expect(parseGitleaksReport("[]")).toEqual([]);
    expect(parseGitleaksReport("")).toEqual([]);
    expect(parseGitleaksReport("not json")).toEqual([]);
    expect(parseGitleaksReport(JSON.stringify({ not: "an array" }))).toEqual([]);
  });

  it("defaults missing fields rather than throwing", () => {
    expect(parseGitleaksReport(JSON.stringify([{}]))).toEqual([
      { file: "(unknown)", line: 0, rule: "gitleaks:secret" },
    ]);
  });
});
