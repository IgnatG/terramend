import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

/**
 * Internal "concern" model — the Remediator's ground truth for "what is not
 * best practice". Produced by `terraform_scan` from the fork's own deterministic
 * Terraform check tools (fmt / validate / tflint / tfsec / checkov).
 *
 * This is a deliberate SUBSET of the reviewer's `findings.schema.json` v1.0
 * (../terraform-reviewer/schemas/findings.schema.json). The reviewer's findings
 * add `lens` / `standard` / `control_id` / `state` on top. Keeping the shape a
 * subset means a future reviewer integration (read_findings) can emit the same
 * Concern[] with no change to the modes or the rest of the tools — only the
 * SOURCE of concerns swaps. See REMEDIATOR-ADAPTATION.md §1.
 */
export interface Concern {
  /** stable content id: sha1(source|rule_id|file|line). idempotency key for branch/PR naming. */
  id: string;
  /** producing tool */
  source: "terraform-fmt" | "terraform-validate" | "tflint" | "tfsec" | "checkov";
  /** original namespaced rule, e.g. "tfsec:aws-s3-enable-bucket-encryption" */
  rule_id: string;
  severity: Severity;
  category: "security" | "style" | "correctness";
  /** the scanner message — what is wrong */
  evidence: string;
  location: { file: string; line: number | null };
  remediation_hint: string | null;
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function concernId(source: string, ruleId: string, file: string, line: number | null): string {
  return createHash("sha1")
    .update(`${source}|${ruleId}|${file}|${line ?? ""}`)
    .digest("hex")
    .slice(0, 12);
}

type RunResult = { status: number; stdout: string; stderr: string; missing: boolean };

/**
 * Run a scanner without throwing. Terraform tools exit non-zero when they FIND
 * issues, so a non-zero status is normal, not an error. `missing` is set when
 * the binary isn't on PATH (ENOENT) — the scanner then degrades to "skipped"
 * rather than failing the run (plan §9.2: a tool being absent must not block).
 */
function run(cmd: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    // restricted env: keeps PATH/HOME, strips secrets so a scanner (or a tflint
    // plugin) can't exfiltrate credentials.
    env: resolveEnv("restricted") as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return { status: -1, stdout: "", stderr: result.error.message, missing };
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing: false,
  };
}

type ScannerOutcome = {
  source: Concern["source"];
  ran: boolean;
  skipped_reason?: string;
  concerns: Concern[];
};

function skipped(source: Concern["source"], reason: string): ScannerOutcome {
  return { source, ran: false, skipped_reason: reason, concerns: [] };
}

// --- terraform fmt -------------------------------------------------------

function scanFmt(cwd: string): ScannerOutcome {
  const r = run("terraform", ["fmt", "-check", "-recursive", "-list=true"], cwd);
  if (r.missing) return skipped("terraform-fmt", "terraform not installed");
  // exit 0 = all formatted; exit 3 = files need formatting (lists them on stdout);
  // other non-zero = real error (e.g. parse failure) — surface nothing, validate covers it.
  if (r.status === 0) return { source: "terraform-fmt", ran: true, concerns: [] };
  return { source: "terraform-fmt", ran: true, concerns: parseFmtOutput(r.stdout) };
}

/** `terraform fmt -check -list=true` prints one unformatted file path per line. */
export function parseFmtOutput(stdout: string): Concern[] {
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return files.map<Concern>((file) => ({
    id: concernId("terraform-fmt", "unformatted", file, null),
    source: "terraform-fmt",
    rule_id: "terraform-fmt:unformatted",
    severity: "low",
    category: "style",
    evidence: "File does not match `terraform fmt` canonical style.",
    location: { file, line: null },
    remediation_hint: "Run `terraform fmt` to apply canonical formatting.",
  }));
}

// --- terraform validate ---------------------------------------------------

// diagnostics that mean the working dir just isn't initialized — environmental,
// not a real best-practice issue. dropped so a standalone run without provider
// plugins doesn't emit false positives.
const VALIDATE_NOISE = [
  "terraform init",
  "missing required provider",
  "module not installed",
  "module is not yet installed",
  "required plugins are not installed",
  "uninitialized",
];

function scanValidate(cwd: string): ScannerOutcome {
  const r = run("terraform", ["validate", "-json"], cwd);
  if (r.missing) return skipped("terraform-validate", "terraform not installed");
  try {
    return { source: "terraform-validate", ran: true, concerns: parseValidateOutput(r.stdout) };
  } catch {
    return skipped("terraform-validate", "could not parse `terraform validate -json` output");
  }
}

/** parse `terraform validate -json`; keeps real errors, drops uninitialized-dir noise. */
export function parseValidateOutput(stdout: string): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { diagnostics?: ValidateDiagnostic[] };
  const diags = (parsed.diagnostics ?? []).filter((d) => d.severity === "error");
  const concerns: Concern[] = [];
  for (const d of diags) {
    const text = `${d.summary ?? ""} ${d.detail ?? ""}`.toLowerCase();
    if (VALIDATE_NOISE.some((n) => text.includes(n))) continue;
    const file = d.range?.filename ?? "(unknown)";
    const line = d.range?.start?.line ?? null;
    concerns.push({
      id: concernId("terraform-validate", d.summary ?? "error", file, line),
      source: "terraform-validate",
      rule_id: `terraform-validate:${d.summary ?? "error"}`,
      severity: "high",
      category: "correctness",
      evidence: [d.summary, d.detail].filter(Boolean).join(" — "),
      location: { file, line },
      remediation_hint: null,
    });
  }
  return concerns;
}

