import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregatePlans,
  annotateGroups,
  buildRefusalReport,
  buildSarifReport,
  type Concern,
  classifyAutonomy,
  classifyCostEscalation,
  classifyDestructive,
  classifyRefusal,
  clusterByLocation,
  collectCloudCredentials,
  comparePlanStability,
  computeBlastRadius,
  computeConfidence,
  computeCostDelta,
  computeRegressions,
  computeRemediationVerdict,
  groupConcerns,
  groupConcernsByRule,
  isSarif,
  isTerraformConcern,
  moduleAddressOf,
  parseCheckovOutput,
  parseFindingsFile,
  parseFmtOutput,
  parseInfracostBreakdown,
  parseInfracostResources,
  parseRequiredProviders,
  parseResourceArguments,
  parseReviewerFindings,
  parseSarifFindings,
  parseTerraformPlanJson,
  parseTflintOutput,
  parseTrivyOutput,
  parseValidateOutput,
  planBatches,
  preventiveControlFor,
  type RootPlan,
  rebaseConcern,
  resolveRoots,
  resourceTypeOf,
  ruleDocUrl,
  shouldSuggestInline,
  toRepoRelative,
} from "#app/mcp/terraform";

describe("parseFmtOutput", () => {
  it("emits one low-severity style concern per unformatted file", () => {
    const concerns = parseFmtOutput("main.tf\nmodules/net/vpc.tf\n");
    expect(concerns).toHaveLength(2);
    expect(concerns[0]).toMatchObject({
      source: "terraform-fmt",
      rule_id: "terraform-fmt:unformatted",
      severity: "low",
      category: "style",
      location: { file: "main.tf", line: null },
    });
    expect(concerns[1]!.location.file).toBe("modules/net/vpc.tf");
  });

  it("returns nothing for empty output", () => {
    expect(parseFmtOutput("\n  \n")).toEqual([]);
  });
});

describe("parseTrivyOutput", () => {
  const sample = JSON.stringify({
    Results: [
      {
        Target: "main.tf",
        Class: "config",
        Type: "terraform",
        Misconfigurations: [
          {
            ID: "AVD-AWS-0088",
            AVDID: "AVD-AWS-0088",
            Title: "S3 Data should be encrypted",
            Description: "S3 encryption should be enabled for buckets at rest.",
            Message: "Bucket does not have encryption enabled",
            Resolution: "Enable server-side encryption",
            Severity: "CRITICAL",
            References: ["https://avd.aquasec.com/misconfig/avd-aws-0088"],
            Status: "FAIL",
            CauseMetadata: { StartLine: 1, EndLine: 1 },
          },
        ],
      },
    ],
  });

  it("maps a trivy misconfiguration to a security concern with lowercased severity", () => {
    const [concern] = parseTrivyOutput(sample);
    expect(concern).toMatchObject({
      source: "trivy",
      rule_id: "trivy:AVD-AWS-0088",
      severity: "critical",
      category: "security",
      // the instance-specific Message is preferred over the generic Description
      evidence: "Bucket does not have encryption enabled",
      remediation_hint: "Enable server-side encryption",
      location: { file: "main.tf", line: 1 },
    });
  });

  it("drops Status: PASS misconfigurations (defensive against --include-non-failures)", () => {
    const withPass = JSON.stringify({
      Results: [
        {
          Target: "main.tf",
          Misconfigurations: [
            {
              AVDID: "AVD-AWS-0001",
              Severity: "HIGH",
              Status: "PASS",
              CauseMetadata: { StartLine: 4 },
            },
            {
              AVDID: "AVD-AWS-0002",
              Severity: "HIGH",
              Status: "FAIL",
              CauseMetadata: { StartLine: 9 },
            },
          ],
        },
      ],
    });
    const concerns = parseTrivyOutput(withPass);
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.rule_id).toBe("trivy:AVD-AWS-0002");
  });

  it("treats a zero/absent StartLine as a null line", () => {
    const noLine = JSON.stringify({
      Results: [{ Target: "main.tf", Misconfigurations: [{ AVDID: "AVD-X", Severity: "LOW" }] }],
    });
    expect(parseTrivyOutput(noLine)[0]!.location.line).toBeNull();
  });

  it("tolerates a null/empty Results array", () => {
    expect(parseTrivyOutput(JSON.stringify({ Results: null }))).toEqual([]);
    expect(parseTrivyOutput("{}")).toEqual([]);
  });
});

describe("parseCheckovOutput", () => {
  const single = JSON.stringify({
    results: {
      failed_checks: [
        {
          check_id: "CKV_AWS_18",
          check_name: "Ensure the S3 bucket has access logging enabled",
          severity: "HIGH",
          file_path: "main.tf",
          file_line_range: [3, 7],
          guideline: "https://docs.example/s3-logging",
        },
      ],
    },
  });

  it("maps a failed check to a concern using the range start line", () => {
    const [concern] = parseCheckovOutput(single);
    expect(concern).toMatchObject({
      source: "checkov",
      rule_id: "checkov:CKV_AWS_18",
      severity: "high",
      category: "security",
      location: { file: "main.tf", line: 3 },
      remediation_hint: "https://docs.example/s3-logging",
    });
  });

  it("handles checkov's multi-framework array form", () => {
    const arr = `[${single},${single}]`;
    expect(parseCheckovOutput(arr)).toHaveLength(2);
  });

  it("defaults missing severity to medium", () => {
    const noSev = JSON.stringify({
      results: { failed_checks: [{ check_id: "CKV_X", file_path: "a.tf" }] },
    });
    expect(parseCheckovOutput(noSev)[0]!.severity).toBe("medium");
  });

  it("normalizes a 0 start line to null (matches the reviewer, so the id is stable)", () => {
    const zeroLine = JSON.stringify({
      results: {
        failed_checks: [{ check_id: "CKV_X", file_path: "a.tf", file_line_range: [0, 0] }],
      },
    });
    expect(parseCheckovOutput(zeroLine)[0]!.location.line).toBeNull();
  });
});

describe("parseTflintOutput", () => {
  it("maps tflint severities to the concern scale", () => {
    const sample = JSON.stringify({
      issues: [
        {
          rule: { name: "terraform_unused_declarations", severity: "warning", link: "https://x" },
          message: 'variable "unused" is declared but not used',
          range: { filename: "main.tf", start: { line: 9 } },
        },
      ],
    });
    const [concern] = parseTflintOutput(sample);
    expect(concern).toMatchObject({
      source: "tflint",
      rule_id: "tflint:terraform_unused_declarations",
      severity: "medium",
      category: "style",
      location: { file: "main.tf", line: 9 },
    });
  });
});

describe("parseValidateOutput", () => {
  it("keeps real errors as high-severity correctness concerns", () => {
    const sample = JSON.stringify({
      diagnostics: [
        {
          severity: "error",
          summary: "Reference to undeclared resource",
          detail: "A managed resource has not been declared.",
          range: { filename: "main.tf", start: { line: 12 } },
        },
      ],
    });
    const [concern] = parseValidateOutput(sample);
    expect(concern).toMatchObject({
      source: "terraform-validate",
      severity: "high",
      category: "correctness",
      location: { file: "main.tf", line: 12 },
    });
  });

  it("drops uninitialized-directory noise (not a real best-practice issue)", () => {
    const sample = JSON.stringify({
      diagnostics: [
        {
          severity: "error",
          summary: "Missing required provider",
          detail: "please run terraform init",
        },
      ],
    });
    expect(parseValidateOutput(sample)).toEqual([]);
  });

  it("ignores warning-level diagnostics", () => {
    const sample = JSON.stringify({
      diagnostics: [{ severity: "warning", summary: "Deprecated attribute" }],
    });
    expect(parseValidateOutput(sample)).toEqual([]);
  });

  it("drops environmental plugin-load errors (Bug 3 — not a best-practice defect)", () => {
    // after `terraform init`, a crashed/absent provider plugin surfaces as an
    // error diagnostic; it must not become a false-positive correctness concern.
    const sample = JSON.stringify({
      diagnostics: [
        {
          severity: "error",
          summary: "Failed to load plugin schemas",
          detail: "plugin did not respond",
        },
      ],
    });
    expect(parseValidateOutput(sample)).toEqual([]);
  });
});

