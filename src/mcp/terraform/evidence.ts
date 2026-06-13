import { writeFileSync } from "node:fs";
import { type } from "arktype";
import { type AssessmentScorecard, runAssessmentPipeline } from "#app/mcp/assess";
import type { CrosswalkReport } from "#app/mcp/crosswalk";
import type { LocalToolContext } from "#app/mcp/localContext";
import { resolveWithinCwd } from "#app/mcp/pathSafety";
import { execute, tool, toolOk } from "#app/mcp/shared";
import type { Severity } from "#app/mcp/terraform/types";
import {
  VERIFICATION_STATUS_LABEL,
  type VerificationStatus,
  type VerificationSummary,
} from "#app/mcp/terraform/verification";
import { log } from "#app/utils/cli";
import packageJson from "#package.json" with { type: "json" };

/**
 * Backend-free compliance evidence bundle (the WS4a wedge — an auditor-facing
 * artifact the OSS action can emit with **zero cloud and no backend**, committed
 * to a `compliance/` path). It packages the read-only assessment — posture,
 * per-control statements with their five-status verdict ([[verification]]), the
 * crosswalk index, and the scanner coverage — into one deterministic JSON file.
 *
 * SCHEMA / HONESTY: this is Terramend's OWN structured schema, NOT OSCAL. A
 * strict OSCAL (or compliance-trestle / C2P) emitter is a deliberate follow-up,
 * gated on a buyer who actually needs OSCAL — emitting OSCAL nobody consumes is
 * cost without value. The bundle is INDICATIVE alignment guidance, never an audit
 * verdict, and it never claims `pass` for an unfired control (absence of a
 * finding is not proof). Pure builder + a thin file-writing tool.
 */

export const EVIDENCE_SCHEMA = "terramend-evidence/v0.1" as const;
export const DEFAULT_EVIDENCE_PATH = "compliance/terramend-evidence.json";

export interface EvidenceControlStatement {
  concern_id: string;
  rule_id: string;
  /** the five-status verdict for this statement (fail / not-code-verifiable). */
  status: VerificationStatus;
  severity?: string | undefined;
  file?: string | undefined;
  line?: number | null | undefined;
  controls: { framework: string; control: string; title: string }[];
}

export interface EvidenceBundle {
  /** Terramend's own schema id — explicitly NOT OSCAL (see module note). */
  schema: typeof EVIDENCE_SCHEMA;
  /** caller-supplied ISO timestamp (kept out of the builder so it stays pure). */
  generated_at: string;
  tool: { name: "terramend"; version: string };
  subject: {
    scanned_dir: string;
    repo?: string | undefined;
    ref?: string | undefined;
    commit?: string | undefined;
  };
  posture: AssessmentScorecard["posture"];
  summary: {
    total: number;
    by_severity: AssessmentScorecard["by_severity"];
    verification: VerificationSummary["counts"];
  };
  /** one statement per mapped concern, each carrying its status + controls. */
  control_statements: EvidenceControlStatement[];
  /** which scanners code-verified vs which were inconclusive (coverage gaps). */
  coverage: VerificationSummary["coverage"];
  crosswalk: {
    version: string;
    reviewed: string;
    by_framework: CrosswalkReport["by_framework"];
  };
  /** the five-status legend, so the bundle is self-describing for an assessor. */
  legend: Record<VerificationStatus, string>;
  disclaimer: string;
}

const DISCLAIMER =
  "Indicative alignment guidance from a deterministic starter rule-pack — NOT an " +
  "audit verdict. Statuses are code-verified only; an inconclusive check is a " +
  "coverage gap (not a pass) and absence of a finding is not proof of compliance.";

export interface EvidenceSubject {
  scanned_dir: string;
  repo?: string | undefined;
  ref?: string | undefined;
  commit?: string | undefined;
}

