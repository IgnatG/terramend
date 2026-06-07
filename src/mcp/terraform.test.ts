import { afterEach, describe, expect, it } from "vitest";
import {
  classifyAutonomy,
  classifyDestructive,
  collectCloudCredentials,
  comparePlanStability,
  computeBlastRadius,
  computeConfidence,
  type Concern,
  computeCostDelta,
  computeRegressions,
  computeRemediationVerdict,
  groupConcerns,
  isTerraformConcern,
  moduleAddressOf,
  parseCheckovOutput,
  parseFmtOutput,
  parseInfracostBreakdown,
  parseReviewerFindings,
  parseTerraformPlanJson,
  parseTflintOutput,
  parseTrivyOutput,
  parseValidateOutput,
  resourceTypeOf,
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
    expect(concerns[1].location.file).toBe("modules/net/vpc.tf");
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
            { AVDID: "AVD-AWS-0001", Severity: "HIGH", Status: "PASS", CauseMetadata: { StartLine: 4 } },
            { AVDID: "AVD-AWS-0002", Severity: "HIGH", Status: "FAIL", CauseMetadata: { StartLine: 9 } },
          ],
        },
      ],
    });
    const concerns = parseTrivyOutput(withPass);
    expect(concerns).toHaveLength(1);
    expect(concerns[0].rule_id).toBe("trivy:AVD-AWS-0002");
  });

  it("treats a zero/absent StartLine as a null line", () => {
    const noLine = JSON.stringify({
      Results: [{ Target: "main.tf", Misconfigurations: [{ AVDID: "AVD-X", Severity: "LOW" }] }],
    });
    expect(parseTrivyOutput(noLine)[0].location.line).toBeNull();
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
    expect(parseCheckovOutput(noSev)[0].severity).toBe("medium");
  });

  it("normalizes a 0 start line to null (matches the reviewer, so the id is stable)", () => {
    const zeroLine = JSON.stringify({
      results: { failed_checks: [{ check_id: "CKV_X", file_path: "a.tf", file_line_range: [0, 0] }] },
    });
    expect(parseCheckovOutput(zeroLine)[0].location.line).toBeNull();
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
        { severity: "error", summary: "Failed to load plugin schemas", detail: "plugin did not respond" },
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
          Misconfigurations: [{ AVDID: "r", Severity: "low", Status: "FAIL", CauseMetadata: { StartLine: line } }],
        },
      ],
    });

  it("are stable and content-derived (same input → same id)", () => {
    const a = parseTrivyOutput(trivy("f.tf", 2))[0];
    const b = parseTrivyOutput(trivy("f.tf", 2))[0];
    expect(a.id).toBe(b.id);
  });

  it("differ when the location differs", () => {
    const mk = (line: number): Concern => parseTrivyOutput(trivy("f.tf", line))[0];
    expect(mk(2).id).not.toBe(mk(3).id);
  });
});

describe("path normalization (Bug 1 — portable, repo-relative paths)", () => {
  const trivyTarget = (target: string): string =>
    JSON.stringify({
      Results: [
        {
          Target: target,
          Misconfigurations: [{ AVDID: "r", Severity: "high", Status: "FAIL", CauseMetadata: { StartLine: 5 } }],
        },
      ],
    });
  const trivyFile = (target: string, cwd: string): string =>
    parseTrivyOutput(trivyTarget(target), cwd)[0].location.file;

  it("rewrites an absolute scanner path to repo-relative posix", () => {
    expect(trivyFile("/repo/sub/main.tf", "/repo/sub")).toBe("main.tf");
    expect(trivyFile("D:\\repo\\sub\\net\\vpc.tf", "D:\\repo\\sub")).toBe("net/vpc.tf");
  });

  it("strips checkov's leading-slash path", () => {
    const file = parseCheckovOutput(
      JSON.stringify({
        results: { failed_checks: [{ check_id: "CKV_X", file_path: "/main.tf", file_line_range: [5] }] },
      }),
      "/repo"
    )[0].location.file;
    expect(file).toBe("main.tf");
  });

  it("yields the SAME concern id regardless of the machine's absolute prefix", () => {
    // the core Bug 1 regression: a Linux CI runner and a Windows dev box reported
    // the same logical file under different absolute paths and got different ids.
    const ci = parseTrivyOutput(trivyTarget("/home/runner/work/repo/main.tf"), "/home/runner/work/repo")[0];
    const dev = parseTrivyOutput(trivyTarget("D:\\Users\\dev\\repo\\main.tf"), "D:\\Users\\dev\\repo")[0];
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
    expect(groups[0].rule_ids).toEqual(["tflint:a", "trivy:b"]);
    expect(groups[0].concern_ids).toHaveLength(2);
  });

  it("gives a stable group id for the same file (idempotent branch key)", () => {
    const a = groupConcerns([concern("main.tf", "low", "x")])[0];
    const b = groupConcerns([concern("main.tf", "high", "y")])[0];
    expect(a.id).toBe(b.id);
  });
});