describe("concern ids", () => {
  const trivy = (file: string, line: number): string =>
    JSON.stringify({
      Results: [
        {
          Target: file,
          Misconfigurations: [
            { AVDID: "r", Severity: "low", Status: "FAIL", CauseMetadata: { StartLine: line } },
          ],
        },
      ],
    });

  it("are stable and content-derived (same input → same id)", () => {
    const a = parseTrivyOutput(trivy("f.tf", 2))[0]!;
    const b = parseTrivyOutput(trivy("f.tf", 2))[0]!;
    expect(a.id).toBe(b.id);
  });

  it("differ when the location differs", () => {
    const mk = (line: number): Concern => parseTrivyOutput(trivy("f.tf", line))[0]!;
    expect(mk(2).id).not.toBe(mk(3).id);
  });
});

describe("path normalization (Bug 1 — portable, repo-relative paths)", () => {
  const trivyTarget = (target: string): string =>
    JSON.stringify({
      Results: [
        {
          Target: target,
          Misconfigurations: [
            { AVDID: "r", Severity: "high", Status: "FAIL", CauseMetadata: { StartLine: 5 } },
          ],
        },
      ],
    });
  const trivyFile = (target: string, cwd: string): string =>
    parseTrivyOutput(trivyTarget(target), cwd)[0]!.location.file;

  it("rewrites an absolute scanner path to repo-relative posix", () => {
    expect(trivyFile("/repo/sub/main.tf", "/repo/sub")).toBe("main.tf");
    expect(trivyFile("D:\\repo\\sub\\net\\vpc.tf", "D:\\repo\\sub")).toBe("net/vpc.tf");
  });

  it("strips checkov's leading-slash path", () => {
    const file = parseCheckovOutput(
      JSON.stringify({
        results: {
          failed_checks: [{ check_id: "CKV_X", file_path: "/main.tf", file_line_range: [5] }],
        },
      }),
      "/repo",
    )[0]!.location.file;
    expect(file).toBe("main.tf");
  });

  it("yields the SAME concern id regardless of the machine's absolute prefix", () => {
    // the core Bug 1 regression: a Linux CI runner and a Windows dev box reported
    // the same logical file under different absolute paths and got different ids.
    const ci = parseTrivyOutput(
      trivyTarget("/home/runner/work/repo/main.tf"),
      "/home/runner/work/repo",
    )[0]!;
    const dev = parseTrivyOutput(
      trivyTarget("D:\\Users\\dev\\repo\\main.tf"),
      "D:\\Users\\dev\\repo",
    )[0]!;
    expect(ci.location.file).toBe("main.tf");
    expect(dev.location.file).toBe("main.tf");
    expect(ci.id).toBe(dev.id);
  });
});

