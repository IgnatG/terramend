import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

/**
 * Internal "concern" model — the Remediator's ground truth for "what is not
 * best practice". Produced by `terraform_scan` from the fork's own deterministic
 * Terraform check tools (fmt / validate / tflint / trivy / checkov).
 *
 * This is a deliberate SUBSET of the reviewer's `findings.schema.json` v1.0
 * (../terraform-reviewer/schemas/findings.schema.json). The reviewer's findings
 * add `lens` / `standard` / `control_id` / `state` on top. Keeping the shape a
 * subset means a future reviewer integration (read_findings) can emit the same
 * Concern[] with no change to the modes or the rest of the tools — only the
 * SOURCE of concerns swaps.
 */
export interface Concern {
  /** stable content id: sha1(source|rule_id|file|line). idempotency key for branch/PR naming. */
  id: string;
  /** producing tool. `reviewer` marks a concern loaded from a terraform-reviewer
   * findings.json whose original tool isn't one Terramend re-runs (tfsec / infracost
   * / llm) — its provenance lives in `rule_id`. */
  source: "terraform-fmt" | "terraform-validate" | "tflint" | "trivy" | "checkov" | "reviewer";
  /** original namespaced rule, e.g. "trivy:AVD-AWS-0088" */
  rule_id: string;
  severity: Severity;
  category: "security" | "style" | "correctness" | "cost";
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

/**
 * Normalize a scanner-reported path to a repo-relative POSIX path. Each scanner
 * reports the file differently — tflint gives `main.tf` (relative), trivy a
 * scan-dir-relative `Target`, terraform an absolute path (`/repo/main.tf` or
 * `D:\repo\main.tf`), checkov a leading-slash path (`/main.tf`). Left
 * unnormalized, these leak into `location.file` AND the
 * content-derived `concernId`, making the id (and the `remediate/<id>` branch)
 * machine-dependent and breaking the ✗→✓ re-scan id match across environments.
 * So normalize BEFORE building any Concern.
 */
function toRepoRelative(raw: string | undefined, cwd: string): string {
  if (!raw) return "(unknown)";
  const posix = raw.replace(/\\/g, "/");
  const cwdPosix = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  let rel = posix;
  if (cwdPosix && posix.toLowerCase().startsWith(`${cwdPosix.toLowerCase()}/`)) {
    rel = posix.slice(cwdPosix.length + 1);
  }
  // strip any leading "./" or "/" (checkov reports paths relative to its -d root
  // with a leading separator).
  rel = rel.replace(/^(?:\.\/|\/)+/, "");
  return rel || "(unknown)";
}

type RunResult = { status: number; stdout: string; stderr: string; missing: boolean };

/**
 * Run a scanner without throwing. Terraform tools exit non-zero when they FIND
 * issues, so a non-zero status is normal, not an error. `missing` is set when
 * the binary isn't on PATH (ENOENT) — the scanner then degrades to "skipped"
 * rather than failing the run (plan §9.2: a tool being absent must not block).
 *
 * `extraEnv` opts a specific command back into a needed credential: the scanners
 * run with a restricted env that strips every `*_KEY`/secret, but infracost
 * legitimately needs its `INFRACOST_API_KEY`. resolveEnv(object) merges the
 * restricted base with the explicit vars, so only the named keys get through.
 */
function run(cmd: string, args: string[], cwd: string, extraEnv?: Record<string, string>): RunResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    // restricted env: keeps PATH/HOME, strips secrets so a scanner (or a tflint
    // plugin) can't exfiltrate credentials. `extraEnv` re-admits only the named vars.
    env: resolveEnv(extraEnv ?? "restricted") as NodeJS.ProcessEnv,
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

// dirs already `terraform init`-ed this process, so repeated scans don't re-init.
const initedDirs = new Set<string>();

/**
 * Run `terraform init -backend=false` once per dir so `terraform validate` has
 * provider schemas to check against (Bug 3 / gap B). Without init, validate only
 * emits "missing required provider" — which VALIDATE_NOISE drops — so it was
 * effectively inert. `-backend=false` avoids needing real backend credentials;
 * `-input=false` keeps it non-interactive. Network-dependent and best-effort: if
 * it fails (offline, private module, etc.) validate still runs, just shallow.
 */
function ensureTerraformInit(cwd: string): void {
  if (initedDirs.has(cwd)) return;
  const r = run("terraform", ["init", "-backend=false", "-input=false", "-no-color"], cwd);
  // mark done even on non-zero: a failed init won't succeed on retry within the
  // same run, and we don't want to re-run it for every scanner call.
  initedDirs.add(cwd);
  if (r.status !== 0 && !r.missing) {
    log.info(`» terraform init (for validate) did not complete cleanly — validate may be shallow`);
  }
}

// --- terraform fmt -------------------------------------------------------

function scanFmt(cwd: string): ScannerOutcome {
  const r = run("terraform", ["fmt", "-check", "-recursive", "-list=true"], cwd);
  if (r.missing) return skipped("terraform-fmt", "terraform not installed");
  // exit 0 = all formatted; exit 3 = files need formatting (lists them on stdout);
  // other non-zero = real error (e.g. parse failure) — surface nothing, validate covers it.
  if (r.status === 0) return { source: "terraform-fmt", ran: true, concerns: [] };
  return { source: "terraform-fmt", ran: true, concerns: parseFmtOutput(r.stdout, cwd) };
}

/** `terraform fmt -check -list=true` prints one unformatted file path per line. */
export function parseFmtOutput(stdout: string, cwd = ""): Concern[] {
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return files.map<Concern>((raw) => {
    const file = toRepoRelative(raw, cwd);
    return {
      id: concernId("terraform-fmt", "unformatted", file, null),
      source: "terraform-fmt",
      rule_id: "terraform-fmt:unformatted",
      severity: "low",
      category: "style",
      evidence: "File does not match `terraform fmt` canonical style.",
      location: { file, line: null },
      remediation_hint: "Run `terraform fmt` to apply canonical formatting.",
    };
  });
}

// --- terraform validate ---------------------------------------------------

// diagnostics that are environmental (the dir isn't initialized, or a provider
// plugin failed to install/launch) rather than a real best-practice issue.
// dropped so a scan can't emit false positives from toolchain hiccups — e.g.
// after `terraform init` (Bug 3), a crashed provider plugin surfaces as
// "Failed to load plugin schemas", which is noise, not a defect in the HCL.
const VALIDATE_NOISE = [
  "terraform init",
  "missing required provider",
  "module not installed",
  "module is not yet installed",
  "required plugins are not installed",
  "uninitialized",
  "failed to load plugin",
  "plugin did not respond",
  "could not load plugin",
];

function scanValidate(cwd: string): ScannerOutcome {
  ensureTerraformInit(cwd);
  const r = run("terraform", ["validate", "-json"], cwd);
  if (r.missing) return skipped("terraform-validate", "terraform not installed");
  try {
    return { source: "terraform-validate", ran: true, concerns: parseValidateOutput(r.stdout, cwd) };
  } catch {
    return skipped("terraform-validate", "could not parse `terraform validate -json` output");
  }
}

/** parse `terraform validate -json`; keeps real errors, drops uninitialized-dir noise. */
export function parseValidateOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { diagnostics?: ValidateDiagnostic[] };
  const diags = (parsed.diagnostics ?? []).filter((d) => d.severity === "error");
  const concerns: Concern[] = [];
  for (const d of diags) {
    const text = `${d.summary ?? ""} ${d.detail ?? ""}`.toLowerCase();
    if (VALIDATE_NOISE.some((n) => text.includes(n))) continue;
    const file = toRepoRelative(d.range?.filename, cwd);
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

// dirs we've already attempted `tflint --init` in, so repeated scans don't re-init.
const tflintInitedDirs = new Set<string>();

/**
 * Install tflint's provider ruleset plugins via `tflint --init` when the dir has
 * a `.tflint.hcl` declaring them. Core `tflint --recursive` runs only the
 * built-in rules; the high-value provider rules (deprecated args, invalid
 * instance types, missing-tag policies, etc.) live in the aws/azurerm/google
 * plugins, which must be installed first. Opt-in by design — we only init when
 * the repo ships a `.tflint.hcl`, so we don't force AWS rules onto an Azure/GCP
 * repo. Best-effort and network-dependent: a failed init just leaves tflint
 * running its core rules, exactly as before.
 */
function ensureTflintInit(cwd: string): void {
  if (tflintInitedDirs.has(cwd)) return;
  // mark first: a failed init won't succeed on retry within the same run, and
  // we don't want to re-attempt the network fetch on every scanner call.
  tflintInitedDirs.add(cwd);
  if (!existsSync(join(cwd, ".tflint.hcl"))) return;
  const r = run("tflint", ["--init"], cwd);
  if (r.status !== 0 && !r.missing) {
    log.info("» tflint --init did not complete cleanly — provider ruleset plugins may be unavailable");
  }
}

function scanTflint(cwd: string): ScannerOutcome {
  ensureTflintInit(cwd);
  const r = run("tflint", ["--format", "json", "--recursive"], cwd);
  if (r.missing) return skipped("tflint", "tflint not installed");
  try {
    return { source: "tflint", ran: true, concerns: parseTflintOutput(r.stdout, cwd) };
  } catch {
    return skipped("tflint", "could not parse tflint json output");
  }
}

/** parse `tflint --format json` output into concerns. */
export function parseTflintOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { issues?: TflintIssue[] };
  return (parsed.issues ?? []).map<Concern>((issue) => {
    const rule = issue.rule?.name ?? "issue";
    const file = toRepoRelative(issue.range?.filename, cwd);
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

// --- trivy ----------------------------------------------------------------

function lowerSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "medium";
}

// tfsec was archived by Aqua and folded into Trivy; `trivy config` is its
// maintained successor with a larger ruleset (the AVD-* checks). `--quiet`
// keeps Trivy's progress chatter off stdout so the JSON parses cleanly.
function scanTrivy(cwd: string): ScannerOutcome {
  const r = run("trivy", ["config", "--format", "json", "--quiet", "."], cwd);
  if (r.missing) return skipped("trivy", "trivy not installed");
  try {
    return { source: "trivy", ran: true, concerns: parseTrivyOutput(r.stdout, cwd) };
  } catch {
    return skipped("trivy", "could not parse trivy json output");
  }
}

/**
 * Parse `trivy config --format json` output into concerns. Trivy nests
 * misconfigurations under `Results[].Misconfigurations[]`, keyed to the result's
 * `Target` file. `trivy config` reports only failures by default, but we
 * defensively drop any `Status: "PASS"` entry so an `--include-non-failures`
 * run can't leak passing checks into the concern set.
 */
export function parseTrivyOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as { Results?: TrivyResult[] | null };
  const concerns: Concern[] = [];
  for (const result of parsed.Results ?? []) {
    const file = toRepoRelative(result.Target, cwd);
    for (const m of result.Misconfigurations ?? []) {
      if (m.Status === "PASS") continue;
      const rule = m.AVDID || m.ID || "issue";
      const start = m.CauseMetadata?.StartLine;
      const line = typeof start === "number" && start > 0 ? start : null;
      concerns.push({
        id: concernId("trivy", rule, file, line),
        source: "trivy",
        rule_id: `trivy:${rule}`,
        severity: lowerSeverity(m.Severity),
        category: "security",
        evidence: m.Message || m.Description || m.Title || rule,
        location: { file, line },
        remediation_hint: m.Resolution || m.References?.[0] || null,
      });
    }
  }
  return concerns;
}

interface TrivyMisconfiguration {
  ID?: string;
  AVDID?: string;
  Title?: string;
  Description?: string;
  Message?: string;
  Resolution?: string;
  Severity?: string;
  References?: string[];
  Status?: string;
  CauseMetadata?: { StartLine?: number; EndLine?: number };
}

interface TrivyResult {
  Target?: string;
  Class?: string;
  Type?: string;
  Misconfigurations?: TrivyMisconfiguration[];
}

// --- checkov --------------------------------------------------------------

function scanCheckov(cwd: string): ScannerOutcome {
  // `--framework terraform` keeps checkov to Terraform only. By default checkov
  // also scans github_actions / dockerfile / secrets / kubernetes / etc., which
  // surfaces concerns in files Terramend can never remediate (the path guardrail
  // blocks anything outside *.tf/*.tfvars) — pure noise. Terramend is
  // Terraform-only, so we scope the scanner to match.
  const r = run("checkov", ["-d", ".", "--framework", "terraform", "-o", "json", "--compact", "--quiet"], cwd);
  if (r.missing) return skipped("checkov", "checkov not installed");
  try {
    return { source: "checkov", ran: true, concerns: parseCheckovOutput(r.stdout, cwd) };
  } catch {
    return skipped("checkov", "could not parse checkov json output");
  }
}

/** parse `checkov -o json` output (object for one framework, array for several). */
export function parseCheckovOutput(stdout: string, cwd = ""): Concern[] {
  const parsed = JSON.parse(stdout || "{}") as CheckovOutput | CheckovOutput[];
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const concerns: Concern[] = [];
  for (const block of blocks) {
    for (const check of block.results?.failed_checks ?? []) {
      const file = toRepoRelative(check.file_path, cwd);
      // checkov emits 0 for "no specific line"; normalize to null (matching the
      // trivy parser and the reviewer's findings.json) so the content id is
      // stable and a reviewer-loaded checkov concern re-verifies ✗→✓.
      const startLine = check.file_line_range?.[0];
      const line = typeof startLine === "number" && startLine > 0 ? startLine : null;
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

/** true when a path is a Terraform source file Terramend may remediate. */
function isTerraformFile(file: string): boolean {
  const f = file.toLowerCase();
  return f.endsWith(".tf") || f.endsWith(".tfvars");
}

/**
 * Terramend is Terraform-only. A concern in a non-`.tf`/`.tfvars` file can never
 * be remediated (the `allowed_paths` push guardrail blocks it) and is pure noise,
 * so any scanner that also inspects other IaC — checkov's github_actions, trivy's
 * dockerfile/kubernetes — gets filtered down to Terraform here. This is the
 * catch-all backstop; `scanCheckov` also scopes itself with `--framework terraform`.
 */
export function isTerraformConcern(c: Concern): boolean {
  return isTerraformFile(c.location.file);
}

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

/**
 * A scoped unit of work = all concerns in one file. Different scanners flag the
 * same underlying defect under different rule ids (trivy ∩ checkov overlap
 * heavily on e.g. S3 buckets), so per-concern PRs would spam many PRs for one
 * bad file. Remediate acts on ONE group per PR (branch `remediate/<group.id>`),
 * fixing every concern in the file together and proving them all cleared (✗→✓).
 */
export interface ConcernGroup {
  /** stable id derived from the file — the remediation branch/PR key. */
  id: string;
  file: string;
  /** highest severity among the group's concerns. */
  severity: Severity;
  concern_count: number;
  /** distinct rule ids in the group, for the PR body. */
  rule_ids: string[];
  /** the concern ids the re-scan must confirm are gone to call this ✓. */
  concern_ids: string[];
}

function groupId(file: string): string {
  return createHash("sha1").update(`group|${file}`).digest("hex").slice(0, 12);
}

/** group concerns by file into scoped units, sorted by max severity. */
export function groupConcerns(concerns: Concern[]): ConcernGroup[] {
  const byFile = new Map<string, Concern[]>();
  for (const c of concerns) {
    const arr = byFile.get(c.location.file) ?? [];
    arr.push(c);
    byFile.set(c.location.file, arr);
  }
  const groups: ConcernGroup[] = [];
  for (const [file, cs] of byFile) {
    const severity = cs.reduce<Severity>(
      (max, c) => (SEVERITY_RANK[c.severity] > SEVERITY_RANK[max] ? c.severity : max),
      "info"
    );
    groups.push({
      id: groupId(file),
      file,
      severity,
      concern_count: cs.length,
      rule_ids: [...new Set(cs.map((c) => c.rule_id))].sort(),
      concern_ids: cs.map((c) => c.id),
    });
  }
  return groups.sort((a, b) => {
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

/** run every scanner once over `cwd`. shared by `terraform_scan` and the
 * deterministic remediation verifier so both see the identical toolchain. */
function runScanners(cwd: string): ScannerOutcome[] {
  return [scanFmt(cwd), scanValidate(cwd), scanTflint(cwd), scanTrivy(cwd), scanCheckov(cwd)];
}

export interface RemediationVerdict {
  /** true only when every original concern id is absent from the re-scan. */
  verified: boolean;
  /** original ids no longer present (the fix cleared them). */
  resolved: string[];
  /** original ids still present (the fix did NOT clear them). */
  remaining: string[];
}

/**
 * Deterministic ✗→✓ check: partition the group's original `concern_ids` into
 * those gone from a fresh scan (`resolved`) and those still present
 * (`remaining`). Concern ids are content hashes (`sha1(source|rule|file|line)`),
 * so a missing id means that exact concern is gone — the correct primitive for
 * "did the fix clear it", independent of severity/scope filtering. This is the
 * code-level replacement for the agent eyeballing a re-scan and self-reporting.
 */
export function computeRemediationVerdict(
  originalConcernIds: string[],
  currentConcernIds: Set<string>
): RemediationVerdict {
  const resolved: string[] = [];
  const remaining: string[] = [];
  for (const id of originalConcernIds) {
    if (currentConcernIds.has(id)) remaining.push(id);
    else resolved.push(id);
  }
  return { verified: remaining.length === 0, resolved, remaining };
}

// --- infracost (cost lens) ------------------------------------------------

export interface CostBreakdown {
  /** total estimated monthly cost, or null when no resources are priced. */
  totalMonthlyCost: number | null;
  currency: string;
}

/**
 * Parse `infracost breakdown --format json`. The top-level `totalMonthlyCost`
 * is a decimal string (absent / null when a project has no priced resources);
 * `currency` defaults to USD. A missing/unparseable cost becomes null so the
 * caller reports "unpriced" rather than a misleading $0.00.
 */
export function parseInfracostBreakdown(stdout: string): CostBreakdown {
  const parsed = JSON.parse(stdout || "{}") as {
    totalMonthlyCost?: string | number | null;
    currency?: string;
  };
  const raw = parsed.totalMonthlyCost;
  const num = typeof raw === "number" ? raw : raw != null ? Number.parseFloat(raw) : Number.NaN;
  return {
    totalMonthlyCost: Number.isFinite(num) ? num : null,
    currency: parsed.currency || "USD",
  };
}

export interface CostDelta {
  currency: string;
  baselineMonthly: number | null;
  currentMonthly: number | null;
  /** current − baseline, rounded to cents; null when either side is unknown. */
  deltaMonthly: number | null;
  direction: "increase" | "decrease" | "no-change" | "unknown";
}

/** Pure cost-delta computation: current (post-fix) vs the base-branch baseline. */
export function computeCostDelta(baseline: CostBreakdown | null, current: CostBreakdown): CostDelta {
  const currency = current.currency || baseline?.currency || "USD";
  const baselineMonthly = baseline?.totalMonthlyCost ?? null;
  const currentMonthly = current.totalMonthlyCost;
  if (baselineMonthly === null || currentMonthly === null) {
    return { currency, baselineMonthly, currentMonthly, deltaMonthly: null, direction: "unknown" };
  }
  const deltaMonthly = Math.round((currentMonthly - baselineMonthly) * 100) / 100;
  const direction = deltaMonthly > 0 ? "increase" : deltaMonthly < 0 ? "decrease" : "no-change";
  return { currency, baselineMonthly, currentMonthly, deltaMonthly, direction };
}

function runInfracostBreakdown(scanCwd: string, key: string): RunResult {
  return run("infracost", ["breakdown", "--path", ".", "--format", "json", "--no-color"], scanCwd, {
    INFRACOST_API_KEY: key,
  });
}

/**
 * Cost of the base-branch version of the same Terraform, computed in a detached
 * git worktree so the current (fixed) checkout is never disturbed. Best-effort:
 * any failure (no base ref, worktree add fails, infracost errors) returns null
 * and the caller falls back to reporting current cost only.
 */
function infracostBaseline(cwd: string, key: string, tmpdir: string): CostBreakdown | null {
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) return null;
  const prefixResult = run("git", ["rev-parse", "--show-prefix"], cwd);
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
  const worktree = join(tmpdir, `infracost-base-${process.pid}`);
  // clear any stale worktree from an earlier call in this process before re-adding.
  run("git", ["worktree", "remove", "--force", worktree], cwd);
  const add = run("git", ["worktree", "add", "--detach", worktree, baseRef], cwd);
  if (add.status !== 0) return null;
  try {
    const scanCwd = prefix ? join(worktree, prefix) : worktree;
    const r = runInfracostBreakdown(scanCwd, key);
    if (r.missing || r.status !== 0) return null;
    return parseInfracostBreakdown(r.stdout);
  } catch {
    return null;
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], cwd);
  }
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
      "(terraform fmt, terraform validate, tflint, trivy, checkov). Returns a stable, severity-ranked " +
      "list of `concerns` — each is one best-practice issue with a content-derived `id`, the producing " +
      "`source`, `rule_id`, `severity`, the `location` (file + line), and a `remediation_hint`. Concerns " +
      "are also rolled up into `groups` (one per file): different scanners flag the same defect under " +
      "different rule ids, so remediate ONE group per PR (its `id` is the branch/PR key; its `concern_ids` " +
      "are what the ✗→✓ re-scan must confirm cleared) rather than one PR per concern. Scanners that aren't " +
      "installed are reported as skipped (they never fail the scan).",
    parameters: TerraformScanParams,
    execute: execute(async ({ scan_scope, severity_threshold }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      // precedence: explicit tool arg > the run's configured severity_threshold > "low"
      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];
      const scope = scan_scope ?? ctx.payload.scanScope ?? "full";

      const outcomes = runScanners(cwd);

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
        .filter(isTerraformConcern)
        .filter(inScope)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);

      const groups = groupConcerns(all);

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
        summary: { total: all.length, groups: groups.length, by_severity },
        groups,
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

export const TerraformVerifyRemediationParams = type({
  concern_ids: type.string.array().describe(
    "the `concern_ids` of the group being remediated (from the original terraform_scan). the tool re-runs the scanners and reports which are now resolved vs still present."
  ),
});

export function TerraformVerifyRemediationTool(ctx: ToolContext) {
  return tool({
    name: "terraform_verify_remediation",
    description:
      "Deterministic ✗→✓ proof for a remediation. Re-runs the scanners and partitions the given " +
      "`concern_ids` into `resolved` (gone from the re-scan) and `remaining` (still present), with a " +
      "`verified` flag that is true ONLY when every id is gone. Call this AFTER pushing the fix branch " +
      "and build the PR's Validation section from its result — do NOT eyeball a scan or self-report " +
      "resolution. A concern may be listed as ✓ resolved only if it appears in `resolved`.",
    parameters: TerraformVerifyRemediationParams,
    execute: execute(async ({ concern_ids }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const outcomes = runScanners(cwd);
      const current = new Set(dedupe(outcomes.flatMap((o) => o.concerns)).map((c) => c.id));
      const verdict = computeRemediationVerdict(concern_ids, current);
      const ran = outcomes.filter((o) => o.ran).map((o) => o.source);
      log.info(
        `» terraform_verify_remediation: ${verdict.resolved.length}/${concern_ids.length} resolved` +
          ` (${verdict.remaining.length} still present) from [${ran.join(", ")}]`
      );
      return {
        verified: verdict.verified,
        resolved_count: verdict.resolved.length,
        remaining_count: verdict.remaining.length,
        resolved: verdict.resolved,
        remaining: verdict.remaining,
        scanners_ran: ran,
      };
    }),
  });
}

export const InfracostDiffParams = type({});

export function InfracostDiffTool(ctx: ToolContext) {
  return tool({
    name: "infracost_diff",
    description:
      "Estimate the monthly cost impact of the remediation. Runs Infracost on the current (fixed) " +
      "Terraform and, when the base branch is resolvable, on the base version too — returning the " +
      "monthly cost delta so a security fix that meaningfully raises spend can be flagged rather than " +
      "merged blindly. Auto-skips (never fails) when INFRACOST_API_KEY is unset or the infracost CLI " +
      "is absent — cost analysis is opt-in. Call it after the fix is committed and, when it returns " +
      "`ran: true`, fold a one-line cost note into the PR body.",
    parameters: InfracostDiffParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const key = process.env.INFRACOST_API_KEY || undefined;
      if (!key) {
        return { ran: false, skipped_reason: "INFRACOST_API_KEY not set — cost analysis is opt-in" };
      }
      const cur = runInfracostBreakdown(cwd, key);
      if (cur.missing) return { ran: false, skipped_reason: "infracost not installed" };
      if (cur.status !== 0) {
        return {
          ran: false,
          skipped_reason: `infracost breakdown failed: ${cur.stderr.trim().slice(0, 300) || "unknown error"}`,
        };
      }
      let current: CostBreakdown;
      try {
        current = parseInfracostBreakdown(cur.stdout);
      } catch {
        return { ran: false, skipped_reason: "could not parse infracost json output" };
      }
      const baseline = infracostBaseline(cwd, key, ctx.tmpdir);
      const delta = computeCostDelta(baseline, current);
      log.info(
        `» infracost_diff: current ${delta.currentMonthly ?? "?"} ${delta.currency}/mo` +
          (delta.deltaMonthly !== null
            ? `, delta ${delta.deltaMonthly >= 0 ? "+" : ""}${delta.deltaMonthly}`
            : " (no baseline)")
      );
      return {
        ran: true,
        currency: delta.currency,
        current_monthly_cost: delta.currentMonthly,
        baseline_monthly_cost: delta.baselineMonthly,
        monthly_delta: delta.deltaMonthly,
        direction: delta.direction,
        ...(delta.deltaMonthly === null
          ? {
              note: "Baseline cost unavailable (no base ref or unpriced) — reporting current monthly cost only.",
            }
          : {}),
      };
    }),
  });
}

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

// --- terraform plan (the safety gate) -------------------------------------

export interface PlanSummary {
  /** resources to add / change / destroy, from the plan's change_summary. */
  add: number;
  change: number;
  destroy: number;
  /** resources that would be deleted or replaced — the destructive set. */
  destructive: { address: string; action: string }[];
  hasDestroyOrReplace: boolean;
}

/**
 * Parse `terraform plan -json` (newline-delimited JSON). `change_summary` gives
 * the add/change/destroy totals; each `planned_change` whose action deletes or
 * replaces a resource is collected as destructive (the high-risk set a reviewer
 * must scrutinise). Non-JSON / non-plan lines are ignored, so a noisy stream
 * (provider logs, diagnostics) parses cleanly.
 */
export function parseTerraformPlanJson(stdout: string): PlanSummary {
  let add = 0;
  let change = 0;
  let destroy = 0;
  const destructive: { address: string; action: string }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let msg: {
      type?: string;
      changes?: { add?: number; change?: number; remove?: number };
      change?: { action?: string; resource?: { addr?: string; resource?: string } };
    };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.type === "change_summary" && msg.changes) {
      add = Number(msg.changes.add) || 0;
      change = Number(msg.changes.change) || 0;
      destroy = Number(msg.changes.remove) || 0;
    } else if (msg.type === "planned_change" && msg.change) {
      const action = String(msg.change.action ?? "");
      // "delete", "replace", and the "*-then-delete" / "delete-then-*" forms.
      if (action.includes("delete") || action === "replace") {
        const address = msg.change.resource?.addr || msg.change.resource?.resource || "(unknown)";
        destructive.push({ address, action });
      }
    }
  }
  return { add, change, destroy, destructive, hasDestroyOrReplace: destructive.length > 0 };
}

// env vars that signal a cloud provider credential is present — terraform plan
// needs live provider/backend access, so we only attempt it when one is set.
const CLOUD_CRED_SIGNALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ARM_CLIENT_ID",
  "ARM_USE_OIDC",
  "AZURE_CLIENT_ID",
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
] as const;

function hasCloudCredentials(): boolean {
  return CLOUD_CRED_SIGNALS.some((k) => !!process.env[k]);
}

// env vars terraform/providers legitimately consume, re-admitted past the
// secret-stripping `run()` env for the plan invocation. PREFIXES are only ones
// that can't collide with an LLM/secret key — NB the bare `GOOGLE_` prefix is
// deliberately NOT used (it would re-admit the Gemini key
// `GOOGLE_GENERATIVE_AI_API_KEY`); GCP creds are matched by exact NAME instead.
const CLOUD_CRED_PREFIXES = ["AWS_", "ARM_", "AZURE_", "GCLOUD_", "GOOGLE_CLOUD_", "TF_VAR_", "TF_TOKEN_", "TF_CLI_"];
const CLOUD_CRED_NAMES = new Set([
  "GOOGLE_CREDENTIALS",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GOOGLE_OAUTH_ACCESS_TOKEN",
  "GOOGLE_PROJECT",
  "GOOGLE_REGION",
  "GOOGLE_ZONE",
  "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT",
]);

export function collectCloudCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (CLOUD_CRED_PREFIXES.some((p) => k.startsWith(p)) || CLOUD_CRED_NAMES.has(k)) env[k] = v;
  }
  return env;
}

