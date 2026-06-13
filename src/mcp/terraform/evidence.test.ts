import { describe, expect, it } from "vitest";
import { buildAssessment } from "#app/mcp/assess";
import { buildCrosswalkReport } from "#app/mcp/crosswalk";
import { buildEvidenceBundle, EVIDENCE_SCHEMA } from "#app/mcp/terraform/evidence";
import type { Concern } from "#app/mcp/terraform/types";
import { buildVerificationSummary } from "#app/mcp/terraform/verification";

let n = 0;
function concern(partial: Partial<Concern> = {}): Concern {
  n += 1;
  return {
    id: partial.id ?? `id${n}`,
    source: partial.source ?? "trivy",
    rule_id: partial.rule_id ?? "trivy:AVD-AWS-0088",
    severity: partial.severity ?? "high",
    category: partial.category ?? "security",
    evidence: partial.evidence ?? "S3 bucket is unencrypted at rest",
    location: partial.location ?? { file: "main.tf", line: 1 },
    remediation_hint: null,
  };
}

function bundleFor(concerns: Concern[]) {
  const crosswalk = buildCrosswalkReport(
    concerns.map((c) => ({ id: c.id, rule_id: c.rule_id, evidence: c.evidence })),
  );
  const scorecard = buildAssessment(concerns, crosswalk, buildVerificationSummary(concerns, []));
  return buildEvidenceBundle({
    scorecard,
    crosswalk,
    subject: { scanned_dir: "/repo", repo: "acme/infra", ref: "main", commit: "abc123" },
    generatedAt: "2026-06-13T00:00:00.000Z",
    version: "0.2.0",
  });
}

describe("buildEvidenceBundle", () => {
  it("packages posture, subject, and the caller's timestamp under our own schema (not OSCAL)", () => {
    const b = bundleFor([concern()]);
    expect(b.schema).toBe(EVIDENCE_SCHEMA);
    expect(b.schema).not.toMatch(/oscal/i);
    expect(b.generated_at).toBe("2026-06-13T00:00:00.000Z");
    expect(b.tool).toEqual({ name: "terramend", version: "0.2.0" });
    expect(b.subject).toMatchObject({ repo: "acme/infra", ref: "main", commit: "abc123" });
    expect(b.posture).toBe("action-required");
  });

  it("emits one control statement per mapped concern, each carrying its status + controls", () => {
    const b = bundleFor([
      concern({ id: "enc", rule_id: "trivy:AVD-AWS-0088", evidence: "unencrypted at rest" }),
      concern({ id: "iam", rule_id: "checkov:CKV_AWS_1", evidence: "IAM wildcard * policy" }),
    ]);
    const byId = Object.fromEntries(b.control_statements.map((s) => [s.concern_id, s]));
    expect(byId.enc?.status).toBe("fail");
    expect(byId.iam?.status).toBe("not-code-verifiable");
    expect(byId.enc?.controls.length).toBeGreaterThan(0);
  });

  it("never claims a pass it can't verify — carries the legend + honest disclaimer", () => {
    const b = bundleFor([concern()]);
    expect(Object.keys(b.legend)).toContain("not-code-verifiable");
    expect(b.legend.inconclusive).toMatch(/not a pass/i);
    expect(b.disclaimer).toMatch(/not an audit verdict/i);
    expect(b.disclaimer).toMatch(/absence of a finding is not proof/i);
  });

  it("is deterministic for the same inputs (reproducible evidence)", () => {
    const a = JSON.stringify(bundleFor([concern({ id: "x" })]));
    const b = JSON.stringify(bundleFor([concern({ id: "x" })]));
    expect(a).toBe(b);
  });
});