describe("groupConcerns (Bug 2 — one scoped group per file)", () => {
  const concern = (file: string, severity: Concern["severity"], rule_id: string): Concern => ({
    id: `${rule_id}|${file}`,
    source: "trivy",
    rule_id,
    severity,
    category: "security",
    evidence: "x",
    location: { file, line: 1 },
    remediation_hint: null,
  });

  it("groups by file, ranks groups by max severity, and collects ids + rules", () => {
    const groups = groupConcerns([
      concern("main.tf", "low", "tflint:a"),
      concern("main.tf", "high", "trivy:b"),
      concern("vpc.tf", "medium", "trivy:c"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ file: "main.tf", severity: "high", concern_count: 2 });
    expect(groups[1]).toMatchObject({ file: "vpc.tf", severity: "medium", concern_count: 1 });
    expect(groups[0]!.rule_ids).toEqual(["tflint:a", "trivy:b"]);
    expect(groups[0]!.concern_ids).toHaveLength(2);
  });

  it("gives a stable group id for the same file (idempotent branch key)", () => {
    const a = groupConcerns([concern("main.tf", "low", "x")])[0]!;
    const b = groupConcerns([concern("main.tf", "high", "y")])[0]!;
    expect(a.id).toBe(b.id);
  });
});

describe("groupConcernsByRule (§3.11 — one group per rule across files)", () => {
  const concern = (file: string, severity: Concern["severity"], rule_id: string): Concern => ({
    id: `${rule_id}|${file}`,
    source: "trivy",
    rule_id,
    severity,
    category: "security",
    evidence: "x",
    location: { file, line: 1 },
    remediation_hint: null,
  });

  it("groups a single rule's concerns across all files into one group", () => {
    const groups = groupConcernsByRule([
      concern("a.tf", "low", "tflint:missing_tags"),
      concern("b.tf", "low", "tflint:missing_tags"),
      concern("c.tf", "high", "trivy:AVD-1"),
    ]);
    expect(groups).toHaveLength(2);
    const tagGroup = groups.find((g) => g.rule_ids[0] === "tflint:missing_tags")!;
    expect(tagGroup.grouping).toBe("rule");
    expect(tagGroup.files).toEqual(["a.tf", "b.tf"]);
    expect(tagGroup.concern_count).toBe(2);
    expect(tagGroup.file).toBe("2 files");
  });

  it("uses the single filename as the label when a rule fires in one file", () => {
    const [g] = groupConcernsByRule([concern("only.tf", "low", "tflint:x")]);
    expect(g!.file).toBe("only.tf");
    expect(g!.files).toEqual(["only.tf"]);
  });

  it("gives a stable, rule-derived group id distinct from the by-file id", () => {
    const byRule = groupConcernsByRule([concern("a.tf", "low", "tflint:x")])[0]!;
    const byFile = groupConcerns([concern("a.tf", "low", "tflint:x")])[0]!;
    expect(byRule.id).not.toBe(byFile.id);
    // same rule → same id regardless of which files it spans
    const again = groupConcernsByRule([
      concern("a.tf", "low", "tflint:x"),
      concern("z.tf", "low", "tflint:x"),
    ])[0]!;
    expect(again.id).toBe(byRule.id);
  });
});

describe("annotateGroups (§3.9 — autonomy by concern membership, both groupings)", () => {
  const concern = (
    id: string,
    file: string,
    severity: Concern["severity"],
    category: Concern["category"],
  ): Concern => ({
    id,
    source: "trivy",
    rule_id: "trivy:r",
    severity,
    category,
    evidence: "x",
    location: { file, line: 1 },
    remediation_hint: null,
  });

  it("escalates a by-rule group whose concerns include a high security finding", () => {
    const all = [
      concern("1", "a.tf", "high", "security"),
      concern("2", "b.tf", "high", "security"),
    ];
    const groups = groupConcernsByRule(all);
    const annotated = annotateGroups(groups, all, "high");
    expect(annotated[0]!.autonomy).toBe("needs-human");
  });

  it("marks a low-severity style group auto", () => {
    const all = [concern("1", "a.tf", "low", "style")];
    expect(annotateGroups(groupConcerns(all), all, "high")[0]!.autonomy).toBe("auto");
  });
});

describe("planBatches (§3.10 — atomic vs batched PRs)", () => {
  const grp = (id: string, severity: Concern["severity"], autonomy: "auto" | "needs-human") => ({
    id,
    file: `${id}.tf`,
    severity,
    concern_count: 1,
    rule_ids: ["r"],
    concern_ids: [id],
    autonomy,
  });

  it("batches low/info auto groups and isolates the rest", () => {
    const plan = planBatches([
      grp("a", "low", "auto"),
      grp("b", "info", "auto"),
      grp("c", "high", "auto"), // higher severity → isolated
      grp("d", "low", "needs-human"), // escalated → isolated even though low
    ]);
    expect(plan.batchable).toEqual(["a", "b"]);
    expect(plan.isolated).toEqual(["c", "d"]);
    expect(plan.batch_branch).toMatch(/^remediate\/batch-[0-9a-f]{12}$/);
  });

  it("does not create a batch branch for fewer than two batchable groups", () => {
    expect(
      planBatches([grp("a", "low", "auto"), grp("c", "high", "auto")]).batch_branch,
    ).toBeNull();
  });

  it("is deterministic for the same member set regardless of order", () => {
    const a = planBatches([grp("x", "low", "auto"), grp("y", "info", "auto")]).batch_branch;
    const b = planBatches([grp("y", "info", "auto"), grp("x", "low", "auto")]).batch_branch;
    expect(a).toBe(b);
  });
});

describe("ruleDocUrl (§5.17)", () => {
  const c = (rule_id: string, remediation_hint: string | null) => ({ rule_id, remediation_hint });

  it("prefers an explicit URL remediation_hint", () => {
    expect(ruleDocUrl(c("checkov:CKV_AWS_18", "https://docs.example/ckv"))).toBe(
      "https://docs.example/ckv",
    );
  });

  it("derives the Aqua AVD page for a trivy rule with no hint URL", () => {
    expect(ruleDocUrl(c("trivy:AVD-AWS-0088", null))).toBe(
      "https://avd.aquasec.com/misconfig/avd-aws-0088",
    );
  });

  it("returns null when there is no URL hint and no known pattern", () => {
    expect(ruleDocUrl(c("checkov:CKV_AWS_18", "enable encryption"))).toBeNull();
    expect(ruleDocUrl(c("terraform-fmt:unformatted", null))).toBeNull();
  });
});

describe("parseRequiredProviders (§4.15)", () => {
  it("parses the object form with source + version and resolves the major", () => {
    const hcl = `
      terraform {
        required_providers {
          aws = {
            source  = "hashicorp/aws"
            version = "~> 5.0"
          }
          random = {
            source  = "hashicorp/random"
            version = ">= 3.1, < 4.0"
          }
        }
      }`;
    expect(parseRequiredProviders(hcl)).toEqual([
      { name: "aws", source: "hashicorp/aws", version: "~> 5.0", major: 5 },
      { name: "random", source: "hashicorp/random", version: ">= 3.1, < 4.0", major: 3 },
    ]);
  });

  it("parses the legacy string form", () => {
    const hcl = `required_providers { aws = "~> 4.0" }`;
    expect(parseRequiredProviders(hcl)).toEqual([
      { name: "aws", source: null, version: "~> 4.0", major: 4 },
    ]);
  });

  it("does not mistake an object's inner source/version lines for providers", () => {
    const hcl = `required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }`;
    const out = parseRequiredProviders(hcl);
    expect(out.map((p) => p.name)).toEqual(["aws"]);
  });

  it("returns nothing when there is no required_providers block", () => {
    expect(parseRequiredProviders('resource "aws_s3_bucket" "b" {}')).toEqual([]);
  });

  it("dedups a provider declared in more than one block (first wins)", () => {
    const hcl = `
      required_providers { aws = { version = "~> 5.0" } }
      required_providers { aws = { version = "~> 4.0" } }`;
    const out = parseRequiredProviders(hcl);
    expect(out).toHaveLength(1);
    expect(out[0]!.major).toBe(5);
  });
});

describe("classifyCostEscalation (§4.16-next)", () => {
  it("escalates when the increase meets or exceeds the threshold", () => {
    expect(classifyCostEscalation(50, 25).escalate).toBe(true);
    expect(classifyCostEscalation(25, 25).escalate).toBe(true);
  });

  it("does not escalate below the threshold, on a decrease, or with no threshold", () => {
    expect(classifyCostEscalation(10, 25).escalate).toBe(false);
    expect(classifyCostEscalation(-30, 25).escalate).toBe(false);
    expect(classifyCostEscalation(100, undefined).escalate).toBe(false);
    expect(classifyCostEscalation(null, 25).escalate).toBe(false);
  });
});

describe("rebaseConcern (multi-root — re-base a per-root concern onto cwd)", () => {
  const concern = (file: string): Concern => ({
    id: "orig",
    source: "terraform-validate",
    rule_id: "terraform-validate:Reference to undeclared resource",
    severity: "high",
    category: "correctness",
    evidence: "e",
    location: { file, line: 12 },
    remediation_hint: null,
  });

  it("prefixes the root's relDir and recomputes the id (so ✗→✓ stays consistent)", () => {
    const c = rebaseConcern(concern("main.tf"), "terraform/core");
    expect(c.location.file).toBe("terraform/core/main.tf");
    expect(c.id).not.toBe("orig");
    // deterministic: re-basing the same input yields the same id.
    expect(rebaseConcern(concern("main.tf"), "terraform/core").id).toBe(c.id);
  });

  it("is a no-op when the root IS cwd (relDir empty)", () => {
    const c = concern("main.tf");
    expect(rebaseConcern(c, "")).toBe(c);
  });
});

describe("aggregatePlans (multi-root plan aggregation)", () => {
  const ps = (over: Partial<ReturnType<typeof parseTerraformPlanJson>>) =>
    ({
      add: 0,
      change: 0,
      destroy: 0,
      changed: [],
      destructive: [],
      hasDestroyOrReplace: false,
      ...over,
    }) as ReturnType<typeof parseTerraformPlanJson>;

  it("sums counts and unions changed/destructive across roots", () => {
    const roots: RootPlan[] = [
      {
        dir: "terraform",
        summary: ps({ add: 1, changed: [{ address: "aws_s3_bucket.a", action: "create" }] }),
        stable: true,
      },
      {
        dir: "terraform/core",
        summary: ps({
          destroy: 1,
          changed: [{ address: "aws_db_instance.db", action: "delete" }],
          destructive: [{ address: "aws_db_instance.db", action: "delete" }],
          hasDestroyOrReplace: true,
        }),
        stable: true,
      },
    ];
    const agg = aggregatePlans(roots);
    expect(agg).toMatchObject({ add: 1, destroy: 1, hasDestroyOrReplace: true });
    expect(agg.changed).toHaveLength(2);
    expect(agg.destructive).toEqual([{ address: "aws_db_instance.db", action: "delete" }]);
  });

  it("is non-idempotent if ANY root's plan was unstable", () => {
    expect(aggregatePlans([{ dir: "a", summary: ps({}), stable: true }]).idempotent).toBe(true);
    expect(
      aggregatePlans([
        { dir: "a", summary: ps({}), stable: true },
        { dir: "b", summary: ps({ change: 1 }), stable: false },
      ]).idempotent,
    ).toBe(false);
  });

  it("passes a single root straight through", () => {
    const agg = aggregatePlans([{ dir: ".", summary: ps({ add: 3, change: 2 }), stable: true }]);
    expect(agg).toMatchObject({ add: 3, change: 2, destroy: 0, idempotent: true });
  });
});

describe("resolveRoots (multi-root discovery → operate list)", () => {
  it("returns one root per provider/backend dir, with relDir + absDir", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-resolve-"));
    mkdirSync(join(root, "terraform"), { recursive: true });
    mkdirSync(join(root, "terraform", "core"), { recursive: true });
    writeFileSync(join(root, "terraform", "providers.tf"), 'provider "aws" {}');
    writeFileSync(join(root, "terraform", "core", "providers.tf"), 'provider "aws" {}');
    const roots = resolveRoots(root);
    expect(roots.map((r) => r.relDir)).toEqual(["terraform", "terraform/core"]);
    expect(roots[0]!.absDir).toBe(join(root, "terraform"));
    rmSync(root, { recursive: true, force: true });
  });

  it("falls back to cwd itself as a single root when none is detected", () => {
    const root = mkdtempSync(join(tmpdir(), "tf-resolve-none-"));
    writeFileSync(join(root, "main.tf"), 'resource "aws_s3_bucket" "b" {}');
    expect(resolveRoots(root)).toEqual([{ absDir: root, relDir: "" }]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("computeRemediationVerdict (C2 — independently re-verifiable ✗→✓)", () => {
  it("verifies when every original concern id is gone from the re-scan", () => {
    const verdict = computeRemediationVerdict(["a", "b", "c"], new Set(["x", "y"]));
    expect(verdict).toEqual({ verified: true, resolved: ["a", "b", "c"], remaining: [] });
  });

  it("does NOT verify when a concern is still present — the claim can't outrun the re-scan", () => {
    // the core C2 regression: even if the agent asserts success, a concern still
    // present in the fresh scan lands in `remaining` and `verified` is false.
    const verdict = computeRemediationVerdict(["a", "b"], new Set(["b"]));
    expect(verdict.verified).toBe(false);
    expect(verdict.resolved).toEqual(["a"]);
    expect(verdict.remaining).toEqual(["b"]);
  });

  it("reports all remaining when nothing was fixed", () => {
    const verdict = computeRemediationVerdict(["a", "b"], new Set(["a", "b", "c"]));
    expect(verdict.verified).toBe(false);
    expect(verdict.remaining).toEqual(["a", "b"]);
    expect(verdict.resolved).toEqual([]);
  });

  it("verifies vacuously for an empty concern set", () => {
    expect(computeRemediationVerdict([], new Set(["a"]))).toEqual({
      verified: true,
      resolved: [],
      remaining: [],
    });
  });
});

describe("parseReviewerFindings", () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    category: "security",
    source: "checkov",
    rule_id: "checkov:CKV_AWS_18",
    state: "verified",
    severity: "high",
    evidence: "S3 bucket has no access logging",
    location: { file: "main.tf", line: 5 },
    remediation_hint: "enable access logging",
    ...over,
  });
  const report = (findings: unknown[]) => JSON.stringify({ schema_version: "1.0", findings });

  it("maps a finding to a Concern, keeping the namespaced rule_id", () => {
    const [c] = parseReviewerFindings(report([finding()]));
    expect(c).toMatchObject({
      source: "checkov",
      rule_id: "checkov:CKV_AWS_18",
      severity: "high",
      category: "security",
      evidence: "S3 bucket has no access logging",
      location: { file: "main.tf", line: 5 },
      remediation_hint: "enable access logging",
    });
  });

  it("reproduces the SAME content id Terramend's own checkov scan produces (✗→✓ verifiable)", () => {
    // a reviewer checkov finding and Terramend's own checkov output for the same
    // rule/file/line must hash to the same id, or verify can never confirm it.
    const [reviewer] = parseReviewerFindings(report([finding()]));
    const [own] = parseCheckovOutput(
      JSON.stringify({
        results: {
          failed_checks: [
            {
              check_id: "CKV_AWS_18",
              check_name: "S3 bucket has no access logging",
              file_path: "/main.tf",
              file_line_range: [5, 7],
            },
          ],
        },
      }),
    );
    expect(reviewer!.id).toBe(own!.id);
  });

  it("maps the same id whether the reviewer rule_id is namespaced or bare", () => {
    const [namespaced] = parseReviewerFindings(
      report([finding({ rule_id: "checkov:CKV_AWS_18" })]),
    );
    const [bare] = parseReviewerFindings(report([finding({ rule_id: "CKV_AWS_18" })]));
    expect(namespaced!.id).toBe(bare!.id);
  });

  it("collapses reviewer-exclusive sources (tfsec/infracost/llm) to `reviewer`", () => {
    expect(
      parseReviewerFindings(report([finding({ source: "tfsec", rule_id: "tfsec:AWS017" })]))[0]!
        .source,
    ).toBe("reviewer");
    expect(parseReviewerFindings(report([finding({ source: "llm" })]))[0]!.source).toBe("reviewer");
  });

  it("keeps known scanners (trivy/tflint) as themselves", () => {
    expect(
      parseReviewerFindings(
        report([finding({ source: "trivy", rule_id: "trivy:AVD-AWS-0088" })]),
      )[0]!.source,
    ).toBe("trivy");
    expect(
      parseReviewerFindings(report([finding({ source: "tflint", rule_id: "tflint:foo" })]))[0]!
        .source,
    ).toBe("tflint");
  });

  it("drops human_only findings (out of scope — not auto-remediable)", () => {
    const concerns = parseReviewerFindings(
      report([finding(), finding({ state: "human_only", rule_id: "checkov:CKV_AWS_99" })]),
    );
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.rule_id).toBe("checkov:CKV_AWS_18");
  });

  it("maps the cost category and defaults unknown categories to correctness", () => {
    expect(
      parseReviewerFindings(report([finding({ category: "cost", source: "infracost" })]))[0]!
        .category,
    ).toBe("cost");
    expect(parseReviewerFindings(report([finding({ category: "weird" })]))[0]!.category).toBe(
      "correctness",
    );
  });

  it("drops findings not keyed to a Terraform file (e.g. infracost cost findings on a directory)", () => {
    const concerns = parseReviewerFindings(
      report([
        finding({
          category: "cost",
          source: "infracost",
          rule_id: "infracost:monthly-delta",
          location: { file: "infra/", line: null },
        }),
        finding(),
      ]),
    );
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.location.file).toBe("main.tf");
  });

  it("normalizes absolute scanner paths to repo-relative POSIX", () => {
    const [c] = parseReviewerFindings(
      report([finding({ location: { file: "/repo/main.tf", line: 1 } })]),
      "/repo",
    );
    expect(c!.location.file).toBe("main.tf");
  });

  it("returns nothing for an empty or findings-less report", () => {
    expect(parseReviewerFindings("")).toEqual([]);
    expect(parseReviewerFindings(JSON.stringify({ schema_version: "1.0" }))).toEqual([]);
  });
});