export const TerraformPlanParams = type({});

export function TerraformPlanTool(ctx: ToolContext) {
  return tool({
    name: "terraform_plan",
    description:
      "Run `terraform plan` and report the planned change summary (resources to add / change / destroy) " +
      "plus any resource that would be DESTROYED or REPLACED. Opt-in and degrades green — it auto-skips " +
      "(returns `ran: false`, never fails the run) when no cloud credentials are detected, terraform is " +
      "not installed, or init/plan can't complete (plan needs live provider/backend access). Call it after " +
      "a fix to attach the real-world effect to the PR and surface destructive changes for human review.",
    parameters: TerraformPlanParams,
    execute: execute(async () => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      if (!hasCloudCredentials()) {
        return {
          ran: false,
          skipped_reason:
            "no cloud credentials detected — terraform plan needs provider/backend access; skipped (add AWS/Azure/GCP creds or an OIDC role to enable it)",
        };
      }
      const creds = collectCloudCredentials();
      const init = run("terraform", ["init", "-input=false", "-no-color"], cwd, creds);
      if (init.missing) return { ran: false, skipped_reason: "terraform not installed" };
      if (init.status !== 0) {
        return {
          ran: false,
          skipped_reason: `terraform init failed — plan skipped: ${init.stderr.trim().slice(0, 300) || "unknown error"}`,
        };
      }
      const plan = run(
        "terraform",
        ["plan", "-input=false", "-no-color", "-lock=false", "-json"],
        cwd,
        creds
      );
      if (plan.status !== 0) {
        return {
          ran: false,
          skipped_reason: `terraform plan failed — skipped: ${plan.stderr.trim().slice(0, 300) || "unknown error"}`,
        };
      }
      const summary = parseTerraformPlanJson(plan.stdout);
      log.info(
        `» terraform_plan: +${summary.add} ~${summary.change} -${summary.destroy}` +
          (summary.hasDestroyOrReplace ? ` (DESTRUCTIVE: ${summary.destructive.length})` : "")
      );
      return {
        ran: true,
        to_add: summary.add,
        to_change: summary.change,
        to_destroy: summary.destroy,
        has_destroy_or_replace: summary.hasDestroyOrReplace,
        destructive: summary.destructive,
      };
    }),
  });
}

