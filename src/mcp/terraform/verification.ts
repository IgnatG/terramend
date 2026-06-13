import { classifyRefusal } from "#app/mcp/terraform/decisions";
import type { Concern, ScannerOutcome } from "#app/mcp/terraform/types";

/**
 * Five-status verification taxonomy (the auditor-credibility win the evidence
 * pack + crosswalk both lean on). The point is HONESTY: never let "no finding"
 * read as "compliant", and never claim the engine proved something it cannot see
 * from code. Every assessment statement carries exactly one of these:
 *
 *   - `pass`                — a check ran and code-verified compliance.
 *   - `fail`                — a check ran and code-verified a violation.
 *   - `not-applicable`      — the control does not apply to the resources present.
 *   - `inconclusive`        — a relevant check did NOT run (gated / not installed /
 *                             unparseable). A coverage gap, never silently a pass.
 *   - `not-code-verifiable` — the control needs human / process evidence
 *                             (governance, training, a key-policy decision); IaC
 *                             scanning structurally cannot prove it either way.
 *
 * What this engine asserts today: `fail` and `not-code-verifiable` per concern,
 * and `inconclusive` per scanner that didn't run. It deliberately does NOT
 * fabricate `pass` / `not-applicable` for controls nothing fired on — absence of
 * a finding is not proof, and over-claiming is exactly what costs credibility
 * with an assessor. The two reserved statuses are part of the shared vocabulary
 * for the evidence consumer (and a future full-framework crosswalk). Pure.
 */

export const VERIFICATION_STATUSES = [
  "pass",
  "fail",
  "not-applicable",
  "inconclusive",
  "not-code-verifiable",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** one-line legend per status — for the report / evidence bundle. */
export const VERIFICATION_STATUS_LABEL: Record<VerificationStatus, string> = {
  pass: "a check ran and code-verified compliance",
  fail: "a check ran and code-verified a violation",
  "not-applicable": "the control does not apply to the resources present",
  inconclusive: "a relevant check did not run — a coverage gap, not a pass",
  "not-code-verifiable": "needs human / process evidence — IaC cannot prove it",
};

/** the statuses the engine asserts per concern (a concern is always one or the
 * other — it fired, the only question is whether code can prove the fix). */
export type ConcernVerificationStatus = Extract<VerificationStatus, "fail" | "not-code-verifiable">;

/**
 * Classify one concern: a code-verified violation (`fail`) — UNLESS its
 * remediation is a human decision the engine can flag but not prove from code
 * (IAM least-privilege, a KMS key policy, a real CIDR — the §29 refusal set), in
 * which case it is `not-code-verifiable`. Pure.
 */
export function concernVerificationStatus(concern: Pick<Concern, "rule_id" | "evidence">): {
  status: ConcernVerificationStatus;
  reason?: string;
} {
  const refusal = classifyRefusal(concern);
  if (refusal.refuse) {
    return refusal.reason
      ? { status: "not-code-verifiable", reason: refusal.reason }
      : { status: "not-code-verifiable" };
  }
  return { status: "fail" };
}

export interface VerifiedConcern {
  id: string;
  status: ConcernVerificationStatus;
  reason?: string;
}

export interface VerificationSummary {
  /** per-concern verification status. */
  concerns: VerifiedConcern[];
  counts: {
    fail: number;
    not_code_verifiable: number;
    /** scanners that did not run (each is a coverage gap). */
    inconclusive: number;
  };
  coverage: {
    /** scanners that ran — their checks are code-verified for what they cover. */
    verified: string[];
    /** scanners that did NOT run — their checks are INCONCLUSIVE, never a pass. */
    inconclusive: { source: string; reason: string }[];
  };
  /** the honesty caveat an assessor should read alongside the statuses. */
  note: string;
}

const HONESTY_NOTE =
  "Statuses are code-verified only. A scanner that did not run leaves its checks " +
  "INCONCLUSIVE (a coverage gap, not a pass); controls needing human/process " +
  "evidence are NOT-CODE-VERIFIABLE. Absence of a finding is not proof of compliance.";

/**
 * Roll a scan up into a verification summary: every concern classified
 * (fail / not-code-verifiable) and every scanner partitioned into verified (ran)
 * vs inconclusive (skipped — gated, not installed, or unparseable). Pure;
 * `outcomes` is the raw `runScanners` result, `concerns` the deduped,
 * Terraform-only set the assessment reports on.
 */
export function buildVerificationSummary(
  concerns: Pick<Concern, "id" | "rule_id" | "evidence">[],
  outcomes: ScannerOutcome[],
): VerificationSummary {
  const verified: VerifiedConcern[] = concerns.map((c) => {
    const v = concernVerificationStatus(c);
    return v.reason
      ? { id: c.id, status: v.status, reason: v.reason }
      : { id: c.id, status: v.status };
  });

  const verifiedTools: string[] = [];
  const inconclusiveTools: { source: string; reason: string }[] = [];
  for (const o of outcomes) {
    if (o.ran) verifiedTools.push(o.source);
    else inconclusiveTools.push({ source: o.source, reason: o.skipped_reason ?? "did not run" });
  }

  return {
    concerns: verified,
    counts: {
      fail: verified.filter((c) => c.status === "fail").length,
      not_code_verifiable: verified.filter((c) => c.status === "not-code-verifiable").length,
      inconclusive: inconclusiveTools.length,
    },
    coverage: { verified: verifiedTools, inconclusive: inconclusiveTools },
    note: HONESTY_NOTE,
  };
}