describe("SARIF ingestion (read_findings)", () => {
  const sarif = (driver: string, results: unknown[], rules: unknown[] = []) =>
    JSON.stringify({
      version: "2.1.0",
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      runs: [{ tool: { driver: { name: driver, rules } }, results }],
    });

  it("detects a SARIF report vs a reviewer findings.json", () => {
    expect(isSarif(JSON.parse(sarif("Trivy", [])))).toBe(true);
    expect(isSarif({ schema_version: "1.0", findings: [] })).toBe(false);
    expect(isSarif(null)).toBe(false);
  });

  it("maps a Trivy SARIF result to a concern with a reproducible id", () => {
    const report = sarif(
      "Trivy",
      [
        {
          ruleId: "AVD-AWS-0088",
          level: "error",
          message: { text: "Bucket is not encrypted" },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: "main.tf" }, region: { startLine: 5 } },
            },
          ],
        },
      ],
      [{ id: "AVD-AWS-0088", helpUri: "https://avd.aquasec.com/misconfig/avd-aws-0088" }],
    );
    const [c] = parseSarifFindings(report);
    expect(c).toMatchObject({
      source: "trivy",
      rule_id: "trivy:AVD-AWS-0088",
      severity: "high",
      category: "security",
      location: { file: "main.tf", line: 5 },
      remediation_hint: "https://avd.aquasec.com/misconfig/avd-aws-0088",
    });
    // same id Terramend's own trivy scan of the same rule/file/line produces.
    const [own] = parseTrivyOutput(
      JSON.stringify({
        Results: [
          {
            Target: "main.tf",
            Misconfigurations: [
              {
                AVDID: "AVD-AWS-0088",
                Severity: "HIGH",
                Status: "FAIL",
                CauseMetadata: { StartLine: 5 },
              },
            ],
          },
        ],
      }),
    );
    expect(c!.id).toBe(own!.id);
  });

  it("uses security-severity to refine the level when present", () => {
    const report = sarif("Checkov", [
      {
        ruleId: "CKV_AWS_18",
        level: "warning",
        message: { text: "x" },
        properties: { "security-severity": "9.1" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "a.tf" }, region: { startLine: 1 } } },
        ],
      },
    ]);
    expect(parseSarifFindings(report)[0]!.severity).toBe("critical");
  });

  it("drops non-Terraform files and tolerates an empty report", () => {
    const report = sarif("Trivy", [
      {
        ruleId: "X",
        level: "error",
        message: { text: "y" },
        locations: [{ physicalLocation: { artifactLocation: { uri: "Dockerfile" } } }],
      },
    ]);
    expect(parseSarifFindings(report)).toEqual([]);
    expect(parseSarifFindings("{}")).toEqual([]);
  });

  it("parseFindingsFile dispatches to the right parser", () => {
    const sarifReport = sarif("Trivy", [
      {
        ruleId: "AVD-AWS-1",
        level: "error",
        message: { text: "z" },
        locations: [
          { physicalLocation: { artifactLocation: { uri: "main.tf" }, region: { startLine: 2 } } },
        ],
      },
    ]);
    expect(parseFindingsFile(sarifReport)[0]!.source).toBe("trivy");
    const reviewer = JSON.stringify({
      schema_version: "1.0",
      findings: [
        {
          source: "checkov",
          rule_id: "checkov:CKV_AWS_18",
          severity: "high",
          location: { file: "main.tf", line: 5 },
        },
      ],
    });
    expect(parseFindingsFile(reviewer)[0]!.source).toBe("checkov");
  });
});

describe("parseInfracostResources (resource-level cost breakdown)", () => {
  it("extracts and sorts per-resource monthly costs (most expensive first)", () => {
    const json = JSON.stringify({
      projects: [
        {
          breakdown: {
            resources: [
              { name: "aws_instance.web", monthlyCost: "12.40" },
              { name: "aws_db_instance.db", monthlyCost: "120.00" },
              { name: "aws_s3_bucket.logs", monthlyCost: null },
              { name: "aws_iam_role.r", monthlyCost: "0" },
            ],
          },
        },
      ],
    });
    expect(parseInfracostResources(json)).toEqual([
      { name: "aws_db_instance.db", monthlyCost: 120 },
      { name: "aws_instance.web", monthlyCost: 12.4 },
    ]);
  });

  it("tolerates empty / malformed input", () => {
    expect(parseInfracostResources("")).toEqual([]);
    expect(parseInfracostResources("not json")).toEqual([]);
    expect(parseInfracostResources(JSON.stringify({ projects: [] }))).toEqual([]);
  });
});

