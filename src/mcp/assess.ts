import { type } from "arktype";
import { buildCrosswalkReport, type CrosswalkReport } from "#app/mcp/crosswalk";
import type { LocalToolContext } from "#app/mcp/localContext";
import { execute, tool, toolOk } from "#app/mcp/shared";
import { runScanners } from "#app/mcp/terraform/scanners";
import {
  type Concern,
  dedupe,
  isTerraformConcern,
  type ScannerOutcome,
  SEVERITY_RANK,
  type Severity,
  sortConcerns,
} from "#app/mcp/terraform/types";
import {
  buildVerificationSummary,
  type VerificationSummary,
} from "#app/mcp/terraform/verification";
import { log } from "#app/utils/cli";
import { resolveModuleFetchEnv } from "#app/utils/moduleFetch";
import { resolveToolSelection } from "#app/utils/toolSelection";

/**
 * Assess pillar — the read-only product (roadmap pillar 3). Terramend's scanner
 * engine has two modes off ONE codebase: Remediate = engine + fix loop + verify;
 * **Assess = engine, read-only**. This surfaces that read-only half as a
 * first-class deliverable: run the deterministic scanners, normalise into the
 * findings schema, map to the compliance crosswalk (§23), and produce a
 * **scorecard** + an auditor-facing markdown report — WITHOUT touching the
 * Terraform or opening a PR. No cloud credentials, no writes.
 *
 * The scorecard is deterministic (computed from tool results, never the model's
 * word) so a CI gate can branch on `posture` and an assessor gets a reproducible,
 * framework-mapped report.
 */

export type AssessPosture = "clean" | "advisory" | "action-required";

export interface AssessTopRisk {
  rule_id: string;
  severity: Severity;
  file: string;
  line: number | null;
  evidence: string;
}

export interface AssessmentScorecard {
  /** clean (0 concerns) · advisory (only medium/low/info) · action-required (≥1 critical/high). */
  posture: AssessPosture;
  total: number;
  by_severity: Record<Severity, number>;
  /** highest-severity concerns first, capped — the "what to look at first" list. */
  top_risks: AssessTopRisk[];
  compliance: {
    /** frameworks this scan touched (from the crosswalk's by_framework index). */
    frameworks: string[];
    /** distinct controls touched across all frameworks. */
    controls_touched: number;
    /** concerns that mapped to ≥1 control vs none (honest coverage signal). */
    mapped: number;
    unmapped: number;
    version: string;
    reviewed: string;
  };
  /** five-status verification taxonomy: per-concern fail / not-code-verifiable +
   * the scanner coverage (verified vs inconclusive). Keeps a "clean" posture
   * honest — e.g. "clean, but tflint inconclusive (not run)". */
  verification: VerificationSummary;
}

/** posture from the severity distribution: any critical/high ⇒ action-required;
 * any lower-severity concern ⇒ advisory; nothing ⇒ clean. */
export function assessPosture(bySeverity: Record<Severity, number>): AssessPosture {
  if (bySeverity.critical > 0 || bySeverity.high > 0) return "action-required";
  if (bySeverity.medium > 0 || bySeverity.low > 0 || bySeverity.info > 0) return "advisory";
  return "clean";
}

const TOP_RISK_CAP = 10;

/**
 * Build the deterministic assessment scorecard from a scan's concerns + their
 * crosswalk report. Pure. `concerns` should be the severity-sorted, deduped,
 * Terraform-only set; `crosswalk` is `buildCrosswalkReport(concerns)`.
 */
