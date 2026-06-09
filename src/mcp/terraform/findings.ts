import { ruleDocUrl } from "#app/mcp/terraform/decisions";
import {
  type Concern,
  concernId,
  isTerraformFile,
  lowerSeverity,
  type Severity,
  toRepoRelative,
} from "#app/mcp/terraform/types";

// --- reviewer findings (read_findings) ------------------------------------

/**
 * The subset of a terraform-reviewer (Assessor) `findings.json` finding that
 * Terramend consumes. The reviewer's contract is a deliberate SUPERSET of the
 * Concern model (same content-id formula, same severity enum) — see
 * ../terraform-reviewer/schemas/findings.schema.json. Extra fields
 * (lens/standard/control_id/confidence/state) are ignored except `state`.
 */
interface ReviewerFinding {
  category?: string;
  source?: string;
  rule_id?: string;
  /** verified (deterministic) | evidence (confirm manually) | human_only (out of scope). */
  state?: string;
  severity?: string;
  evidence?: string;
  location?: { file?: string; line?: number | null };
  remediation_hint?: string | null;
}

interface ReviewerFindingsReport {
  schema_version?: string;
  findings?: ReviewerFinding[] | null;
}

/**
 * Map a reviewer `source` to a Concern source. The scanners Terramend also runs
 * (checkov / tflint / trivy / terraform-fmt / terraform-validate) keep their
 * name, so re-running them reproduces the identical content id — those concerns
 * are ✗→✓ verifiable. Everything else (tfsec — whose rule ids differ from
 * trivy's — plus infracost, llm, …) collapses to `reviewer`: the original tool
 * stays visible in `rule_id`, but Terramend can't reproduce the id, so
 * `terraform_verify_remediation` will honestly report it unresolved.
 *
 * NB: trivy ✗→✓ verifiability assumes the reviewer's trivy `rule_id` equals
 * Terramend's (both `trivy:<AVDID>`). That holds today (the reviewer's SARIF
 * `ruleId` is the AVD id); if a future Trivy diverges SARIF ruleId from the
 * JSON AVDID, trivy-source findings would stop matching on re-scan.
 */
function mapReviewerSource(source: string | undefined): Concern["source"] {
  switch (source) {
    case "checkov":
    case "tflint":
    case "trivy":
    case "terraform-fmt":
    case "terraform-validate":
      return source;
    default:
      return "reviewer";
  }
}

function mapReviewerCategory(category: string | undefined): Concern["category"] {
  switch (category) {
    case "security":
      return "security";
    case "style":
      return "style";
    case "cost":
      return "cost";
    default:
      return "correctness";
  }
}

/**
 * Map a reviewer `findings.json` body into Concern[]. Drops `human_only`
 * findings (out of scope — not auto-remediable). Paths are normalized to
 * repo-relative POSIX (same as the scanners) so ids and grouping stay portable.
 */
export function parseReviewerFindings(json: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(json || "{}") as ReviewerFindingsReport;
  const out: Concern[] = [];
  for (const f of parsed.findings ?? []) {
    if (f.state === "human_only") continue;
    const file = toRepoRelative(f.location?.file, cwd);
    // Skip findings that don't point at a Terraform file — they aren't per-file
    // remediable. In particular the reviewer's infracost/cost findings are keyed
    // to a project *directory* (not a `.tf`), so they land here; cost is surfaced
    // during remediation by `infracost_diff` (E1), not by editing a directory.
    if (!isTerraformFile(file)) continue;
    const line = f.location?.line ?? null;
    const source = mapReviewerSource(f.source);
    const ruleId = f.rule_id || "finding";
    // Terramend's own parsers store `rule_id` namespaced (`${source}:${rule}`)
    // but hash only the bare rule into the content id. Strip a matching
    // `${source}:` prefix so a checkov/tflint/trivy/fmt finding from the reviewer
    // reproduces the SAME id Terramend's own scan would — keeping it ✗→✓
    // verifiable. `reviewer`-source findings keep the full rule_id in the hash
    // (they aren't reproducible anyway). Both namespaced and bare inputs work.
    const bareRule =
      source !== "reviewer" && ruleId.startsWith(`${source}:`)
        ? ruleId.slice(source.length + 1)
        : ruleId;
    out.push({
      id: concernId(source, bareRule, file, line),
      source,
      rule_id: ruleId,
      severity: lowerSeverity(f.severity),
      category: mapReviewerCategory(f.category),
      evidence: f.evidence || ruleId,
      location: { file, line },
      remediation_hint: f.remediation_hint ?? null,
    });
  }
  return out;
}

// --- SARIF ingestion (read_findings) --------------------------------------

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}
interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string };
  locations?: SarifLocation[];
  properties?: { "security-severity"?: string };
}
interface SarifRule {
  id?: string;
  helpUri?: string;
  shortDescription?: { text?: string };
}
interface SarifRun {
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}
interface SarifReport {
  version?: string;
  $schema?: string;
  runs?: SarifRun[];
}

/** true when a parsed JSON object looks like a SARIF report (the standard
 * scanner-output format) rather than a terraform-reviewer findings.json. */
export function isSarif(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const o = parsed as Record<string, unknown>;
  const schema = typeof o.$schema === "string" ? o.$schema.toLowerCase() : "";
  return Array.isArray(o.runs) && (schema.includes("sarif") || typeof o.version === "string");
}

/** map a SARIF driver name to a Concern source (so a re-run reproduces the id
 * for the scanners Terramend also runs; everything else → `reviewer`). */
