import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { discoverTerraformRoots } from "#app/mcp/roots";
import { toolSkip } from "#app/mcp/shared";
import { resolveEnv } from "#app/utils/secrets";

/**
 * A degrade-green skip result carrying the structured §3.5 envelope
 * (`ok: false` + machine `code` + human `detail`) PLUS the legacy alias the tool
 * returned before it converged on the envelope — `ran`/`found` and
 * `skipped_reason`/`reason` — so existing prompt + test contracts keep working.
 * Additive, never breaking. `extra` folds in any tool-specific fields (e.g.
 * read_findings' empty `concerns`/`groups`).
 */
export function skipResult(
  code: string,
  detail: string,
  opts: {
    key?: "ran" | "found";
    reasonKey?: "skipped_reason" | "reason";
    extra?: Record<string, any>;
  } = {},
): Record<string, any> {
  const key = opts.key ?? "ran";
  const reasonKey = opts.reasonKey ?? "skipped_reason";
  return { ...toolSkip(code, detail), [key]: false, [reasonKey]: detail, ...(opts.extra ?? {}) };
}

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

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function concernId(
  source: string,
  ruleId: string,
  file: string,
  line: number | null,
): string {
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
export function toRepoRelative(raw: string | undefined, cwd: string): string {
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

export type RunResult = { status: number; stdout: string; stderr: string; missing: boolean };

/**
 * Hard wall-clock cap on any single scanner/terraform invocation. Bounds a hung
 * subprocess (e.g. `terraform init`/`plan` stalling on a private registry, a
 * tflint plugin fetch that never returns) so it can't block the run forever.
 * Generous (5 min) so it only ever fires on a genuine hang, never a slow-but-
 * progressing plan. A timeout surfaces as a non-zero/`-1` status the caller
 * already treats as "this scanner did not produce results".
 */
export const SUBPROCESS_TIMEOUT_MS = 300_000;

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
export function run(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv?: Record<string, string>,
): RunResult {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    // restricted env: keeps PATH/HOME, strips secrets so a scanner (or a tflint
    // plugin) can't exfiltrate credentials. `extraEnv` re-admits only the named vars.
    env: resolveEnv(extraEnv ?? "restricted") as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: SUBPROCESS_TIMEOUT_MS,
  });
  if (result.error) {
    // ENOENT = binary absent (degrade to "skipped"); a timeout (ETIMEDOUT, or a
    // SIGTERM kill on timeout) is a real failure surfaced as status -1, which the
    // scanner callers already treat as "no results from this tool".
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

export type ScannerOutcome = {
  source: Concern["source"];
  ran: boolean;
  skipped_reason?: string;
  concerns: Concern[];
  /**
   * For `terraform validate` only: count of roots where terraform RAN but its
   * `-json` output could not be parsed (a real CLI-level failure, not a missing
   * binary). Lets the validate tool report `passed` as fail-closed instead of
   * silently treating an un-validated root as clean. Undefined/0 elsewhere.
   */
  unvalidated?: number;
};

export function skipped(source: Concern["source"], reason: string): ScannerOutcome {
  return { source, ran: false, skipped_reason: reason, concerns: [] };
}

export interface ResolvedRoot {
  /** absolute dir the per-root command (init/plan/validate) runs in. */
  absDir: string;
  /** that root's path relative to the scan `cwd` ("" when the root IS cwd) —
   * prepended to per-root concern files so they stay cwd-relative. */
  relDir: string;
}

/**
 * The Terraform root modules to operate on under `cwd`. A repo can hold several
 * roots (hepcare: `terraform/` + `terraform/core/`); `terraform validate` /
 * `plan` are per-root, so they must run in EACH. Falls back to `cwd` itself as a
 * single root when none is detected — so a normal single-root repo behaves
 * exactly as before (no rebasing, one iteration).
 */
export function resolveRoots(cwd: string): ResolvedRoot[] {
  const discovered = discoverTerraformRoots(cwd);
  if (discovered.length === 0) return [{ absDir: cwd, relDir: "" }];
  return discovered.map((r) => ({ absDir: r.dir ? join(cwd, r.dir) : cwd, relDir: r.dir }));
}

/**
 * Re-base a concern produced by a per-root command (its file is relative to the
 * root dir) onto the scan `cwd` by prefixing the root's `relDir`, and recompute
 * the content id so it stays consistent with the cwd-relative scanners (✗→✓).
 * A no-op when `relDir` is "" (the root IS cwd).
 */
export function rebaseConcern(c: Concern, relDir: string): Concern {
  if (!relDir) return c;
  const file = `${relDir}/${c.location.file}`.replace(/\/+/g, "/");
  const prefix = `${c.source}:`;
  const bareRule = c.rule_id.startsWith(prefix) ? c.rule_id.slice(prefix.length) : c.rule_id;
  return {
    ...c,
    location: { ...c.location, file },
    id: concernId(c.source, bareRule, file, c.location.line),
  };
}

/** true when a path is a Terraform source file Terramend may remediate. */
export function isTerraformFile(file: string): boolean {
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

export function dedupe(concerns: Concern[]): Concern[] {
  const seen = new Set<string>();
  const out: Concern[] = [];
  for (const c of concerns) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

export function sortConcerns(concerns: Concern[]): Concern[] {
  return [...concerns].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    return a.id.localeCompare(b.id);
  });
}

export function lowerSeverity(s: string | undefined): Severity {
  const v = (s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "medium";
}

/** the repo's base ref for diff-scope, or null when one can't be determined. */
export function resolveBaseRef(cwd: string): string | null {
  const head = run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], cwd);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master"]) {
    const verify = run("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
    if (verify.status === 0 && verify.stdout.trim()) return ref;
  }
  return null;
}

/**
 * A scoped unit of work = all concerns in one file. Different scanners flag the
 * same underlying defect under different rule ids (trivy ∩ checkov overlap
 * heavily on e.g. S3 buckets), so per-concern PRs would spam many PRs for one
 * bad file. Remediate acts on ONE group per PR (branch `remediate/<group.id>`),
 * fixing every concern in the file together and proving them all cleared (✗→✓).
 */
export interface ConcernGroup {
  /** stable id — the remediation branch/PR key (`remediate/<id>`). Derived from
   * the file (by-file grouping) or the rule (by-rule grouping). */
  id: string;
  /** the group's primary file (by-file) or a human label like "3 files"
   * (by-rule); `files` carries the full list for by-rule groups. */
  file: string;
  /** §3.11 — every file the group spans. one entry for a by-file group; the
   * full set for a by-rule group (the agent must fix the rule in all of them). */
  files?: string[];
  /** how the group was formed — `file` (default) or `rule` (§3.11). */
  grouping?: "file" | "rule";
  /** highest severity among the group's concerns. */
  severity: Severity;
  concern_count: number;
  /** distinct rule ids in the group, for the PR body. */
  rule_ids: string[];
  /** the concern ids the re-scan must confirm are gone to call this ✓. */
  concern_ids: string[];
  /** §3.9 — `auto` (open a normal PR) or `needs-human` (escalate). attached by
   * the scan tool from the group's concerns, not by `groupConcerns` (which has
   * no autonomy threshold). undefined until the scan tool annotates it. */
  autonomy?: Autonomy;
  /** §3.9 — why the group was escalated (empty/absent for `auto`). */
  autonomy_reasons?: string[];
}

export type Autonomy = "auto" | "needs-human";

export type BlastTier = "low" | "medium" | "high";