export const ReadFindingsParams = type({
  "path?": type.string.describe(
    "path to the Assessor's findings.json. Defaults to $TERRAMEND_FINDINGS_PATH, then ./findings.json in the workspace."
  ),
  "severity_threshold?": type("'critical' | 'high' | 'medium' | 'low' | 'info'").describe(
    "minimum severity to report (default: the run's configured threshold, else low)."
  ),
});

export function ReadFindingsTool(ctx: ToolContext) {
  return tool({
    name: "read_findings",
    description:
      "Load best-practice concerns from a terraform-reviewer (Assessor) findings.json INSTEAD of running " +
      "the scanners. Returns the SAME { concerns, groups, summary } shape as terraform_scan, so Remediate " +
      "consumes it identically. `human_only` findings and non-Terraform files are dropped. Concerns from " +
      "checkov / tflint / terraform-fmt re-verify deterministically (✗→✓); findings exclusive to the reviewer " +
      "(tfsec / infracost / llm) carry source `reviewer` and can't be reproduced by Terramend's scanners, so " +
      "terraform_verify_remediation will report them unresolved — rely on terraform_validate + your explanation " +
      "for those. Returns `found: false` (never an error) when no findings.json is present.",
    parameters: ReadFindingsParams,
    execute: execute(async ({ path, severity_threshold }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const findingsPath = path || process.env.TERRAMEND_FINDINGS_PATH || join(cwd, "findings.json");
      let raw: string;
      try {
        raw = readFileSync(findingsPath, "utf8");
      } catch {
        return {
          found: false,
          reason: `no findings.json at ${findingsPath} (set the path arg or $TERRAMEND_FINDINGS_PATH)`,
          concerns: [],
          groups: [],
        };
      }
      let parsed: Concern[];
      try {
        parsed = parseReviewerFindings(raw, cwd);
      } catch {
        return { found: false, reason: `could not parse findings.json at ${findingsPath}`, concerns: [], groups: [] };
      }

      const configured = ctx.payload.severityThreshold as Severity | undefined;
      const threshold: Severity = severity_threshold ?? configured ?? "low";
      const minRank = SEVERITY_RANK[threshold];

      const all = sortConcerns(dedupe(parsed))
        .filter(isTerraformConcern)
        .filter((c) => SEVERITY_RANK[c.severity] >= minRank);
      const groups = groupConcerns(all);
      const by_severity: Record<string, number> = {};
      for (const c of all) by_severity[c.severity] = (by_severity[c.severity] ?? 0) + 1;

      log.info(`» read_findings: ${all.length} concern(s) ≥ ${threshold} from ${findingsPath}`);

      return {
        found: true,
        source_file: findingsPath,
        summary: { total: all.length, groups: groups.length, by_severity },
        groups,
        concerns: all,
      };
    }),
  });
}