function mapSarifDriver(name: string | undefined): Concern["source"] {
  switch ((name ?? "").toLowerCase()) {
    case "trivy":
      return "trivy";
    case "checkov":
      return "checkov";
    case "tflint":
      return "tflint";
    default:
      return "reviewer";
  }
}

/** SARIF `level` → severity (a `security-severity` property refines it). */
function sarifSeverity(level: string | undefined, securitySeverity: string | undefined): Severity {
  const score = securitySeverity ? Number.parseFloat(securitySeverity) : Number.NaN;
  if (Number.isFinite(score)) {
    if (score >= 9) return "critical";
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    if (score > 0) return "low";
  }
  switch ((level ?? "").toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "note":
      return "low";
    default:
      return "info";
  }
}

/**
 * Parse a SARIF 2.1.0 report (the standard scanner-output format Trivy /
 * Checkov / tflint all emit) into Concern[]. The driver name picks the source so
 * a finding from a scanner Terramend re-runs reproduces the SAME content id
 * (✗→✓ verifiable); other tools collapse to `reviewer`. Rule docs come from the
 * matching `tool.driver.rules[].helpUri`. Non-Terraform files are dropped.
 */
export function parseSarifFindings(json: string, cwd = ""): Concern[] {
  let report: SarifReport;
  try {
    report = JSON.parse(json || "{}") as SarifReport;
  } catch {
    return [];
  }
  const out: Concern[] = [];
  for (const run of report.runs ?? []) {
    const source = mapSarifDriver(run.tool?.driver?.name);
    const ruleDocs = new Map<string, string>();
    for (const rule of run.tool?.driver?.rules ?? []) {
      if (rule.id && rule.helpUri) ruleDocs.set(rule.id, rule.helpUri);
    }
    for (const result of run.results ?? []) {
      const loc = result.locations?.[0]?.physicalLocation;
      const file = toRepoRelative(loc?.artifactLocation?.uri, cwd);
      if (!isTerraformFile(file)) continue;
      const start = loc?.region?.startLine;
      const line = typeof start === "number" && start > 0 ? start : null;
      const rawRule = result.ruleId || "finding";
      // strip a `${source}:` prefix if a tool already namespaced it, so the
      // content id matches Terramend's own scan of the same rule.
      const bareRule =
        source !== "reviewer" && rawRule.startsWith(`${source}:`)
          ? rawRule.slice(source.length + 1)
          : rawRule;
      const ruleId = source === "reviewer" ? rawRule : `${source}:${bareRule}`;
      out.push({
        id: concernId(source, bareRule, file, line),
        source,
        rule_id: ruleId,
        severity: sarifSeverity(result.level, result.properties?.["security-severity"]),
        category: source === "tflint" ? "style" : "security",
        evidence: result.message?.text || ruleId,
        location: { file, line },
        remediation_hint: ruleDocs.get(rawRule) ?? null,
      });
    }
  }
  return out;
}

/** dispatch a findings file to the right parser: SARIF (standard scanner
 * output) or a terraform-reviewer findings.json. */
export function parseFindingsFile(json: string, cwd = ""): Concern[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "{}");
  } catch {
    return [];
  }
  return isSarif(parsed) ? parseSarifFindings(json, cwd) : parseReviewerFindings(json, cwd);
}

// --- SARIF emit (GitHub code-scanning) ------------------------------------

/** Concern severity → SARIF `level`. SARIF has only error/warning/note, so
 * critical+high collapse to `error`, medium → `warning`, low+info → `note`. The
 * finer grade survives in the `security-severity` property below. */
function severityToSarifLevel(s: Severity): "error" | "warning" | "note" {
  switch (s) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "note";
  }
}

/** Concern severity → the numeric `security-severity` GitHub reads to colour the
 * alert (0–10 CVSS-like scale). */
function securitySeverityScore(s: Severity): string {
  switch (s) {
    case "critical":
      return "9.5";
    case "high":
      return "8.0";
    case "medium":
      return "5.0";
    case "low":
      return "2.0";
    default:
      return "0.0";
  }
}

/**
 * Emit a set of concerns as a SARIF 2.1.0 report for GitHub code-scanning (the
 * inverse of `parseSarifFindings` — close the loop so a Terramend scan can
 * populate the repo's Security tab via `github/codeql-action/upload-sarif`). One
 * `run` with the `terramend` driver, a deduped `rules` array (each rule's
 * `helpUri` from `ruleDocUrl`), and one `result` per concern carrying its
 * `level`, `security-severity`, message, and `file:line`. Pure + deterministic
 * (rules sorted, stable partialFingerprints from the content id) so re-emitting
 * an unchanged scan yields a byte-identical report.
 */
export function buildSarifReport(concerns: Concern[]): SarifReport {
  // deduped rule metadata, keyed by the namespaced rule_id (the SARIF ruleId).
  const rulesById = new Map<string, SarifRule>();
  for (const c of concerns) {
    if (rulesById.has(c.rule_id)) continue;
    const helpUri = ruleDocUrl(c);
    rulesById.set(c.rule_id, {
      id: c.rule_id,
      ...(helpUri ? { helpUri } : {}),
      shortDescription: { text: c.evidence.slice(0, 200) },
    });
  }
  const rules = [...rulesById.values()].sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""));
  const results: SarifResult[] = concerns.map((c) => ({
    ruleId: c.rule_id,
    level: severityToSarifLevel(c.severity),
    message: { text: c.evidence },
    properties: { "security-severity": securitySeverityScore(c.severity) },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: c.location.file },
          ...(c.location.line ? { region: { startLine: c.location.line } } : {}),
        },
      },
    ],
  }));
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{ tool: { driver: { name: "terramend", rules } }, results }],
  };
}