interface ValidateDiagnostic {
  severity?: string;
  summary?: string;
  detail?: string;
  range?: { filename?: string; start?: { line?: number } };
}

// --- tflint ---------------------------------------------------------------

function tflintSeverity(s: string | undefined): Severity {
  switch ((s ?? "").toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    default:
      return "low";
  }
}

function scanTflint(cwd: string): ScannerOutcome {
  const r = run("tflint", ["--format", "json", "--recursive"], cwd);
  if (r.missing) return skipped("tflint", "tflint not installed");
  try {
    return { source: "tflint", ran: true, concerns: parseTflintOutput(r.stdout) };
  } catch {
    return skipped("tflint", "could not parse tflint json output");
  }
}

/** parse `tflint --format json` output into concerns. */
export function parseTflintOutput(stdout: string): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { issues?: TflintIssue[] };
  return (parsed.issues ?? []).map<Concern>((issue) => {
    const rule = issue.rule?.name ?? "issue";
    const file = issue.range?.filename ?? "(unknown)";
    const line = issue.range?.start?.line ?? null;
    return {
      id: concernId("tflint", rule, file, line),
      source: "tflint",
      rule_id: `tflint:${rule}`,
      severity: tflintSeverity(issue.rule?.severity),
      category: "style",
      evidence: issue.message ?? rule,
      location: { file, line },
      remediation_hint: issue.rule?.link ?? null,
    };
  });
}

interface TflintIssue {
  rule?: { name?: string; severity?: string; link?: string };
  message?: string;
  range?: { filename?: string; start?: { line?: number } };
}

// --- tfsec ----------------------------------------------------------------

function lowerSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "medium";
}

function scanTfsec(cwd: string): ScannerOutcome {
  const r = run("tfsec", ["--format", "json", "--no-color", "."], cwd);
  if (r.missing) return skipped("tfsec", "tfsec not installed");
  try {
    return { source: "tfsec", ran: true, concerns: parseTfsecOutput(r.stdout) };
  } catch {
    return skipped("tfsec", "could not parse tfsec json output");
  }
}

/** parse `tfsec --format json` output into concerns. */
export function parseTfsecOutput(stdout: string): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { results?: TfsecResult[] | null };
  return (parsed.results ?? []).map<Concern>((res) => {
    const file = res.location?.filename ?? "(unknown)";
    const line = res.location?.start_line ?? null;
    const rule = res.long_id ?? res.rule_id ?? "issue";
    return {
      id: concernId("tfsec", rule, file, line),
      source: "tfsec",
      rule_id: `tfsec:${rule}`,
      severity: lowerSeverity(res.severity),
      category: "security",
      evidence: res.description ?? rule,
      location: { file, line },
      remediation_hint: res.resolution ?? res.links?.[0] ?? null,
    };
  });
}

interface TfsecResult {
  rule_id?: string;
  long_id?: string;
  severity?: string;
  description?: string;
  resolution?: string;
  links?: string[];
  location?: { filename?: string; start_line?: number };
}

// --- checkov --------------------------------------------------------------

function scanCheckov(cwd: string): ScannerOutcome {
  const r = run("checkov", ["-d", ".", "-o", "json", "--compact", "--quiet"], cwd);
  if (r.missing) return skipped("checkov", "checkov not installed");
  try {
    return { source: "checkov", ran: true, concerns: parseCheckovOutput(r.stdout) };
  } catch {
    return skipped("checkov", "could not parse checkov json output");
  }
}

/** parse `checkov -o json` output (object for one framework, array for several). */
export function parseCheckovOutput(stdout: string): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as CheckovOutput | CheckovOutput[];
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const concerns: Concern[] = [];
  for (const block of blocks) {
    for (const check of block.results?.failed_checks ?? []) {
      const file = check.file_path ?? "(unknown)";
      const line = check.file_line_range?.[0] ?? null;
      const rule = check.check_id ?? "issue";
      concerns.push({
        id: concernId("checkov", rule, file, line),
        source: "checkov",
        rule_id: `checkov:${rule}`,
        severity: lowerSeverity(check.severity ?? undefined),
        category: "security",
        evidence: check.check_name ?? rule,
        location: { file, line },
        remediation_hint: check.guideline ?? null,
      });
    }
  }
  return concerns;
}

interface CheckovOutput {
  results?: {
    failed_checks?: {
      check_id?: string;
      check_name?: string;
      severity?: string | null;
      file_path?: string;
      file_line_range?: number[];
      guideline?: string;
    }[];
  };
}

// --- the tools ------------------------------------------------------------

