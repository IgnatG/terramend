import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "#app/mcp/server";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";
import { $ } from "#app/utils/shell";

/**
 * Terraform-write guardrails — hard, code-level limits that back the prompt
 * rules of the modes that write Terraform and open PRs (**Remediate** and
 * **GenerateTerraform**). They only engage for those modes, so every other mode
 * (Build, Fix, Review, …) is completely unaffected.
 */

export const REMEDIATE_MODE = "Remediate";
export const GENERATE_MODE = "GenerateTerraform";

/** default paths these modes may modify/create: Terraform sources only. */
export const DEFAULT_ALLOWED_PATHS = ["**/*.tf", "**/*.tfvars"] as const;

/** §28 — extra paths the Terratest scaffold writes, allowed only when the
 * `terratest` input is enabled (Go test files + native `*.tftest.hcl` tests fall
 * outside the Terraform-only default). */
export const TERRATEST_ALLOWED_PATHS = [
  "**/*_test.go",
  "**/*.tftest.hcl",
  "test/**",
  "tests/**",
  "go.mod",
  "go.sum",
] as const;

/** modes whose pushes/PRs are bounded by these guardrails. */
const GUARDED_MODES: ReadonlySet<string> = new Set([REMEDIATE_MODE, GENERATE_MODE]);

function isGuardedMode(ctx: ToolContext): boolean {
  return ctx.toolState.selectedMode !== undefined && GUARDED_MODES.has(ctx.toolState.selectedMode);
}

export function resolveAllowedPaths(ctx: ToolContext): string[] {
  const configured = ctx.payload.allowedPaths;
  const base = configured && configured.length > 0 ? [...configured] : [...DEFAULT_ALLOWED_PATHS];
  // §28 — when Terratest scaffolding is opted in, also permit the Go test +
  // example-fixture paths the scaffold writes (they're outside the .tf default).
  if (ctx.payload.terratest) base.push(...TERRATEST_ALLOWED_PATHS);
  return base;
}

/**
 * Compile a glob to an anchored RegExp. Supports `**` (any path segments,
 * including the `**\/` "zero or more leading dirs" idiom), `*` (within a
 * segment), and `?`. Sufficient for the path allow-list patterns
 * (`**\/*.tf`, `modules/**`, `*.tfvars`).
 */
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isPathAllowed(path: string, globs: string[]): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegex(g).test(normalized));
}

/** the run-entry commit sha, used as the baseline for "what this run changed". */
function runStartSha(ctx: ToolContext): string | null {
  const head = ctx.toolState.initialHead;
  if (!head) return null;
  try {
    const ref = head.kind === "branch" ? head.name : head.sha;
    return $("git", ["rev-parse", ref], { log: false });
  } catch {
    return null;
  }
}

