import { type } from "arktype";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool, toolOk } from "#app/mcp/shared";
import {
  type ConcernVerificationStatus,
  concernVerificationStatus,
} from "#app/mcp/terraform/verification";
import { log } from "#app/utils/cli";

/**
 * Compliance crosswalk (§differentiator 23 — "explain like I'm the auditor", the
 * seed of the Part-6 moat). Maps a best-practice concern → the control families
 * it touches across UK public-sector + general frameworks, so a remediation can
 * be narrated to an assessor in their own language ("this closes NCSC Cloud
 * Principle 2 / Cyber Essentials Secure Configuration") rather than as a raw
 * scanner rule id.
 *
 * SCOPE / HONESTY: this is a deterministic STARTER rule-pack keyed on the
 * defect's THEME (encryption, public exposure, least-privilege, logging, …),
 * not a certified control-by-control mapping. The durable product is a
 * versioned, framework-revision-pinned crosswalk (Part 6) — so every mapping
 * carries the pack version + date and is labelled indicative, never an audit
 * verdict. No open crosswalk to UK frameworks exists; this is the wedge.
 */

export const CROSSWALK_VERSION = "0.1.0";
/** the date this rule-pack's framework references were last reviewed (absolute). */
export const CROSSWALK_REVIEWED = "2026-06-07";

export interface ControlRef {
  /** the framework, e.g. "NCSC Cloud Security Principles". */
  framework: string;
  /** the control id within that framework, e.g. "Principle 2". */
  control: string;
  /** the control's short title. */
  title: string;
}

/** a theme of defect, the signals that identify it, and the controls it maps to. */
interface CrosswalkRule {
  theme: string;
  /** lowercased substrings that, if any appears in the rule_id/evidence, match. */
  signals: string[];
  controls: ControlRef[];
}

// The starter rule-pack. Themes are matched against the concern's rule_id +
// evidence (lowercased). Ordered most-specific first; a concern can match
// several themes (their controls are unioned). Kept deliberately small and
// auditable — each control ref is a real, citable control family.
const CROSSWALK: CrosswalkRule[] = [
  {
    theme: "encryption-at-rest",
    // NB avoid the bare token "sse" — it's a substring of "essential"/"asset"
    // and would false-match; use the explicit phrases instead.
    signals: [
      "encrypt",
      "kms",
      "server-side encryption",
      "server_side_encryption",
      "sse_algorithm",
      "at rest",
      "at-rest",
      "unencrypted",
    ],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 1",
        title: "Data in transit protection",
      },
      {
        framework: "Cyber Essentials",
        control: "Secure Configuration",
        title: "Secure configuration",
      },
      { framework: "CIS Controls v8", control: "3.11", title: "Encrypt sensitive data at rest" },
      {
        framework: "NHS DSPT",
        control: "Standard 1",
        title: "Personal confidential data protected",
      },
    ],
  },
  {
    theme: "encryption-in-transit",
    signals: ["tls", "ssl", "https", "in transit", "in-transit", "insecure protocol", "http "],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 1",
        title: "Data in transit protection",
      },
      { framework: "CIS Controls v8", control: "3.10", title: "Encrypt sensitive data in transit" },
    ],
  },
  {
    theme: "public-exposure",
    signals: ["public", "0.0.0.0/0", "publicly", "anonymous", "open to the internet", "ingress"],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 9",
        title: "Secure user management / network separation",
      },
      {
        framework: "Cyber Essentials",
        control: "Firewalls",
        title: "Boundary firewalls and internet gateways",
      },
      {
        framework: "CIS Controls v8",
        control: "4.4",
        title: "Implement and manage a firewall on servers",
      },
      {
        framework: "Secure by Design",
        control: "SbD-7",
        title: "Protect data in transit and at rest",
      },
    ],
  },
  {
    theme: "least-privilege",
    signals: [
      "iam",
      "wildcard",
      "least privilege",
      "least-privilege",
      "policy",
      "admin",
      "privilege",
      "*:*",
      "role",
    ],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 9",
        title: "Secure user management",
      },
      {
        framework: "Cyber Essentials",
        control: "User Access Control",
        title: "User access control",
      },
      {
        framework: "CIS Controls v8",
        control: "6.8",
        title: "Define and maintain role-based access control",
      },
      { framework: "NHS DSPT", control: "Standard 4", title: "Managing access" },
    ],
  },
  {
    theme: "logging-audit",
    // NB avoid the bare token "log" — it's a substring of "catalog"/"blog" and
    // would false-match; use the explicit phrases/longer tokens instead.
    signals: [
      "logging",
      "log group",
      "audit",
      "cloudtrail",
      "flow log",
      "access log",
      "monitoring",
      "cloudwatch",
    ],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 13",
        title: "Audit information and alerting",
      },
      { framework: "CIS Controls v8", control: "8.2", title: "Collect audit logs" },
      { framework: "NHS DSPT", control: "Standard 7", title: "Continuity planning / monitoring" },
      { framework: "SOC 2", control: "CC7.2", title: "Security monitoring" },
    ],
  },
  {
    theme: "backup-resilience",
    signals: ["versioning", "backup", "snapshot", "retention", "deletion protection", "multi-az"],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 2",
        title: "Asset protection and resilience",
      },
      { framework: "NHS DSPT", control: "Standard 7", title: "Continuity planning" },
      { framework: "CIS Controls v8", control: "11.2", title: "Perform automated backups" },
    ],
  },
  {
    theme: "secrets-management",
    signals: ["secret", "credential", "password", "hardcoded", "plaintext", "access key", "token"],
    controls: [
      {
        framework: "NCSC Cloud Security Principles",
        control: "Principle 10",
        title: "Identity and authentication",
      },
      { framework: "CIS Controls v8", control: "16.4", title: "Securely store credentials" },
      {
        framework: "Cyber Essentials",
        control: "Secure Configuration",
        title: "Secure configuration",
      },
    ],
  },
];