function dedupe(concerns: Concern[]): Concern[] {
  const seen = new Set<string>();
  const out: Concern[] = [];
  for (const c of concerns) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

function sortConcerns(concerns: Concern[]): Concern[] {
  return [...concerns].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.id.localeCompare(b.id);
  });
}

/** the repo's base ref for diff-scope, or null when one can't be determined. */
function resolveBaseRef(cwd: string): string | null {
  const head = run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master"]) {
    const verify = run("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
    if (verify.status === 0 && verify.stdout.trim()) return ref;
  }
  return null;
}

/**
 * Terraform files changed on the current branch vs the base. Returns null when
 * the base can't be determined (caller then falls back to a full scan).
 */
function changedTerraformFiles(cwd: string): Set<string> | null {
  const base = resolveBaseRef(cwd);
  if (!base) return null;
  const mergeBase = run("git", ["merge-base", base, "HEAD"], cwd);
  const from = mergeBase.status === 0 && mergeBase.stdout.trim() ? mergeBase.stdout.trim() : base;
  const diff = run("git", ["diff", "--name-only", from, "HEAD"], cwd);
  if (diff.status !== 0) return null;
  const files = diff.stdout
    .split("\n")
    .map((l) => l.trim().replace(/^\.\//, ""))
    .filter((f) => f.endsWith(".tf") || f.endsWith(".tfvars"));
  return new Set(files);
}

export const TerraformScanParams = type({
  "scan_scope?": type("'full' | 'diff'").describe(
    "'full' (default) scans the whole workspace; 'diff' limits concerns to Terraform files changed vs the base branch."
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: low). 'info' includes everything."
  ),
});

export function TerraformScanTool(ctx: ToolContext) {
  return tool({
    name: "terraform_scan",
    description:
      "Scan the Terraform in the workspace against best practices using the deterministic check tools " +
      "(terraform fmt, terraform validate, tflint, tfsec, checkov). Returns a stable, severity-ranked " +
      "list of `concerns` — each is one best-practice issue with a content-derived `id`, the producing " +
      "`source`, `rule_id`, `severity`, the `location` (file + line), and a `remediation_hint`. The `id` " +
      "is the idempotency key for the remediation branch/PR. Scanners that aren't installed are reported " +
      "as skipped (they never fail the scan).",
    parameters: TerraformScanParams,
    execute: execute(async ({ scan_scope, severity_threshold }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // precedence: explicit tool arg > the run's configured severity_threshold > "low"
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      const scope = scan_scope ?? ctx.payload.scanScope ?? "full";

      const outcomes: ScannerOutcome[] = [
        scanFmt(cwd),
        scanValidate(cwd),
        scanTflint(cwd),
        scanTfsec(cwd),
        scanCheckov(cwd),
      ];

      // diff scope: keep only concerns in Terraform files changed vs the base.
      let scopeNote: string | undefined;
      let changed: Set<string> | null = null;
      if (scope === "diff") {
        changed = changedTerraformFiles(cwd);
        if (changed === null) {
          scopeNote = "diff scope requested but the base branch could not be determined — scanned full instead";
        }
      }
      const inScope = (c: Concern): boolean =>
        changed === null
          ? true
          : changed.has(c.location.file.replace(/\\/g, "/").replace(/^\.\//, ""));

      const all = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns)))
        .filter(inScope)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);

      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      const skippedScanners = outcomes
        .filter((o) => !o.ran)
        .map((o) => ({ source: o.source, reason: o.skipped_reason }));

      log.info(
        `» terraform_scan: ${all.length} concern(s) ≥ ${threshold} from [${ran.join(", ")}]` +
          (skippedScanners.length ? ` (skipped: ${skippedScanners.map((s) => s.source).join(", ")})` : "")
      );

      return {
        scanned_dir: cwd,
        scope: changed === null ? "full" : "diff",
        ...(scopeNote ? { scope_note: scopeNote } : {}),
        scanners_ran: ran,
        scanners_skipped: skippedScanners,
        summary: { total: all.length, by_severity },
        concerns: all,
      };
    }),
  });
}

export const TerraformValidateParams = type({
  "paths?": type.string.array().describe(
    "optional list of file globs/paths to limit fmt+lint to; omit to check the whole workspace"
  ),
});

export function TerraformValidateTool(ctx: ToolContext) {
  return tool({
    name: "terraform_validate",
    description:
      "Fast pre-PR gate. Runs `terraform fmt -check`, `terraform validate`, and `tflint` over the " +
      "workspace and returns whether the Terraform is well-formed and idiomatic. Call this AFTER " +
      "applying a fix and BEFORE opening a PR — never open a PR whose `terraform_validate` did not pass.",
    parameters: TerraformValidateParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const checks = [scanFmt(cwd), scanValidate(cwd), scanTflint(cwd)];
      const remaining = sortConcerns(dedupe(checks.flatMap((c) => c.concerns)));
      const ran = checks.filter((c) => c.ran).map((c) => c.source);
      return {
        passed: remaining.length === 0,
        checks_ran: ran,
        remaining_issues: remaining,
      };
    }),
  });
}
