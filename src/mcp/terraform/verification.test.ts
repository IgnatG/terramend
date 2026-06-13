import { describe, expect, it } from "vitest";
import type { ScannerOutcome } from "#app/mcp/terraform/types";
import {
  buildVerificationSummary,
  concernVerificationStatus,
  VERIFICATION_STATUS_LABEL,
  VERIFICATION_STATUSES,
} from "#app/mcp/terraform/verification";

describe("the five-status taxonomy", () => {
  it("has exactly the five statuses, each with a legend", () => {
    expect([...VERIFICATION_STATUSES]).toEqual([
      "pass",
      "fail",
      "not-applicable",
      "inconclusive",
      "not-code-verifiable",
    ]);
    for (const s of VERIFICATION_STATUSES) {
      expect(VERIFICATION_STATUS_LABEL[s]).toBeTruthy();
    }
  });
});

describe("concernVerificationStatus", () => {
  it("a code-verified violation is `fail`", () => {
    const v = concernVerificationStatus({
      rule_id: "trivy:AVD-AWS-0088",
      evidence: "S3 bucket is unencrypted at rest",
    });
    expect(v.status).toBe("fail");
    expect(v.reason).toBeUndefined();
  });

  it("a human-decision concern is `not-code-verifiable` with a reason", () => {
    const v = concernVerificationStatus({
      rule_id: "checkov:CKV_AWS_1",
      evidence: "IAM policy uses a wildcard * action",
    });
    expect(v.status).toBe("not-code-verifiable");
    expect(v.reason).toMatch(/human decision/i);
  });
});

describe("buildVerificationSummary", () => {
  const concerns = [
    { id: "a", rule_id: "trivy:AVD-AWS-0088", evidence: "unencrypted at rest" },
    { id: "b", rule_id: "checkov:CKV_AWS_1", evidence: "least-privilege wildcard policy" },
  ];
  const outcomes: ScannerOutcome[] = [
    { source: "trivy", ran: true, concerns: [] },
    { source: "checkov", ran: true, concerns: [] },
    {
      source: "tflint",
      ran: false,
      skipped_reason: "licence-gated (TFLint, MPL-2.0)",
      concerns: [],
    },
  ];

  it("classifies each concern and counts fail vs not-code-verifiable", () => {
    const s = buildVerificationSummary(concerns, outcomes);
    expect(s.counts.fail).toBe(1);
    expect(s.counts.not_code_verifiable).toBe(1);
    expect(s.concerns).toEqual([
      { id: "a", status: "fail" },
      { id: "b", status: "not-code-verifiable", reason: expect.stringMatching(/human decision/i) },
    ]);
  });

  it("partitions scanners into verified (ran) vs inconclusive (skipped)", () => {
    const s = buildVerificationSummary(concerns, outcomes);
    expect(s.coverage.verified).toEqual(["trivy", "checkov"]);
    expect(s.coverage.inconclusive).toEqual([
      { source: "tflint", reason: "licence-gated (TFLint, MPL-2.0)" },
    ]);
    expect(s.counts.inconclusive).toBe(1);
  });

  it("carries the honesty note (no silent pass)", () => {
    const s = buildVerificationSummary([], []);
    expect(s.note).toMatch(/not proof of compliance/i);
    expect(s.concerns).toEqual([]);
  });
});
