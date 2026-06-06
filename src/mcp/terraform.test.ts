import { describe, expect, it } from "vitest";
import {
  type Concern,
  computeCostDelta,
  computeRemediationVerdict,
  groupConcerns,
  parseCheckovOutput,
  parseFmtOutput,
  parseInfracostBreakdown,
  parseTflintOutput,
  parseTrivyOutput,
  parseValidateOutput,
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
