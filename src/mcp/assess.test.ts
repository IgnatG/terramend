import { describe, expect, it } from "vitest";
import { assessPosture, buildAssessment, renderAssessmentMarkdown } from "#app/mcp/assess";
import { buildCrosswalkReport } from "#app/mcp/crosswalk";
import type { Concern, ScannerOutcome, Severity } from "#app/mcp/terraform/types";
import { buildVerificationSummary } from "#app/mcp/terraform/verification";

/** build a scorecard with the verification summary the tool would attach. An
 * optional `outcomes` lets a test exercise the coverage (verified/inconclusive)
 * view; default [] focuses on the per-concern statuses. */
function assess(
  concerns: Concern[],
  crosswalk = buildCrosswalkReport(
    concerns.map((c) => ({ id: c.id, rule_id: c.rule_id, evidence: c.evidence })),
  ),
  outcomes: ScannerOutcome[] = [],
) {
  return buildAssessment(concerns, crosswalk, buildVerificationSummary(concerns, outcomes));
}

let n = 0;
function concern(severity: Severity, partial: Partial<Concern> = {}): Concern {
  n += 1;
  return {
    id: partial.id ?? `id${n}`,
    source: partial.source ?? "trivy",
    rule_id: partial.rule_id ?? "trivy:AVD-AWS-0001",
    severity,
    category: partial.category ?? "security",
    evidence: partial.evidence ?? "something is wrong",
    location: partial.location ?? { file: "main.tf", line: 1 },
    remediation_hint: partial.remediation_hint ?? null,
  };
}

describe("assessPosture", () => {
  const zero = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  it("is action-required on any critical/high", () => {
    expect(assessPosture({ ...zero, high: 1 })).toBe("action-required");
    expect(assessPosture({ ...zero, critical: 1 })).toBe("action-required");
  });
  it("is advisory when only medium/low/info", () => {
    expect(assessPosture({ ...zero, medium: 2 })).toBe("advisory");
    expect(assessPosture({ ...zero, info: 1 })).toBe("advisory");
  });
  it("is clean when there are no concerns", () => {
    expect(assessPosture(zero)).toBe("clean");
  });
});

describe("buildAssessment", () => {
  it("counts by severity, caps + severity-orders top risks, and summarises the crosswalk", () => {
    const concerns = [
      concern("low", {
        rule_id: "tflint:terraform_required_version",
        evidence: "no required_version",
      }),
      concern("critical", {
        rule_id: "trivy:AVD-AWS-0088",
        evidence: "S3 bucket is unencrypted at rest",
      }),
      concern("high", { rule_id: "checkov:CKV_AWS_260", evidence: "0.0.0.0/0 ingress is public" }),
    ];
    const crosswalk = buildCrosswalkReport(
      concerns.map((c) => ({ id: c.id, rule_id: c.rule_id, evidence: c.evidence })),
    );
    const s = assess(concerns, crosswalk);

    expect(s.posture).toBe("action-required");
    expect(s.total).toBe(3);
    expect(s.by_severity.critical).toBe(1);
    expect(s.by_severity.high).toBe(1);
    expect(s.by_severity.low).toBe(1);
    // top risks are severity-ordered (critical → high → low)
    expect(s.top_risks.map((r) => r.severity)).toEqual(["critical", "high", "low"]);
    // encryption + public-exposure concerns map to controls; the required_version
    // one doesn't → unmapped. frameworks touched is non-empty.
    expect(s.compliance.frameworks.length).toBeGreaterThan(0);
    expect(s.compliance.controls_touched).toBeGreaterThan(0);
    expect(s.compliance.mapped).toBe(2);
    expect(s.compliance.unmapped).toBe(1);
  });

  it("is clean with an empty crosswalk when there are no concerns", () => {
    const s = assess([]);
    expect(s.posture).toBe("clean");
    expect(s.total).toBe(0);
    expect(s.top_risks).toEqual([]);
    expect(s.compliance.frameworks).toEqual([]);
  });

  it("attaches the five-status verification summary (fail vs not-code-verifiable + coverage)", () => {
    const concerns = [
      concern("critical", { rule_id: "trivy:AVD-AWS-0088", evidence: "S3 unencrypted at rest" }),
      // an IAM least-privilege concern is a human decision → not-code-verifiable.
      concern("high", { rule_id: "checkov:CKV_AWS_1", evidence: "IAM policy uses a wildcard *" }),
    ];
    const outcomes: ScannerOutcome[] = [
      { source: "trivy", ran: true, concerns: [] },
      { source: "tflint", ran: false, skipped_reason: "licence-gated", concerns: [] },
    ];
    const s = assess(concerns, undefined, outcomes);
    expect(s.verification.counts.fail).toBe(1);
    expect(s.verification.counts.not_code_verifiable).toBe(1);
    expect(s.verification.coverage.verified).toContain("trivy");
    expect(s.verification.coverage.inconclusive).toEqual([
      { source: "tflint", reason: "licence-gated" },
    ]);
  });
});

describe("renderAssessmentMarkdown", () => {
  it("renders the posture banner, counts, top risks and the indicative-crosswalk note", () => {
    const concerns = [
      concern("critical", { rule_id: "trivy:AVD-AWS-0088", evidence: "unencrypted at rest" }),
    ];
    const crosswalk = buildCrosswalkReport(
      concerns.map((c) => ({ id: c.id, rule_id: c.rule_id, evidence: c.evidence })),
    );
    const md = renderAssessmentMarkdown(assess(concerns, crosswalk));
    expect(md).toContain("[!CAUTION]");
    expect(md).toContain("Action required");
    expect(md).toContain("`critical: 1`");
    expect(md).toContain("trivy:AVD-AWS-0088");
    expect(md).toContain("not an audit verdict");
    // honest read-only framing — never claims to have fixed anything.
    expect(md).toContain("no Terraform was modified");
  });

  it("renders a clean banner with no top-risk section when there are no concerns", () => {
    const md = renderAssessmentMarkdown(assess([]));
    expect(md).toContain("[!NOTE]");
    expect(md).toContain("Clean");
    expect(md).not.toContain("### Top risks");
  });
});