/**
 * Build the evidence bundle from an assessment's scorecard + crosswalk. Pure —
 * `generatedAt` and the subject identifiers are passed in so the same inputs
 * always produce the same bytes (and tests don't need a clock). Control
 * statements come from the crosswalk entries (which already carry the
 * verification status), enriched with the concern's severity/location.
 */
export function buildEvidenceBundle(args: {
  scorecard: AssessmentScorecard;
  crosswalk: CrosswalkReport;
  subject: EvidenceSubject;
  generatedAt: string;
  version?: string;
}): EvidenceBundle {
  const { scorecard, crosswalk, subject, generatedAt } = args;
  const control_statements: EvidenceControlStatement[] = crosswalk.entries.map((e) => ({
    concern_id: e.concern_id,
    rule_id: e.rule_id,
    status: e.status,
    controls: e.controls,
  }));
  return {
    schema: EVIDENCE_SCHEMA,
    generated_at: generatedAt,
    tool: { name: "terramend", version: args.version ?? packageJson.version },
    subject,
    posture: scorecard.posture,
    summary: {
      total: scorecard.total,
      by_severity: scorecard.by_severity,
      verification: scorecard.verification.counts,
    },
    control_statements,
    coverage: scorecard.verification.coverage,
    crosswalk: {
      version: crosswalk.version,
      reviewed: crosswalk.reviewed,
      by_framework: crosswalk.by_framework,
    },
    legend: VERIFICATION_STATUS_LABEL,
    disclaimer: DISCLAIMER,
  };
}

export const TerraformEmitEvidenceParams = type({
  "output_path?": type.string.describe(
    "where to write the evidence bundle (default: ./compliance/terramend-evidence.json in the workspace). Commit it so the compliance/ path is the auditable evidence trail.",
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to include (default: the run's configured threshold, else low).",
  ),
});

export function TerraformEmitEvidenceTool(ctx: LocalToolContext) {
  return tool({
    name: "terraform_emit_evidence",
    description:
      "Emit a backend-free compliance EVIDENCE BUNDLE (auditor-facing JSON) for the workspace — the wedge that " +
      "produces assessor-ready evidence with no cloud and no backend. Runs the read-only assessment and writes " +
      "a deterministic bundle (default `compliance/terramend-evidence.json`): overall `posture`, per-control " +
      "statements each with a five-status verdict (fail / not-code-verifiable), the scanner `coverage` " +
      "(verified vs inconclusive), and the indicative crosswalk index. Commit the file so `compliance/` is the " +
      "auditable trail. It NEVER modifies Terraform or opens a PR. The schema is Terramend's own (not OSCAL); " +
      "the bundle is indicative alignment guidance, never an audit verdict, and never claims a pass it can't " +
      "code-verify. Pairs with `terraform_assess` (the human-readable report) and `terraform_emit_sarif`.",
    parameters: TerraformEmitEvidenceParams,
    execute: execute(async ({ output_path, severity_threshold }) => {
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const { cwd, scorecard, crosswalk } = runAssessmentPipeline(ctx, threshold);

      // SECURITY: confine the agent-supplied path to the workspace (same guard as
      // terraform_emit_sarif) so it can't clobber arbitrary files on the runner.
      const target = resolveWithinCwd(cwd, output_path ?? DEFAULT_EVIDENCE_PATH);
      const bundle = buildEvidenceBundle({
        scorecard,
        crosswalk,
        subject: {
          scanned_dir: cwd,
          repo: process.env.GITHUB_REPOSITORY,
          ref: process.env.GITHUB_REF_NAME,
          commit: process.env.GITHUB_SHA,
        },
        generatedAt: new Date().toISOString(),
      });
      writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`);
      log.info(
        `» terraform_emit_evidence: ${scorecard.posture} — ${bundle.control_statements.length} control statement(s) → ${target}`,
      );
      return toolOk({
        output_path: target,
        posture: bundle.posture,
        statements: bundle.control_statements.length,
        verification: bundle.summary.verification,
      });
    }),
  });
}