describe("computeRemediationVerdict (C2 — tamper-proof ✗→✓)", () => {
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
      })
    );
    expect(reviewer.id).toBe(own.id);
  });

  it("maps the same id whether the reviewer rule_id is namespaced or bare", () => {
    const [namespaced] = parseReviewerFindings(report([finding({ rule_id: "checkov:CKV_AWS_18" })]));
    const [bare] = parseReviewerFindings(report([finding({ rule_id: "CKV_AWS_18" })]));
    expect(namespaced.id).toBe(bare.id);
  });

  it("collapses reviewer-exclusive sources (tfsec/infracost/llm) to `reviewer`", () => {
    expect(parseReviewerFindings(report([finding({ source: "tfsec", rule_id: "tfsec:AWS017" })]))[0].source).toBe(
      "reviewer"
    );
    expect(parseReviewerFindings(report([finding({ source: "llm" })]))[0].source).toBe("reviewer");
  });

  it("keeps known scanners (trivy/tflint) as themselves", () => {
    expect(parseReviewerFindings(report([finding({ source: "trivy", rule_id: "trivy:AVD-AWS-0088" })]))[0].source).toBe(
      "trivy"
    );
    expect(parseReviewerFindings(report([finding({ source: "tflint", rule_id: "tflint:foo" })]))[0].source).toBe(
      "tflint"
    );
  });

  it("drops human_only findings (out of scope — not auto-remediable)", () => {
    const concerns = parseReviewerFindings(
      report([finding(), finding({ state: "human_only", rule_id: "checkov:CKV_AWS_99" })])
    );
    expect(concerns).toHaveLength(1);
    expect(concerns[0].rule_id).toBe("checkov:CKV_AWS_18");
  });

  it("maps the cost category and defaults unknown categories to correctness", () => {
    expect(parseReviewerFindings(report([finding({ category: "cost", source: "infracost" })]))[0].category).toBe("cost");
    expect(parseReviewerFindings(report([finding({ category: "weird" })]))[0].category).toBe("correctness");
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
      ])
    );
    expect(concerns).toHaveLength(1);
    expect(concerns[0].location.file).toBe("main.tf");
  });

  it("normalizes absolute scanner paths to repo-relative POSIX", () => {
    const [c] = parseReviewerFindings(report([finding({ location: { file: "/repo/main.tf", line: 1 } })]), "/repo");
    expect(c.location.file).toBe("main.tf");
  });

  it("returns nothing for an empty or findings-less report", () => {
    expect(parseReviewerFindings("")).toEqual([]);
    expect(parseReviewerFindings(JSON.stringify({ schema_version: "1.0" }))).toEqual([]);
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
      "google_storage_bucket"
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
      { type: "change_summary", changes: { add: 2, change: 1, remove: 0, operation: "plan" } }
    );
    const s = parseTerraformPlanJson(out);
    expect(s).toMatchObject({ add: 2, change: 1, destroy: 0, hasDestroyOrReplace: false });
    expect(s.destructive).toEqual([]);
  });

  it("collects deleted and replaced resources as destructive", () => {
    const out = lines(
      { type: "planned_change", change: { action: "create", resource: { addr: "aws_s3_bucket.a" } } },
      { type: "planned_change", change: { action: "delete", resource: { addr: "aws_db_instance.db" } } },
      { type: "planned_change", change: { action: "replace", resource: { addr: "aws_instance.web" } } },
      { type: "change_summary", changes: { add: 1, change: 0, remove: 2 } }
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
      { type: "planned_change", change: { action: "create", resource: { addr: "aws_s3_bucket.a" } } },
      { type: "planned_change", change: { action: "update", resource: { addr: "aws_instance.web" } } },
      { type: "planned_change", change: { action: "no-op", resource: { addr: "aws_vpc.main" } } },
      { type: "planned_change", change: { action: "read", resource: { addr: "data.aws_ami.ubuntu" } } }
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
      { type: "planned_change", change: { action: "import", resource: { addr: "aws_s3_bucket.b" } } },
      { type: "planned_change", change: { action: "forget", resource: { addr: "aws_s3_bucket.c" } } },
      { type: "planned_change", change: { action: "update", resource: { addr: "aws_instance.web" } } }
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
  const c = (severity: Concern["severity"], category: Concern["category"]) => ({ severity, category });

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

describe("computeConfidence (§5.19)", () => {
  it("is high for a fully-proven fix (verified, no regressions, idempotent, low blast, no cost rise)", () => {
    expect(
      computeConfidence({
        verified: true,
        regressionCount: 0,
        idempotent: true,
        blastTier: "low",
        costDirection: "no-change",
      }).level
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
      computeConfidence({ verified: true, regressionCount: 0, idempotent: false, blastTier: "low", costDirection: "no-change" }).level
    ).toBe("medium");
  });

  it("caps at medium for a high blast radius or a cost increase", () => {
    expect(
      computeConfidence({ verified: true, regressionCount: 0, idempotent: true, blastTier: "high", costDirection: "no-change" }).level
    ).toBe("medium");
    expect(
      computeConfidence({ verified: true, regressionCount: 0, idempotent: true, blastTier: "low", costDirection: "increase" }).level
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
    expect(moduleAddressOf("module.a.module.b.google_storage_bucket.x[0]")).toBe("module.a.module.b");
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
    ({ add: 0, change: 0, destroy: 0, changed: [], destructive: [], hasDestroyOrReplace: false, ...over }) as ReturnType<
      typeof parseTerraformPlanJson
    >;

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
      computeCostDelta({ totalMonthlyCost: 100, currency: "USD" }, { totalMonthlyCost: 112.405, currency: "USD" })
    ).toEqual({
      currency: "USD",
      baselineMonthly: 100,
      currentMonthly: 112.405,
      deltaMonthly: 12.41,
      direction: "increase",
    });
  });

  it("reports a decrease", () => {
    const d = computeCostDelta({ totalMonthlyCost: 50, currency: "USD" }, { totalMonthlyCost: 40, currency: "USD" });
    expect(d.deltaMonthly).toBe(-10);
    expect(d.direction).toBe("decrease");
  });

  it("reports no-change when costs are equal", () => {
    const d = computeCostDelta({ totalMonthlyCost: 7, currency: "USD" }, { totalMonthlyCost: 7, currency: "USD" });
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
      computeCostDelta({ totalMonthlyCost: 5, currency: "GBP" }, { totalMonthlyCost: null, currency: "" })
    ).toMatchObject({ currency: "GBP", deltaMonthly: null, direction: "unknown" });
  });
});
