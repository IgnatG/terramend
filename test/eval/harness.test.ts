import { describe, expect, it } from "vitest";
import {
  diffFindings,
  type EvalBaseline,
  type EvalCapture,
  type EvalFinding,
  findingKey,
} from "./harness.ts";

function finding(overrides: Partial<EvalFinding>): EvalFinding {
  return {
    source: "tflint",
    rule_id: "tflint:terraform_unused_declarations",
    file: "main.tf",
    line: 11,
    severity: "low",
    evidence: 'variable "unused" is declared but not used',
    id: "abc123def456",
    ...overrides,
  };
}

function capture(findings: EvalFinding[], ran: string[], overrides?: Partial<EvalCapture>) {
  return { findings, ran, skipped: [], runtimeMs: 0, ...overrides } satisfies EvalCapture;
}

function baseline(findings: EvalFinding[], scanners: string[]): EvalBaseline {
  return { target: "fixtures/terraform-bad", scanners, findings };
}

describe("findingKey", () => {
  it("is line- and id-insensitive so an unrelated line shift still matches", () => {
    const a = finding({ line: 11, id: "aaaaaaaaaaaa" });
    const b = finding({ line: 14, id: "bbbbbbbbbbbb" });
    expect(findingKey(a)).toBe(findingKey(b));
    expect(findingKey(finding({ file: "other.tf" }))).not.toBe(findingKey(a));
  });
});

describe("diffFindings", () => {
  it("partitions into matched / missing / unexpected", () => {
    const kept = finding({});
    const lost = finding({ rule_id: "tflint:terraform_required_providers", line: null });
    const gained = finding({ source: "terraform-fmt", rule_id: "terraform-fmt:unformatted" });
    const report = diffFindings(
      baseline([kept, lost], ["terraform-fmt", "tflint"]),
      capture([kept, gained], ["terraform-fmt", "tflint"]),
    );
    expect(report.matched).toEqual([kept]);
    expect(report.missing).toEqual([lost]);
    expect(report.unexpected).toEqual([gained]);
  });

  it("only judges scanners that ran in BOTH the baseline and the current run", () => {
    const trivyFinding = finding({ source: "trivy", rule_id: "trivy:AVD-AWS-0088" });
    const checkovFinding = finding({ source: "checkov", rule_id: "checkov:CKV_AWS_19" });
    // baseline covered trivy (CI host); this run only has checkov (dev box).
    const report = diffFindings(
      baseline([trivyFinding], ["trivy", "tflint"]),
      capture([checkovFinding], ["checkov", "tflint"], {
        skipped: [{ source: "trivy", reason: "trivy not installed" }],
      }),
    );
    // trivy's baseline finding must NOT count as a detection regression, and
    // checkov's finding must NOT count as unexpected — neither is comparable.
    expect(report.missing).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(report.compared).toEqual(["tflint"]);
    expect(report.uncovered).toEqual(["checkov"]);
    expect(report.skipped).toEqual([{ source: "trivy", reason: "trivy not installed" }]);
  });

  it("uses multiset semantics: a rule firing twice must still fire twice", () => {
    const first = finding({ line: 5, id: "aaaaaaaaaaaa" });
    const second = finding({ line: 20, id: "bbbbbbbbbbbb" });
    const report = diffFindings(
      baseline([first, second], ["tflint"]),
      capture([first], ["tflint"]),
    );
    expect(report.matched).toHaveLength(1);
    expect(report.missing).toHaveLength(1);
    // and the surplus direction: two now, one expected.
    const inverse = diffFindings(
      baseline([first], ["tflint"]),
      capture([first, second], ["tflint"]),
    );
    expect(inverse.matched).toHaveLength(1);
    expect(inverse.unexpected).toHaveLength(1);
  });

  it("reports a clean run as zero drift", () => {
    const f = finding({});
    const report = diffFindings(baseline([f], ["tflint"]), capture([f], ["tflint"]));
    expect(report.missing).toEqual([]);
    expect(report.unexpected).toEqual([]);
    expect(report.matched).toEqual([f]);
  });
});