export function buildAssessment(
  concerns: Concern[],
  crosswalk: CrosswalkReport,
  verification: VerificationSummary,
): AssessmentScorecard {
  const by_severity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const c of concerns) by_severity[c.severity]++;

  const top_risks = [...concerns]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, TOP_RISK_CAP)
    .map((c) => ({
      rule_id: c.rule_id,
      severity: c.severity,
      file: c.location.file,
      line: c.location.line,
      evidence: c.evidence,
    }));

  const controls_touched = Object.values(crosswalk.by_framework).reduce(
    (n, controls) => n + controls.length,
    0,
  );

  return {
    posture: assessPosture(by_severity),
    total: concerns.length,
    by_severity,
    top_risks,
    compliance: {
      frameworks: Object.keys(crosswalk.by_framework),
      controls_touched,
      mapped: crosswalk.entries.length,
      unmapped: crosswalk.unmapped_concern_ids.length,
      version: crosswalk.version,
      reviewed: crosswalk.reviewed,
    },
    verification,
  };
}

const POSTURE_BANNER: Record<AssessPosture, string> = {
  clean: "> [!NOTE]\n> ✅ **Clean** — no best-practice concerns found at the configured threshold.",
  advisory:
    "> [!WARNING]\n> ⚠️ **Advisory** — concerns found, but none critical/high. Plan to address them.",
  "action-required":
    "> [!CAUTION]\n> 🚨 **Action required** — critical/high-severity concerns found. Review before relying on this Terraform.",
};

/**
 * Render the scorecard as a deterministic, auditor-facing markdown report (the
 * Assess deliverable). Built entirely from the scorecard so it's reproducible and
 * model-independent. Pure.
 */
export function renderAssessmentMarkdown(s: AssessmentScorecard): string {
  const lines: string[] = [];
  lines.push(POSTURE_BANNER[s.posture]);
  lines.push("");
  lines.push("## Terraform best-practice assessment");
  lines.push("");
  const sevOrder: Severity[] = ["critical", "high", "medium", "low", "info"];
  const sevCells = sevOrder
    .filter((sev) => s.by_severity[sev] > 0)
    .map((sev) => `\`${sev}: ${s.by_severity[sev]}\``);
  lines.push(
    `**${s.total} concern${s.total === 1 ? "" : "s"}** — ${
      sevCells.length ? sevCells.join(" · ") : "none"
    }`,
  );
  lines.push("");

  if (s.top_risks.length > 0) {
    lines.push("### Top risks");
    lines.push("");
    for (const r of s.top_risks) {
      const loc = r.line !== null ? `\`${r.file}:${r.line}\`` : `\`${r.file}\``;
      lines.push(`- ${severityEmoji(r.severity)} \`${r.rule_id}\` — ${loc} — ${r.evidence}`);
    }
    lines.push("");
  }

  lines.push("### Compliance crosswalk");
  lines.push("");
  if (s.compliance.frameworks.length > 0) {
    lines.push(
      `Indicative alignment (crosswalk v${s.compliance.version}, reviewed ${s.compliance.reviewed}) — ` +
        `**not an audit verdict**. Touches ${s.compliance.controls_touched} control(s) across ` +
        `${s.compliance.frameworks.length} framework(s): ${s.compliance.frameworks.join(", ")}.`,
    );
    if (s.compliance.unmapped > 0) {
      lines.push("");
      lines.push(
        `> ${s.compliance.unmapped} concern(s) did not map to a control in the starter rule-pack (honest coverage gap).`,
      );
    }
  } else {
    lines.push("No concerns mapped to a compliance control in the starter rule-pack.");
  }
  lines.push("");

  // five-status verification taxonomy — keep the posture honest about coverage.
  const v = s.verification;
  lines.push("### Verification coverage");
  lines.push("");
  lines.push(
    `Code-verified by: ${v.coverage.verified.length ? v.coverage.verified.join(", ") : "none"}.`,
  );
  if (v.coverage.inconclusive.length > 0) {
    lines.push("");
    lines.push(
      `> [!WARNING]\n> **Inconclusive** (a coverage gap, not a pass) — these checks did not run:`,
    );
    for (const t of v.coverage.inconclusive) lines.push(`> - \`${t.source}\` — ${t.reason}`);
  }
  if (v.counts.not_code_verifiable > 0) {
    lines.push("");
    lines.push(
      `> ${v.counts.not_code_verifiable} concern(s) are **not code-verifiable** — they need a human/process decision (e.g. IAM least-privilege, a KMS key policy) the engine can flag but not prove.`,
    );
  }
  lines.push("");
  lines.push(`_${v.note}_`);

  lines.push("");
  lines.push(
    "_Read-only assessment — no Terraform was modified and no PR was opened. " +
      "Run Terramend in `remediate` mode to fix and prove these concerns._",
  );
  return lines.join("\n");
}

