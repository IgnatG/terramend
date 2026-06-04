import { describe, expect, it } from "vitest";
import {
  type Concern,
  parseCheckovOutput,
  parseFmtOutput,
  parseTflintOutput,
  parseTfsecOutput,
  parseValidateOutput,
} from "./terraform.ts";

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

describe("parseTfsecOutput", () => {
  const sample = JSON.stringify({
    results: [
      {
        long_id: "aws-s3-enable-bucket-encryption",
        rule_id: "AWS017",
        severity: "CRITICAL",
        description: "Bucket does not have encryption enabled",
        resolution: "Enable server-side encryption",
        location: { filename: "main.tf", start_line: 1 },
      },
    ],
  });

  it("maps a tfsec result to a security concern with lowercased severity", () => {
    const [concern] = parseTfsecOutput(sample);
    expect(concern).toMatchObject({
      source: "tfsec",
      rule_id: "tfsec:aws-s3-enable-bucket-encryption",
      severity: "critical",
      category: "security",
      evidence: "Bucket does not have encryption enabled",
      remediation_hint: "Enable server-side encryption",
      location: { file: "main.tf", line: 1 },
    });
  });

  it("tolerates a null/empty results array", () => {
    expect(parseTfsecOutput(JSON.stringify({ results: null }))).toEqual([]);
    expect(parseTfsecOutput("{}")).toEqual([]);
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
});

describe("concern ids", () => {
  it("are stable and content-derived (same input → same id)", () => {
    const a = parseTfsecOutput(
      JSON.stringify({
        results: [{ long_id: "r", severity: "low", location: { filename: "f.tf", start_line: 2 } }],
      })
    )[0];
    const b = parseTfsecOutput(
      JSON.stringify({
        results: [{ long_id: "r", severity: "low", location: { filename: "f.tf", start_line: 2 } }],
      })
    )[0];
    expect(a.id).toBe(b.id);
  });

  it("differ when the location differs", () => {
    const mk = (line: number): Concern =>
      parseTfsecOutput(
        JSON.stringify({
          results: [
            { long_id: "r", severity: "low", location: { filename: "f.tf", start_line: line } },
          ],
        })
      )[0];
    expect(mk(2).id).not.toBe(mk(3).id);
  });
});