/** files changed on the current branch since the run started. */
function changedFilesSinceRunStart(ctx: ToolContext): string[] {
  const base = runStartSha(ctx);
  if (!base) return [];
  // `$` returns trimmed stdout on success and throws on a non-zero exit (no
  // onError handler) — so a genuine git failure here propagates and the caller
  // fails closed (the push is refused) rather than treating an errored diff as
  // "nothing changed". `git diff --name-only` exits 0 on a clean diff.
  const out = $("git", ["diff", "--name-only", base, "HEAD"], { log: false });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Enforce the path allow-list before a Remediate-mode push. Throws if the
 * branch changed any file outside the allowed globs — the choke point is
 * push_branch, the only way changes reach a PR. Fails closed: if the baseline
 * can't be established it refuses rather than letting an unbounded change
 * through.
 */
export function enforceRemediationPaths(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;

  const base = runStartSha(ctx);
  if (!base) {
    throw new Error(
      "push blocked (Terraform-only guardrail): could not establish the run-start commit to verify the change is limited to Terraform files. " +
        "Ensure the run started from a clean checkout.",
    );
  }

  const allowed = resolveAllowedPaths(ctx);
  const changed = changedFilesSinceRunStart(ctx);
  const violations = changed.filter((f) => !isPathAllowed(f, allowed));
  if (violations.length > 0) {
    throw new Error(
      `push blocked (Terraform-only guardrail): this run changed files outside the allowed paths [${allowed.join(", ")}]. ` +
        `This mode must only touch Terraform files. Revert these and keep the change to Terraform only:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    );
  }
  log.info(
    `» Terraform-only path guardrail ok (${changed.length} file(s), all within [${allowed.join(", ")}])`,
  );
}

// --- §2.7 protected-resource allowlist -------------------------------------

/** glob patterns marking files the fixer must NEVER auto-modify (prod state,
 * data stores, anything sensitive). The inverse of `allowed_paths`. */
export function resolveProtectedPaths(ctx: ToolContext): string[] {
  return ctx.payload.protectedPaths ?? [];
}

/**
 * Block a push that touched any file matching `protected_paths`. This is the
 * inverse of the allow-list: a changed file matching a protected glob fails the
 * push, even though it's a `.tf`/`.tfvars` the allow-list would otherwise permit.
 * No-op when `protected_paths` is unset or outside a guarded mode. Fails closed:
 * if the run-start baseline can't be established it refuses, same as
 * `enforceRemediationPaths`.
 */
export function enforceProtectedPaths(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  const protectedGlobs = resolveProtectedPaths(ctx);
  if (protectedGlobs.length === 0) return;

  const base = runStartSha(ctx);
  if (!base) {
    throw new Error(
      "push blocked (protected-paths guardrail): could not establish the run-start commit to verify no protected path was modified. " +
        "Ensure the run started from a clean checkout.",
    );
  }

  const changed = changedFilesSinceRunStart(ctx);
  const violations = changed.filter((f) => isPathAllowed(f, protectedGlobs));
  if (violations.length > 0) {
    throw new Error(
      `push blocked (protected-paths guardrail): this run modified files matching the protected_paths globs [${protectedGlobs.join(", ")}], ` +
        `which are marked never-auto-modify. Revert these and leave them for a human:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    );
  }
  log.info(`» protected-paths guardrail ok (no change matched [${protectedGlobs.join(", ")}])`);
}

// --- §2.8 secrets-safe diff scan -------------------------------------------

export interface SecretHit {
  file: string;
  line: number;
  rule: string;
}

/**
 * High-signal secret detectors applied to lines a fix ADDED. Kept deliberately
 * narrow (low false-positive) — the goal is to stop a "fix" that hardcodes a
 * literal credential (e.g. resolving a "use a variable" finding by pasting the
 * secret), not to be a general-purpose scanner. Each entry is [rule, regex].
 */
const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["aws-access-key-id", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/],
  ["pem-private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["gcp-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["github-token", /\bgh[pousr]_[0-9A-Za-z]{36,}\b/],
  ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ["private-key-pem-block", /-----BEGIN PRIVATE KEY-----/],
];

// an HCL/tfvars assignment of a STRING LITERAL to a secret-named attribute, e.g.
// `password = "hunter2"` or `secret_access_key = "AKIA..."`. Excludes references
// (`= var.x`, `= "${...}"`, `= local.y`) and empty strings — only a real inlined
// literal trips it.
const SENSITIVE_ASSIGNMENT =
  /\b(?:password|passwd|secret|secret_key|secret_access_key|access_key|api_key|apikey|auth_token|access_token|private_key|client_secret|credential|connection_string)\b\s*[=:]\s*"([^"$][^"]*)"/i;

/**
 * Scan a unified `git diff` for inlined secrets on ADDED lines only. Tracks the
 * current file from `+++ b/<path>` headers and the new-side line number from
 * `@@` hunk headers, so each hit carries an accurate `file:line`. Pure — the
 * guardrail feeds it `git diff` output. Removed/context lines are ignored (a
 * secret already in the base isn't this run's doing).
 */
export function scanDiffForSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = "(unknown)";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim().replace(/^b\//, "");
      file = path === "/dev/null" ? "(deleted)" : path;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("index "))
      continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      const content = raw.slice(1);
      for (const [rule, re] of SECRET_VALUE_PATTERNS) {
        if (re.test(content)) hits.push({ file, line: newLine, rule });
      }
      if (SENSITIVE_ASSIGNMENT.test(content)) {
        hits.push({ file, line: newLine, rule: "hardcoded-secret-assignment" });
      }
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line — does not advance the new-side counter
    } else {
      // context line (leading space) or blank — advances the new-side counter
      newLine++;
    }
  }
  return hits;
}