function severityEmoji(sev: Severity): string {
  switch (sev) {
    case "critical":
      return "🚨";
    case "high":
      return "⚠️";
    case "medium":
      return "🔶";
    case "low":
      return "ℹ️";
    default:
      return "·";
  }
}

export const TerraformAssessParams = type({
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to include (default: the run's configured threshold, else low).",
  ),
});

/** the full read-only assessment pipeline: scan (honouring the §1.5 licence gate
 * + module-fetch credential) → crosswalk → verification taxonomy → scorecard.
 * Shared by `terraform_assess` and the evidence-bundle emitter so both report the
 * identical posture from the identical toolchain. Pure-ish (only the scanners do
 * I/O); no writes. */
export function runAssessmentPipeline(
  ctx: LocalToolContext,
  threshold: Severity,
): {
  cwd: string;
  outcomes: ScannerOutcome[];
  concerns: Concern[];
  crosswalk: CrosswalkReport;
  verification: VerificationSummary;
  scorecard: AssessmentScorecard;
} {
  const cwd = ctx.payload.cwd ?? process.cwd();
  const minRank = SEVERITY_RANK[threshold];
  // §1.5 — same licence gate + module-fetch credential as terraform_scan, so a
  // gated tool (e.g. tflint) shows up as INCONCLUSIVE coverage, not a silent pass.
  const outcomes = runScanners(cwd, {
    selection: resolveToolSelection(ctx.payload),
    terraformEnv: resolveModuleFetchEnv(ctx.payload),
  });
  const concerns = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
    .filter(isTerraformConcern)
    .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
  const crosswalk = buildCrosswalkReport(
    concerns.map((c) => ({
      id: c.id,
      rule_id: c.rule_id,
      evidence: c.evidence,
      category: c.category,
      severity: c.severity,
      location: c.location,
    })),
  );
  const verification = buildVerificationSummary(concerns, outcomes);
  const scorecard = buildAssessment(concerns, crosswalk, verification);
  return { cwd, outcomes, concerns, crosswalk, verification, scorecard };
}

export function TerraformAssessTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_assess",
    description:
      "Read-only Terraform best-practice ASSESSMENT (the Assess pillar — the scanner engine surfaced as a " +
      "product). Runs the deterministic scanners, then returns a deterministic `scorecard` (overall " +
      "`posture` — clean / advisory / action-required, `by_severity` counts, `top_risks`, an indicative " +
      "compliance-crosswalk summary, and a five-status `verification` coverage block) plus a ready-to-post " +
      "`markdown` report. It NEVER modifies Terraform or opens a PR — use it to report posture (e.g. in a job " +
      "summary or a CI gate on `posture`). Pairs with `terraform_emit_sarif` (Security tab), " +
      "`terraform_emit_evidence` (auditor bundle), and `infracost_diff` / `terraform_version_currency` for the " +
      "cost and currency lenses. For the fix loop, use `terraform_scan` + the Remediate mode instead.",
    parameters: TerraformAssessParams,
    execute: execute(async ({ severity_threshold }) => {
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";

      const { cwd, outcomes, scorecard } = runAssessmentPipeline(ctx, threshold);
      const markdown = renderAssessmentMarkdown(scorecard);

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      log.info(
        `» terraform_assess: ${scorecard.posture} — ${scorecard.total} concern(s) ` +
          `(${scorecard.compliance.controls_touched} control(s) across ${scorecard.compliance.frameworks.length} framework(s)) ` +
          `from [${ran.join(", ")}]`,
      );
      return toolOk({
        scanned_dir: cwd,
        scanners_ran: ran,
        scorecard,
        markdown,
      });
    }),
  });
}