describe("isTerraformConcern", () => {
  const at = (file: string): Concern => ({
    id: "x",
    source: "checkov",
    rule_id: "checkov:CKV_X",
    severity: "high",
    category: "security",
    evidence: "e",
    location: { file, line: 1 },
    remediation_hint: null,
  });

  it("keeps .tf and .tfvars concerns", () => {
    expect(isTerraformConcern(at("main.tf"))).toBe(true);
    expect(isTerraformConcern(at("modules/net/vpc.tf"))).toBe(true);
    expect(isTerraformConcern(at("envs/prod.tfvars"))).toBe(true);
    expect(isTerraformConcern(at("MAIN.TF"))).toBe(true);
  });

  it("drops non-Terraform concerns (checkov github_actions, trivy dockerfile)", () => {
    expect(isTerraformConcern(at(".github/workflows/ci.yml"))).toBe(false);
    expect(isTerraformConcern(at("Dockerfile"))).toBe(false);
    expect(isTerraformConcern(at("k8s/deployment.yaml"))).toBe(false);
    expect(isTerraformConcern(at("(unknown)"))).toBe(false);
  });
});

describe("collectCloudCredentials", () => {
  const touched = [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of touched) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("passes real cloud creds to terraform but NOT LLM/provider secret keys", () => {
    process.env.AWS_ACCESS_KEY_ID = "akia";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/creds.json";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "gemini-key"; // must NOT leak (Gemini LLM key)
    process.env.GEMINI_API_KEY = "gemini-key-2"; // must NOT leak
    process.env.ANTHROPIC_API_KEY = "anthropic-key"; // must NOT leak
    process.env.OPENAI_API_KEY = "openai-key"; // must NOT leak (BYOK is multi-provider)
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-key"; // must NOT leak — Bedrock LLM key, despite AWS_ prefix
    process.env.AWS_REGION = "eu-west-1"; // MUST pass — a legit terraform/cloud setting

    const env = collectCloudCredentials();
    expect(env.AWS_ACCESS_KEY_ID).toBe("akia");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/creds.json");
    expect(env.AWS_REGION).toBe("eu-west-1");
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });
});

describe("resourceTypeOf", () => {
  it("extracts the type from a plain address", () => {
    expect(resourceTypeOf("aws_db_instance.main")).toBe("aws_db_instance");
  });

  it("strips module prefixes and index/key suffixes", () => {
    expect(resourceTypeOf("module.db.aws_db_instance.main")).toBe("aws_db_instance");
    expect(resourceTypeOf('aws_s3_bucket.data["prod"]')).toBe("aws_s3_bucket");
    expect(resourceTypeOf("module.a.module.b.google_storage_bucket.x[0]")).toBe(
      "google_storage_bucket",
    );
  });

  it("returns '' for an unparseable address", () => {
    expect(resourceTypeOf("nodots")).toBe("");
  });
});

describe("classifyDestructive (§2.5 — stateful vs ephemeral destroy/replace)", () => {
  it("routes data-bearing types to stateful and recreatable types to ephemeral", () => {
    const out = classifyDestructive([
      { address: "aws_db_instance.main", action: "delete" },
      { address: "module.web.aws_instance.app", action: "replace" },
      { address: 'aws_s3_bucket.data["prod"]', action: "replace" },
    ]);
    expect(out.stateful.map((r) => r.address)).toEqual([
      "aws_db_instance.main",
      'aws_s3_bucket.data["prod"]',
    ]);
    expect(out.stateful[0]).toMatchObject({ type: "aws_db_instance", action: "delete" });
    expect(out.ephemeral.map((r) => r.address)).toEqual(["module.web.aws_instance.app"]);
  });

  it("returns empty partitions for an empty destructive set", () => {
    expect(classifyDestructive([])).toEqual({ stateful: [], ephemeral: [] });
  });
});

describe("parseTerraformPlanJson", () => {
  const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

  it("reads add/change/destroy from change_summary", () => {
    const out = lines(
      { "@level": "info", type: "version" },
      { type: "change_summary", changes: { add: 2, change: 1, remove: 0, operation: "plan" } },
    );
    const s = parseTerraformPlanJson(out);
    expect(s).toMatchObject({ add: 2, change: 1, destroy: 0, hasDestroyOrReplace: false });
    expect(s.destructive).toEqual([]);
  });

  it("collects deleted and replaced resources as destructive", () => {
    const out = lines(
      {
        type: "planned_change",
        change: { action: "create", resource: { addr: "aws_s3_bucket.a" } },
      },
      {
        type: "planned_change",
        change: { action: "delete", resource: { addr: "aws_db_instance.db" } },
      },
      {
        type: "planned_change",
        change: { action: "replace", resource: { addr: "aws_instance.web" } },
      },
      { type: "change_summary", changes: { add: 1, change: 0, remove: 2 } },
    );
    const s = parseTerraformPlanJson(out);
    expect(s.destroy).toBe(2);
    expect(s.hasDestroyOrReplace).toBe(true);
    expect(s.destructive).toEqual([
      { address: "aws_db_instance.db", action: "delete" },
      { address: "aws_instance.web", action: "replace" },
    ]);
  });

  it("treats *-then-delete forms as destructive", () => {
    const out = lines({
      type: "planned_change",
      change: { action: "create-then-delete", resource: { addr: "aws_instance.web" } },
    });
    expect(parseTerraformPlanJson(out).hasDestroyOrReplace).toBe(true);
  });

  it("ignores non-JSON / non-plan lines and tolerates empty output", () => {
    expect(parseTerraformPlanJson("not json\n\nProviders required...\n")).toEqual({
      add: 0,
      change: 0,
      destroy: 0,
      changed: [],
      destructive: [],
      hasDestroyOrReplace: false,
    });
    expect(parseTerraformPlanJson("")).toMatchObject({ add: 0, hasDestroyOrReplace: false });
  });

  it("collects every real action into `changed`, ignoring no-op / read", () => {
    const out = lines(
      {
        type: "planned_change",
        change: { action: "create", resource: { addr: "aws_s3_bucket.a" } },
      },
      {
        type: "planned_change",
        change: { action: "update", resource: { addr: "aws_instance.web" } },
      },
      { type: "planned_change", change: { action: "no-op", resource: { addr: "aws_vpc.main" } } },
      {
        type: "planned_change",
        change: { action: "read", resource: { addr: "data.aws_ami.ubuntu" } },
      },
    );
    expect(parseTerraformPlanJson(out).changed).toEqual([
      { address: "aws_s3_bucket.a", action: "create" },
      { address: "aws_instance.web", action: "update" },
    ]);
  });

  it("ignores terraform's REAL no-op spelling `noop` (bug: was checking `no-op` only)", () => {
    // the machine-readable UI emits `"noop"` (no hyphen) for unchanged resources;
    // a `move` / `import` / `forget` is a state-only op that doesn't mutate live
    // infra. None should land in `changed` (they'd inflate the blast radius §2.6).
    const out = lines(
      { type: "planned_change", change: { action: "noop", resource: { addr: "aws_vpc.main" } } },
      { type: "planned_change", change: { action: "move", resource: { addr: "aws_s3_bucket.a" } } },
      {
        type: "planned_change",
        change: { action: "import", resource: { addr: "aws_s3_bucket.b" } },
      },
      {
        type: "planned_change",
        change: { action: "forget", resource: { addr: "aws_s3_bucket.c" } },
      },
      {
        type: "planned_change",
        change: { action: "update", resource: { addr: "aws_instance.web" } },
      },
    );
    expect(parseTerraformPlanJson(out).changed).toEqual([
      { address: "aws_instance.web", action: "update" },
    ]);
  });
});