/**
 * Parse a `gitleaks detect --report-format json` report (an array of finding
 * objects) into the shared `SecretHit` shape. Pure, so it's unit-testable
 * without the binary. `gitleaks:` prefixes the rule so a hit's engine is
 * obvious next to the built-in detectors. Tolerates an empty / non-array report.
 */
export function parseGitleaksReport(json: string): SecretHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hits: SecretHit[] = [];
  for (const f of parsed as Array<Record<string, unknown>>) {
    const file = typeof f.File === "string" && f.File ? f.File : "(unknown)";
    const line = typeof f.StartLine === "number" ? f.StartLine : 0;
    const rule = typeof f.RuleID === "string" && f.RuleID ? f.RuleID : "secret";
    hits.push({ file, line, rule: `gitleaks:${rule}` });
  }
  return hits;
}

/**
 * Optional deeper secret scan via the external `gitleaks` binary, opt-in through
 * the `gitleaks` action input. Best-effort: returns `null` when gitleaks isn't
 * installed or can't run (the built-in scanner already provides the fail-closed
 * baseline, so an absent gitleaks degrades to "built-in only" rather than
 * failing the push). Scans the commits this run added (`<base>..HEAD`) and uses
 * `--exit-code 0` so a leak doesn't make the process exit non-zero — we read the
 * JSON report instead. Restricted env, so no secret leaks into the subprocess.
 */