/**
 * Map a single concern to the indicative control references it touches. Matches
 * the concern's `rule_id` + `evidence` (and an optional `category`) against the
 * crosswalk themes; unions the controls of every theme that fires. Pure.
 * Returns an empty array when nothing matches (honest — better than a forced
 * mapping). De-duplicates identical control refs.
 */
export function mapConcernToControls(concern: {
  rule_id: string;
  evidence: string;
  category?: string;
}): { themes: string[]; controls: ControlRef[] } {
  const haystack = `${concern.rule_id} ${concern.evidence}`.toLowerCase();
  const themes: string[] = [];
  const controls: ControlRef[] = [];
  const seen = new Set<string>();
  for (const rule of CROSSWALK) {
    if (!rule.signals.some((s) => haystack.includes(s))) continue;
    themes.push(rule.theme);
    for (const c of rule.controls) {
      const key = `${c.framework}|${c.control}`;
      if (seen.has(key)) continue;
      seen.add(key);
      controls.push(c);
    }
  }
  return { themes, controls };
}

export interface ConcernForCrosswalk {
  id: string;
  rule_id: string;
  evidence: string;
  category?: string;
  severity?: string;
  location?: { file: string; line: number | null };
}

export interface CrosswalkEntry {
  concern_id: string;
  rule_id: string;
  themes: string[];
  controls: ControlRef[];
  /** the five-status verdict for this control statement: `fail` (code-verified
   * violation) or `not-code-verifiable` (a human-decision control the engine can
   * flag but not prove). Lets an assessor read the crosswalk honestly. */
  status: ConcernVerificationStatus;
}

export interface CrosswalkReport {
  version: string;
  reviewed: string;
  /** per-concern control mappings (only concerns that mapped to ≥1 control). */
  entries: CrosswalkEntry[];
  /** framework → the distinct controls this scan touched, for an auditor index. */
  by_framework: Record<string, { control: string; title: string }[]>;
  /** concerns that did not map to any control (honest coverage signal). */
  unmapped_concern_ids: string[];
}

/**
 * Build the auditor crosswalk for a set of concerns: per-concern control refs
 * plus a `by_framework` index (which controls this scan touched, deduped) and an
 * honest `unmapped` list. Pure + deterministic. Carries the pack version + date
 * so the report is reproducible and clearly indicative.
 */
export function buildCrosswalkReport(concerns: ConcernForCrosswalk[]): CrosswalkReport {
  const entries: CrosswalkEntry[] = [];
  const unmapped: string[] = [];
  const byFramework = new Map<string, Map<string, string>>();
  for (const c of concerns) {
    const { themes, controls } = mapConcernToControls(c);
    if (controls.length === 0) {
      unmapped.push(c.id);
      continue;
    }
    entries.push({
      concern_id: c.id,
      rule_id: c.rule_id,
      themes,
      controls,
      status: concernVerificationStatus(c).status,
    });
    for (const ctl of controls) {
      const map = byFramework.get(ctl.framework) ?? new Map<string, string>();
      if (!map.has(ctl.control)) map.set(ctl.control, ctl.title);
      byFramework.set(ctl.framework, map);
    }
  }
  const by_framework: Record<string, { control: string; title: string }[]> = {};
  for (const [framework, controls] of [...byFramework.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    by_framework[framework] = [...controls.entries()]
      .map(([control, title]) => ({ control, title }))
      .sort((a, b) => a.control.localeCompare(b.control));
  }
  return {
    version: CROSSWALK_VERSION,
    reviewed: CROSSWALK_REVIEWED,
    entries,
    by_framework,
    unmapped_concern_ids: unmapped,
  };
}

export const ComplianceCrosswalkParams = type({
  concerns: type({
    id: type.string,
    rule_id: type.string,
    evidence: type.string,
    "category?": type.string,
    "severity?": type.string,
  })
    .array()
    .describe("the concerns to map (pass the `concerns` array from terraform_scan/read_findings)."),
});

export function ComplianceCrosswalkTool(ctx: ToolContext) {
  void ctx;
  return tool({
    name: "terraform_compliance_crosswalk",
    description:
      "Map a scan's concerns to the UK public-sector + general compliance controls they touch (§23) — NCSC " +
      "Cloud Security Principles, Cyber Essentials, NHS DSPT, Secure by Design, CIS Controls, SOC 2 — so a " +
      "remediation PR can be narrated to an ASSESSOR in their own framework. Pass the `concerns` from " +
      "terraform_scan/read_findings; returns a per-concern control mapping plus a `by_framework` index and an " +
      "honest `unmapped_concern_ids` list. The mapping is an INDICATIVE starter rule-pack (version + review " +
      "date included) keyed on the defect theme — cite it as 'indicative alignment', never an audit verdict.",
    parameters: ComplianceCrosswalkParams,
    execute: execute(async ({ concerns }) => {
      const report = buildCrosswalkReport(concerns as ConcernForCrosswalk[]);
      log.info(
        `» terraform_compliance_crosswalk: ${report.entries.length} mapped / ${report.unmapped_concern_ids.length} unmapped across ${Object.keys(report.by_framework).length} framework(s)`,
      );
      return toolOk({
        ...report,
        note: `Indicative crosswalk v${report.version} (reviewed ${report.reviewed}) — alignment guidance, not an audit verdict.`,
      });
    }),
  });
}