describe("computeRegressions (§1.4)", () => {
  it("returns ids present now but absent from the baseline (current − baseline)", () => {
    expect(computeRegressions(["a", "b"], ["b", "c", "d"])).toEqual(["c", "d"]);
  });

  it("is empty when the fix introduced nothing new (even if it didn't resolve everything)", () => {
    expect(computeRegressions(["a", "b", "c"], ["a", "b"])).toEqual([]);
  });

  it("sorts and de-dups its output for a stable PR body", () => {
    expect(computeRegressions(new Set(["a"]), ["z", "c", "c", "m"])).toEqual(["c", "m", "z"]);
  });

  it("treats an empty baseline as everything-new", () => {
    expect(computeRegressions([], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("classifyAutonomy (§3.9)", () => {
  const c = (severity: Concern["severity"], category: Concern["category"]) => ({
    severity,
    category,
  });

  it("auto-fixes trivial style/correctness findings", () => {
    const d = classifyAutonomy([c("low", "style"), c("medium", "correctness")]);
    expect(d.autonomy).toBe("auto");
    expect(d.reasons).toEqual([]);
  });

  it("escalates a high/critical security finding (default threshold high)", () => {
    expect(classifyAutonomy([c("high", "security")]).autonomy).toBe("needs-human");
    expect(classifyAutonomy([c("critical", "security")]).autonomy).toBe("needs-human");
  });

  it("does NOT escalate a medium/low security finding at the default threshold", () => {
    expect(classifyAutonomy([c("medium", "security")]).autonomy).toBe("auto");
    expect(classifyAutonomy([c("low", "security")]).autonomy).toBe("auto");
  });

  it("respects a lowered threshold", () => {
    expect(classifyAutonomy([c("medium", "security")], "medium").autonomy).toBe("needs-human");
  });

  it("a non-security finding never escalates on severity alone", () => {
    expect(classifyAutonomy([c("critical", "correctness")]).autonomy).toBe("auto");
  });

  it("a high blast radius escalates regardless of severity (§2.6 override)", () => {
    const d = classifyAutonomy([c("low", "style")], "high", "high");
    expect(d.autonomy).toBe("needs-human");
    expect(d.reasons.join(" ")).toMatch(/blast radius/);
  });

  it("medium/low blast radius does not escalate", () => {
    expect(classifyAutonomy([c("low", "style")], "high", "medium").autonomy).toBe("auto");
  });
});

describe("classifyRefusal (§29 — honest refusal)", () => {
  const c = (rule_id: string, evidence: string) => ({ rule_id, evidence });

  it("flags IAM least-privilege / wildcard concerns", () => {
    expect(
      classifyRefusal(c("checkov:CKV_AWS_1", 'IAM policy allows all actions with "*"')).refuse,
    ).toBe(true);
    expect(classifyRefusal(c("trivy:AVD-AWS-9", "ensure least-privilege IAM")).refuse).toBe(true);
  });

  it("flags KMS key-policy and real-CIDR decisions", () => {
    expect(
      classifyRefusal(c("checkov:CKV_AWS_2", "the KMS key policy is too permissive")).refuse,
    ).toBe(true);
    expect(
      classifyRefusal(c("trivy:AVD-AWS-3", "restrict ingress to an allowed CIDR")).refuse,
    ).toBe(true);
  });

  it("does NOT flag a mechanical secure-default fix", () => {
    expect(
      classifyRefusal(c("trivy:AVD-AWS-0088", "S3 bucket is not encrypted at rest")).refuse,
    ).toBe(false);
    expect(classifyRefusal(c("checkov:CKV_AWS_18", "S3 access logging is disabled")).refuse).toBe(
      false,
    );
  });
});

describe("buildRefusalReport (§29)", () => {
  it("produces a structured non-fix issue body with location, why, and next step", () => {
    const body = buildRefusalReport({
      concern: {
        rule_id: "checkov:CKV_AWS_1",
        evidence: "wildcard IAM action",
        location: { file: "iam.tf", line: 12 },
      },
      whyNoAutoFix: "the exact action set is unknown",
      humanAction: "scope the policy to the actions the workload uses",
    });
    expect(body).toContain("iam.tf:12");
    expect(body).toContain("wildcard IAM action");
    expect(body).toContain("the exact action set is unknown");
    expect(body).toContain("scope the policy to the actions the workload uses");
  });

  it("omits the line when there is none", () => {
    const body = buildRefusalReport({
      concern: { rule_id: "r", evidence: "e", location: { file: "main.tf", line: null } },
      whyNoAutoFix: "w",
      humanAction: "h",
    });
    expect(body).toContain("`main.tf`");
    expect(body).not.toContain("main.tf:");
  });
});

describe("preventiveControlFor (§21 — fix once, prevent forever)", () => {
  it("suggests a Checkov hard-fail for a checkov rule", () => {
    const p = preventiveControlFor({ source: "checkov", rule_id: "checkov:CKV_AWS_18" })!;
    expect(p.mechanism).toMatch(/Checkov/);
    expect(p.snippet).toContain("CKV_AWS_18");
  });

  it("suggests a tflint rule block and a trivy gate", () => {
    expect(
      preventiveControlFor({ source: "tflint", rule_id: "tflint:terraform_unused" })!.snippet,
    ).toContain('rule "terraform_unused"');
    expect(
      preventiveControlFor({ source: "trivy", rule_id: "trivy:AVD-AWS-1" })!.mechanism,
    ).toMatch(/Trivy/);
  });

  it("returns null for the reviewer source (no natural CI gate)", () => {
    expect(preventiveControlFor({ source: "reviewer", rule_id: "reviewer:x" })).toBeNull();
  });
});

describe("clusterByLocation (§30 — cross-tool co-location)", () => {
  const mk = (
    id: string,
    source: Concern["source"],
    file: string,
    line: number | null,
  ): Concern => ({
    id,
    source,
    rule_id: `${source}:r`,
    severity: "high",
    category: "security",
    evidence: "x",
    location: { file, line },
    remediation_hint: null,
  });

  it("clusters concerns from different scanners at the same file:line", () => {
    const clusters = clusterByLocation([
      mk("1", "trivy", "main.tf", 5),
      mk("2", "checkov", "main.tf", 5),
      mk("3", "tflint", "vpc.tf", 9),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ file: "main.tf", line: 5, sources: ["checkov", "trivy"] });
    expect(clusters[0]!.concern_ids).toEqual(["1", "2"]);
  });

  it("does not cluster a single scanner's concerns or null-line concerns", () => {
    expect(
      clusterByLocation([mk("1", "trivy", "main.tf", 5), mk("2", "trivy", "main.tf", 5)]),
    ).toEqual([]);
    expect(
      clusterByLocation([mk("1", "trivy", "main.tf", null), mk("2", "checkov", "main.tf", null)]),
    ).toEqual([]);
  });
});

describe("shouldSuggestInline (§5.18)", () => {
  const base = {
    hasPrContext: true,
    severity: "low" as const,
    fileCount: 1,
    hunkCount: 1,
    blastTier: "low" as const,
  };

  it("suggests inline for a single-hunk low-risk fix on an existing PR", () => {
    expect(shouldSuggestInline(base).suggest).toBe(true);
    expect(shouldSuggestInline({ ...base, severity: "info" }).suggest).toBe(true);
  });

  it("does not suggest without an existing PR context", () => {
    expect(shouldSuggestInline({ ...base, hasPrContext: false }).suggest).toBe(false);
  });

  it("does not suggest for higher-severity fixes", () => {
    expect(shouldSuggestInline({ ...base, severity: "high" }).suggest).toBe(false);
    expect(shouldSuggestInline({ ...base, severity: "medium" }).suggest).toBe(false);
  });

  it("does not suggest for multi-hunk / multi-file fixes", () => {
    expect(shouldSuggestInline({ ...base, hunkCount: 2 }).suggest).toBe(false);
    expect(shouldSuggestInline({ ...base, fileCount: 2 }).suggest).toBe(false);
  });

  it("does not suggest for a medium/high blast radius", () => {
    expect(shouldSuggestInline({ ...base, blastTier: "high" }).suggest).toBe(false);
    expect(shouldSuggestInline({ ...base, blastTier: "medium" }).suggest).toBe(false);
  });

  it("tolerates an unknown blast tier (plan didn't run)", () => {
    expect(shouldSuggestInline({ ...base, blastTier: undefined }).suggest).toBe(true);
  });
});

describe("computeConfidence (§5.19)", () => {
  it("is high for a fully-proven fix (verified, no regressions, idempotent, low blast, no cost rise)", () => {
    expect(
      computeConfidence({
        verified: true,
        regressionCount: 0,
        idempotent: true,
        blastTier: "low",
        costDirection: "no-change",
      }).level,
    ).toBe("high");
  });

  it("is low when the fix did not verify", () => {
    expect(computeConfidence({ verified: false, regressionCount: 0 }).level).toBe("low");
  });

  it("is low when the fix introduced a regression, even if verified", () => {
    expect(computeConfidence({ verified: true, regressionCount: 2 }).level).toBe("low");
  });

  it("caps at medium for a non-deterministic plan", () => {
    expect(
      computeConfidence({
        verified: true,
        regressionCount: 0,
        idempotent: false,
        blastTier: "low",
        costDirection: "no-change",
      }).level,
    ).toBe("medium");
  });

  it("caps at medium for a high blast radius or a cost increase", () => {
    expect(
      computeConfidence({
        verified: true,
        regressionCount: 0,
        idempotent: true,
        blastTier: "high",
        costDirection: "no-change",
      }).level,
    ).toBe("medium");
    expect(
      computeConfidence({
        verified: true,
        regressionCount: 0,
        idempotent: true,
        blastTier: "low",
        costDirection: "increase",
      }).level,
    ).toBe("medium");
  });

  it("caps at medium when plan/cost evidence is missing (no cloud creds) — high needs the full stack", () => {
    // verified + no regressions but no plan/infracost ran: honest medium, not high.
    expect(computeConfidence({ verified: true, regressionCount: 0 }).level).toBe("medium");
  });
});

describe("moduleAddressOf", () => {
  it("returns root for a top-level resource", () => {
    expect(moduleAddressOf("aws_s3_bucket.b")).toBe("root");
    expect(moduleAddressOf("aws_s3_bucket.b[0]")).toBe("root");
  });

  it("extracts the module call path, stripping the resource instance index", () => {
    expect(moduleAddressOf("module.db.aws_db_instance.main")).toBe("module.db");
    expect(moduleAddressOf("module.a.module.b.google_storage_bucket.x[0]")).toBe(
      "module.a.module.b",
    );
  });

  it("collapses count/for_each module instances to a single module address", () => {
    expect(moduleAddressOf("module.net[0].aws_vpc.main")).toBe("module.net");
    expect(moduleAddressOf("module.net[1].aws_vpc.main")).toBe("module.net");
    expect(moduleAddressOf('module.net["prod"].aws_vpc.main')).toBe("module.net");
  });
});

describe("computeBlastRadius (§2.6)", () => {
  const res = (...addrs: string[]) => addrs.map((address) => ({ address }));

  it("tiers by resource count: 0-2 low, 3-10 medium, >10 high", () => {
    expect(computeBlastRadius(res()).tier).toBe("low");
    expect(computeBlastRadius(res("aws_s3_bucket.a", "aws_s3_bucket.b")).tier).toBe("low");
    expect(computeBlastRadius(res("a.1", "a.2", "a.3")).tier).toBe("medium");
    const eleven = Array.from({ length: 11 }, (_, i) => ({ address: `aws_instance.n${i}` }));
    expect(computeBlastRadius(eleven).tier).toBe("high");
  });

  it("escalates to high when the change spans more than one module", () => {
    const out = computeBlastRadius(res("aws_s3_bucket.a", "module.net.aws_vpc.main"));
    expect(out.tier).toBe("high");
    expect(out.modules).toEqual(["module.net", "root"]);
    expect(out.resourceCount).toBe(2);
  });

  it("does NOT escalate when count/for_each instances of ONE module change", () => {
    const out = computeBlastRadius(res("module.net[0].aws_vpc.main", "module.net[1].aws_vpc.main"));
    expect(out.modules).toEqual(["module.net"]);
    expect(out.tier).toBe("low");
  });
});

describe("comparePlanStability (§1.3)", () => {
  const plan = (over: Partial<ReturnType<typeof parseTerraformPlanJson>>) =>
    ({
      add: 0,
      change: 0,
      destroy: 0,
      changed: [],
      destructive: [],
      hasDestroyOrReplace: false,
      ...over,
    }) as ReturnType<typeof parseTerraformPlanJson>;

  it("is stable when both plans have the same change set", () => {
    const a = plan({ change: 1, changed: [{ address: "aws_instance.web", action: "update" }] });
    const b = plan({ change: 1, changed: [{ address: "aws_instance.web", action: "update" }] });
    expect(comparePlanStability(a, b).stable).toBe(true);
  });

  it("is unstable when the counts or addresses differ (perpetual-diff smell)", () => {
    const a = plan({ change: 1, changed: [{ address: "aws_instance.web", action: "update" }] });
    const b = plan({ change: 2, changed: [{ address: "aws_instance.web", action: "update" }] });
    const out = comparePlanStability(a, b);
    expect(out.stable).toBe(false);
    expect(out.reason).toMatch(/not deterministic/);
  });

  it("ignores `changed` ordering", () => {
    const a = plan({
      add: 2,
      changed: [
        { address: "aws_s3_bucket.a", action: "create" },
        { address: "aws_s3_bucket.b", action: "create" },
      ],
    });
    const b = plan({
      add: 2,
      changed: [
        { address: "aws_s3_bucket.b", action: "create" },
        { address: "aws_s3_bucket.a", action: "create" },
      ],
    });
    expect(comparePlanStability(a, b).stable).toBe(true);
  });
});

describe("parseInfracostBreakdown", () => {
  it("parses the decimal-string totalMonthlyCost and currency", () => {
    const json = JSON.stringify({ currency: "USD", totalMonthlyCost: "123.45" });
    expect(parseInfracostBreakdown(json)).toEqual({ totalMonthlyCost: 123.45, currency: "USD" });
  });

  it("accepts a numeric totalMonthlyCost and a non-USD currency", () => {
    const json = JSON.stringify({ currency: "GBP", totalMonthlyCost: 10 });
    expect(parseInfracostBreakdown(json)).toEqual({ totalMonthlyCost: 10, currency: "GBP" });
  });

  it("yields null cost (not 0) when nothing is priced, defaulting currency to USD", () => {
    expect(parseInfracostBreakdown(JSON.stringify({}))).toEqual({
      totalMonthlyCost: null,
      currency: "USD",
    });
    expect(parseInfracostBreakdown(JSON.stringify({ totalMonthlyCost: null }))).toEqual({
      totalMonthlyCost: null,
      currency: "USD",
    });
  });

  it("treats empty output as no breakdown", () => {
    expect(parseInfracostBreakdown("")).toEqual({ totalMonthlyCost: null, currency: "USD" });
  });
});

describe("computeCostDelta", () => {
  it("reports an increase, rounded to cents", () => {
    expect(
      computeCostDelta(
        { totalMonthlyCost: 100, currency: "USD" },
        { totalMonthlyCost: 112.405, currency: "USD" },
      ),
    ).toEqual({
      currency: "USD",
      baselineMonthly: 100,
      currentMonthly: 112.405,
      deltaMonthly: 12.41,
      direction: "increase",
    });
  });

  it("reports a decrease", () => {
    const d = computeCostDelta(
      { totalMonthlyCost: 50, currency: "USD" },
      { totalMonthlyCost: 40, currency: "USD" },
    );
    expect(d.deltaMonthly).toBe(-10);
    expect(d.direction).toBe("decrease");
  });

  it("reports no-change when costs are equal", () => {
    const d = computeCostDelta(
      { totalMonthlyCost: 7, currency: "USD" },
      { totalMonthlyCost: 7, currency: "USD" },
    );
    expect(d.deltaMonthly).toBe(0);
    expect(d.direction).toBe("no-change");
  });

  it("is unknown when there is no baseline", () => {
    expect(computeCostDelta(null, { totalMonthlyCost: 30, currency: "USD" })).toEqual({
      currency: "USD",
      baselineMonthly: null,
      currentMonthly: 30,
      deltaMonthly: null,
      direction: "unknown",
    });
  });

  it("is unknown when either side is unpriced, and falls back to the baseline currency", () => {
    expect(
      computeCostDelta(
        { totalMonthlyCost: 5, currency: "GBP" },
        { totalMonthlyCost: null, currency: "" },
      ),
    ).toMatchObject({ currency: "GBP", deltaMonthly: null, direction: "unknown" });
  });
});

describe("parseResourceArguments (§4.15-next)", () => {
  it("extracts top-level attribute + nested-block names, excluding meta-args", () => {
    const hcl = `
      resource "aws_s3_bucket" "b" {
        bucket = "my-bucket"
        count  = 2
        tags   = { Env = "prod" }
        versioning {
          enabled = true
        }
        lifecycle {
          prevent_destroy = true
        }
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect(r.resourceType).toBe("aws_s3_bucket");
    expect(r.name).toBe("b");
    expect([...r.args].sort()).toEqual(["bucket", "tags", "versioning"]);
    // count + lifecycle are meta-arguments, never schema args.
    expect(r.args).not.toContain("count");
    expect(r.args).not.toContain("lifecycle");
  });

  it("reads a dynamic block's label as the generated block name", () => {
    const hcl = `
      resource "aws_security_group" "sg" {
        name = "sg"
        dynamic "ingress" {
          for_each = var.rules
          content { from_port = ingress.value.port }
        }
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect(r.args).toContain("ingress");
    expect(r.args).toContain("name");
    expect(r.args).not.toContain("dynamic");
  });

  it("is not fooled by interpolation braces or commented lines", () => {
    const hcl = `
      resource "aws_instance" "i" {
        ami           = "\${data.aws_ami.x.id}"
        # bogus = "commented out"
        instance_type = "t3.micro"
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect([...r.args].sort()).toEqual(["ami", "instance_type"]);
    expect(r.args).not.toContain("bogus");
  });

  it("does not pick up nested-block attributes as top-level args", () => {
    const hcl = `
      resource "aws_s3_bucket" "b" {
        bucket = "x"
        server_side_encryption_configuration {
          rule {
            apply_server_side_encryption_by_default {
              sse_algorithm = "aws:kms"
            }
          }
        }
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect(r.args).toContain("bucket");
    expect(r.args).toContain("server_side_encryption_configuration");
    expect(r.args).not.toContain("sse_algorithm");
    expect(r.args).not.toContain("rule");
  });

  it("handles multiple resources and ignores non-resource blocks", () => {
    const hcl = `
      variable "x" { type = string }
      resource "aws_s3_bucket" "a" { bucket = "a" }
      resource "aws_s3_bucket" "b" { bucket = "b" }`;
    const rs = parseResourceArguments(hcl);
    expect(rs.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("is not fooled by an escaped quote inside a string value", () => {
    const hcl = `
      resource "aws_iam_role" "r" {
        description = "a \\"quoted\\" word { not a block"
        name        = "r"
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect([...r.args].sort()).toEqual(["description", "name"]);
  });

  it("skips a heredoc body (no fabricated args, no brace corruption)", () => {
    const hcl = `
      resource "aws_iam_role" "r" {
        name               = "r"
        assume_role_policy = <<-EOT
          {
            "Version": "2012-10-17",
            "fake_arg": "should not be parsed"
          }
        EOT
        tags = { Env = "prod" }
      }`;
    const r = parseResourceArguments(hcl)[0]!;
    expect([...r.args].sort()).toEqual(["assume_role_policy", "name", "tags"]);
    expect(r.args).not.toContain("fake_arg");
    expect(r.args).not.toContain("Version");
  });
});

describe("parseTerraformPlanJson (address + summary fallbacks)", () => {
  const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

  it("falls back to resource.resource, then '(unknown)', for the address", () => {
    const out = lines(
      {
        type: "planned_change",
        change: { action: "update", resource: { resource: "aws_instance.web" } },
      },
      { type: "planned_change", change: { action: "update", resource: {} } },
    );
    expect(parseTerraformPlanJson(out).changed).toEqual([
      { address: "aws_instance.web", action: "update" },
      { address: "(unknown)", action: "update" },
    ]);
  });

  it("coerces non-numeric change_summary counts to 0", () => {
    const out = lines({
      type: "change_summary",
      changes: { add: "nope", change: null, remove: undefined },
    });
    expect(parseTerraformPlanJson(out)).toMatchObject({ add: 0, change: 0, destroy: 0 });
  });

  it("skips a planned_change with no action", () => {
    const out = lines({
      type: "planned_change",
      change: { resource: { addr: "aws_s3_bucket.a" } },
    });
    expect(parseTerraformPlanJson(out).changed).toEqual([]);
  });
});

describe("aggregatePlans (empty input)", () => {
  it("returns a zeroed, idempotent aggregate for no roots", () => {
    expect(aggregatePlans([])).toEqual({
      add: 0,
      change: 0,
      destroy: 0,
      changed: [],
      destructive: [],
      hasDestroyOrReplace: false,
      idempotent: true,
    });
  });
});

describe("computeCostDelta (currency fallback)", () => {
  it("defaults to USD when neither side carries a currency", () => {
    const d = computeCostDelta(null, { totalMonthlyCost: 5, currency: "" });
    expect(d.currency).toBe("USD");
  });
});

describe("parseRequiredProviders (constraint edge cases)", () => {
  it("yields a null major for an unconstrained provider", () => {
    const hcl = `required_providers { aws = { source = "hashicorp/aws" } }`;
    expect(parseRequiredProviders(hcl)).toEqual([
      { name: "aws", source: "hashicorp/aws", version: null, major: null },
    ]);
  });

  it("reads a bare integer constraint's major", () => {
    const hcl = `required_providers { aws = { version = "5" } }`;
    expect(parseRequiredProviders(hcl)[0]).toMatchObject({ major: 5 });
  });
});

describe("parseTflintOutput (severity + fallbacks)", () => {
  const issue = (rule: Record<string, unknown> | undefined, message?: string) =>
    JSON.stringify({ issues: [{ rule, message, range: { filename: "a.tf" } }] });

  it("maps error to high and an unknown severity to low", () => {
    const [error] = parseTflintOutput(issue({ name: "r", severity: "error" }));
    expect(error).toMatchObject({ severity: "high" });
    const [notice] = parseTflintOutput(issue({ name: "r", severity: "notice" }));
    expect(notice).toMatchObject({ severity: "low" });
  });

  it("falls back to 'issue' for a missing rule name and a null line", () => {
    const [c] = parseTflintOutput(issue(undefined));
    expect(c).toMatchObject({
      rule_id: "tflint:issue",
      evidence: "issue",
      location: { file: "a.tf", line: null },
    });
  });
});

describe("parseCheckovOutput (missing check id)", () => {
  it("falls back to 'issue' for the rule and evidence", () => {
    const json = JSON.stringify({ results: { failed_checks: [{ file_path: "a.tf" }] } });
    const [c] = parseCheckovOutput(json);
    expect(c).toMatchObject({ rule_id: "checkov:issue", evidence: "issue" });
  });
});

describe("toRepoRelative", () => {
  it("returns '(unknown)' for an empty path and strips ./ prefixes", () => {
    expect(toRepoRelative(undefined, "/repo")).toBe("(unknown)");
    expect(toRepoRelative("", "/repo")).toBe("(unknown)");
    expect(toRepoRelative("./main.tf", "")).toBe("main.tf");
    expect(toRepoRelative("/repo/", "/repo")).toBe("(unknown)");
  });
});

describe("buildSarifReport (SARIF emit)", () => {
  const concern = (over: Partial<Concern> = {}): Concern => ({
    id: "abc123",
    source: "trivy",
    rule_id: "trivy:AVD-AWS-0088",
    severity: "high",
    category: "security",
    evidence: "S3 bucket is not encrypted",
    location: { file: "main.tf", line: 12 },
    remediation_hint: null,
    ...over,
  });

  it("emits a valid SARIF 2.1.0 shape with a terramend driver", () => {
    const report = buildSarifReport([concern()]);
    expect(report.version).toBe("2.1.0");
    expect(report.runs?.[0]?.tool?.driver?.name).toBe("terramend");
    const result = report.runs?.[0]?.results?.[0];
    expect(result?.ruleId).toBe("trivy:AVD-AWS-0088");
    expect(result?.level).toBe("error"); // high → error
    expect(result?.locations?.[0]?.physicalLocation?.artifactLocation?.uri).toBe("main.tf");
    expect(result?.locations?.[0]?.physicalLocation?.region?.startLine).toBe(12);
    expect(result?.properties?.["security-severity"]).toBe("8.0");
  });

  it("maps severities to SARIF levels", () => {
    const levels = (["critical", "high", "medium", "low", "info"] as const).map(
      (severity) => buildSarifReport([concern({ severity })]).runs?.[0]?.results?.[0]?.level,
    );
    expect(levels).toEqual(["error", "error", "warning", "note", "note"]);
  });

  it("dedupes rules and sorts them by id", () => {
    const report = buildSarifReport([
      concern({ rule_id: "trivy:Z", id: "1" }),
      concern({ rule_id: "trivy:A", id: "2" }),
      concern({ rule_id: "trivy:Z", id: "3", location: { file: "b.tf", line: 1 } }),
    ]);
    const ruleIds = report.runs?.[0]?.tool?.driver?.rules?.map((r) => r.id);
    expect(ruleIds).toEqual(["trivy:A", "trivy:Z"]);
  });

  it("omits the region when the concern has no line", () => {
    const report = buildSarifReport([concern({ location: { file: "main.tf", line: null } })]);
    expect(
      report.runs?.[0]?.results?.[0]?.locations?.[0]?.physicalLocation?.region,
    ).toBeUndefined();
  });

  it("is deterministic (re-emit is identical)", () => {
    const cs = [concern(), concern({ rule_id: "checkov:CKV_AWS_19", id: "x" })];
    expect(JSON.stringify(buildSarifReport(cs))).toBe(JSON.stringify(buildSarifReport(cs)));
  });
});