function scanWithGitleaks(ctx: ToolContext, base: string): SecretHit[] | null {
  const reportPath = join(ctx.tmpdir, `gitleaks-report-${process.pid}.json`);
  const cwd = ctx.payload.cwd ?? process.cwd();
  const result = spawnSync(
    "gitleaks",
    [
      "detect",
      "--source",
      ".",
      "--log-opts",
      `${base}..HEAD`,
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      "--exit-code",
      "0",
      "--no-banner",
      "--redact",
    ],
    {
      cwd,
      encoding: "utf-8",
      env: resolveEnv("restricted") as NodeJS.ProcessEnv,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    log.warning(
      missing
        ? "» gitleaks requested but not installed — falling back to the built-in secret scanner only"
        : `» gitleaks could not run (${result.error.message}) — built-in secret scanner still enforced`,
    );
    return null;
  }
  try {
    const report = readFileSync(reportPath, "utf8");
    return parseGitleaksReport(report);
  } catch {
    // no report file written usually means a clean scan; treat as no hits.
    return [];
  } finally {
    try {
      rmSync(reportPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Block a push whose diff (since run start) inlines a secret. Reuses the same
 * run-start baseline as the path guardrail. No-op outside a guarded mode. Fails
 * closed on a missing baseline. The diff is read with `$` (restricted env), so
 * no secret leaks into the subprocess.
 *
 * The built-in detectors always run (the deterministic, fail-closed baseline).
 * When the operator opts in via the `gitleaks` input, gitleaks ALSO runs for
 * deeper coverage and its hits are merged — but its absence never weakens the
 * baseline (see scanWithGitleaks).
 */
export function assertNoSecretsInDiff(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  const base = runStartSha(ctx);
  if (!base) {
    throw new Error(
      "push blocked (secret-scan guardrail): could not establish the run-start commit to scan the diff for inlined secrets. " +
        "Ensure the run started from a clean checkout.",
    );
  }
  const diff = $("git", ["diff", base, "HEAD"], { log: false });
  const hits = scanDiffForSecrets(diff);

  // optional deeper engine — merged on top of the built-in baseline.
  if (ctx.payload.gitleaks) {
    const gitleaksHits = scanWithGitleaks(ctx, base);
    if (gitleaksHits) hits.push(...gitleaksHits);
  }

  if (hits.length > 0) {
    throw new Error(
      `push blocked (secret-scan guardrail): the change appears to inline ${hits.length} secret(s) — a fix must reference a variable/secret store, never paste a literal. ` +
        `Remove or parameterise these and re-push:\n` +
        hits.map((h) => `  - ${h.file}:${h.line} (${h.rule})`).join("\n"),
    );
  }
  log.info(
    `» secret-scan guardrail ok (no inlined secrets in the diff${ctx.payload.gitleaks ? ", built-in + gitleaks" : ""})`,
  );
}

/** resource addresses the operator has explicitly allowed to be destroyed/replaced. */
export function resolveAllowReplace(ctx: ToolContext): string[] {
  return ctx.payload.allowReplace ?? [];
}

function isReplaceAllowed(address: string, allowList: string[]): boolean {
  return allowList.some(
    (a) => a === "*" || a === "all" || a === address || globToRegex(a).test(address),
  );
}

/**
 * Block a push that `terraform_plan` showed would DELETE or REPLACE a stateful
 * (data-bearing) resource — RDS, S3, EBS, a SQL database, etc. A best-practice
 * remediation should never destroy data; if the replacement is genuinely
 * intended the operator opts in per-resource via the `allow_replace` input
 * (an address, a glob, or `*`/`all`). No-op outside guarded modes. When no plan
 * ran (no cloud credentials — `terraform_plan` degraded green), there is no
 * evidence to act on and nothing is blocked: this gate engages only on what the
 * plan actually reported, so it strengthens the run when creds are wired and is
 * silent otherwise.
 */
export function assertNoBlockedDestroy(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  const planned = ctx.toolState.plannedDestroy;
  if (!planned || planned.stateful.length === 0) return;

  const allow = resolveAllowReplace(ctx);
  const blocked = planned.stateful.filter((r) => !isReplaceAllowed(r.address, allow));
  if (blocked.length === 0) {
    log.info(
      `» destroy-block guardrail ok (${planned.stateful.length} stateful destroy/replace allowed via allow_replace)`,
    );
    return;
  }
  throw new Error(
    `push blocked (Terraform-only guardrail): terraform plan shows this change would DESTROY or REPLACE ` +
      `${blocked.length} stateful resource(s), which would likely cause data loss — a best-practice ` +
      `remediation should not. Abandon this change, or, ONLY if the replacement is genuinely intended, ` +
      `set the \`allow_replace\` input to include the resource address(es):\n` +
      blocked.map((r) => `  - ${r.address} (${r.action}, ${r.type})`).join("\n"),
  );
}

/** maximum remediation PRs a single run may open (default 1). */
export function resolveMaxPrs(ctx: ToolContext): number {
  return ctx.payload.maxPrs ?? 1;
}

/**
 * Enforce the per-run PR cap before opening a remediation PR. Throws when the
 * cap is already reached so the agent stops at the configured number of scoped
 * PRs instead of fanning out.
 */
export function assertUnderPrCap(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  const cap = resolveMaxPrs(ctx);
  const opened = ctx.toolState.remediationPrsOpened ?? 0;
  if (opened >= cap) {
    throw new Error(
      `PR limit reached (Terraform-only guardrail): this run is configured to open at most ${cap} PR(s) and has already opened ${opened}. ` +
        `Stop here and report the remaining work for a future run.`,
    );
  }
}

/** record that a guarded-mode PR was opened (after create_pull_request succeeds). */
export function recordRemediationPrOpened(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  ctx.toolState.remediationPrsOpened = (ctx.toolState.remediationPrsOpened ?? 0) + 1;
}
