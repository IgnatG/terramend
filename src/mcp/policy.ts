import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type } from "arktype";
import { log } from "#app/utils/cli";
import { resolveEnv } from "#app/utils/secrets";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool, toolOk, toolSkip } from "#app/mcp/shared";

/**
 * Policy-as-code gate (§3.5 OPA/Conftest). An optional, opt-in tool that runs
 * the operator's own Rego policies against the Terraform plan JSON (or the HCL),
 * so an org's policy-as-code can gate a remediation/generation the same way the
 * deterministic scanners do — pairs with §21 (prevent recurrence). Terramend is
 * an ORCHESTRATOR here, never a redistributor: it invokes the external
 * `conftest` (OPA) binary as a separate process and consumes its normalized
 * output. Degrades green — when conftest isn't installed or no policy dir
 * exists, it returns `ok: false` with a `code` and never fails the run.
 *
 * The parsing is pure + unit-tested; the tool just shells out and parses.
 */

export interface PolicyFailure {
  /** the policy rule message (the human-readable violation). */
  msg: string;
  /** the file conftest evaluated (repo-relative when conftest reported it). */
  file: string;
  /** "failure" (a deny) or "warning" (a warn). */
  level: "failure" | "warning";
}

export interface PolicyResult {
  /** true when there were zero failures (warnings don't fail the gate). */
  passed: boolean;
  failures: PolicyFailure[];
  warnings: PolicyFailure[];
  /** total tests conftest ran (across files), for a confidence signal. */
  tested: number;
}

interface ConftestResultEntry {
  filename?: string;
  namespace?: string;
  successes?: number;
  failures?: { msg?: string }[];
  warnings?: { msg?: string }[];
}

/**
 * Parse `conftest test --output json` output into a normalized PolicyResult.
 * Conftest emits an array of per-file result objects, each with `failures` /
 * `warnings` / `successes`. Pure; tolerant of malformed/empty input (returns a
 * clean pass). A non-empty `failures` anywhere means the gate did NOT pass;
 * warnings are surfaced but don't fail it.
 */
export function parseConftestOutput(stdout: string): PolicyResult {
  let parsed: ConftestResultEntry[];
  try {
    const raw = JSON.parse(stdout || "[]");
    parsed = Array.isArray(raw) ? raw : [];
  } catch {
    return { passed: true, failures: [], warnings: [], tested: 0 };
  }
  const failures: PolicyFailure[] = [];
  const warnings: PolicyFailure[] = [];
  let tested = 0;
  for (const entry of parsed) {
    const file = entry.filename || "(plan)";
    const fails = entry.failures ?? [];
    const warns = entry.warnings ?? [];
    tested += (entry.successes ?? 0) + fails.length + warns.length;
    for (const f of fails) failures.push({ msg: f.msg || "policy violation", file, level: "failure" });
    for (const w of warns) warnings.push({ msg: w.msg || "policy warning", file, level: "warning" });
  }
  return { passed: failures.length === 0, failures, warnings, tested };
}

/** the default dirs a repo keeps Rego policies in (checked in order). */
const DEFAULT_POLICY_DIRS = ["policy", "policies", ".conftest"];

/** resolve the policy dir to use: the explicit arg, else the first default dir
 * that exists. Returns null when none is found. */
function resolvePolicyDir(cwd: string, explicit: string | undefined): string | null {
  if (explicit) {
    const abs = isAbsolute(explicit) ? explicit : join(cwd, explicit);
    return existsSync(abs) ? abs : null;
  }
  for (const d of DEFAULT_POLICY_DIRS) {
    const abs = join(cwd, d);
    if (existsSync(abs)) return abs;
  }
  return null;
}

export const PolicyCheckParams = type({
  "target?": type.string.describe(
    "the file conftest evaluates — a terraform plan JSON (preferred; produce it with `terraform show -json plan.tfplan`) or an HCL file. Default: ./plan.json, then ./tfplan.json, in the workspace."
  ),
  "policy_dir?": type.string.describe(
    "dir holding the Rego policies. Default: the first of ./policy, ./policies, ./.conftest that exists."
  ),
});

export function PolicyCheckTool(ctx: ToolContext) {
  return tool({
    name: "policy_check",
    description:
      "Run the repo's own policy-as-code (Rego) against the Terraform plan/HCL via the external `conftest` " +
      "(OPA) binary, so org policy can gate a fix (§3.5). Opt-in and degrades green — returns `ok: false` " +
      "(never fails the run) when conftest isn't installed or no policy dir is present. On success returns " +
      "`passed` (false when any policy DENY fired), the `failures` and `warnings` (each with msg + file), and " +
      "the count `tested`. When `passed` is false, treat it like a failed validate: fix the violation or " +
      "label the PR needs-human — do NOT push past a policy denial.",
    parameters: PolicyCheckParams,
    execute: execute(async ({ target, policy_dir }) => {
      const cwd = ctx.payload.cwd ?? process.cwd();
      const policyDir = resolvePolicyDir(cwd, policy_dir);
      if (!policyDir) {
        return toolSkip(
          "no_policy_dir",
          "no Rego policy dir found (looked for ./policy, ./policies, ./.conftest, or the policy_dir arg) — policy_check is opt-in"
        );
      }
      // resolve the target file: explicit arg, else a conventional plan JSON.
      let targetFile: string | null = null;
      if (target) {
        const abs = isAbsolute(target) ? target : join(cwd, target);
        targetFile = existsSync(abs) ? abs : null;
        if (!targetFile) {
          return toolSkip("target_not_found", `policy target '${target}' not found in the workspace`);
        }
      } else {
        for (const candidate of ["plan.json", "tfplan.json"]) {
          const abs = join(cwd, candidate);
          if (existsSync(abs)) {
            targetFile = abs;
            break;
          }
        }
        if (!targetFile) {
          return toolSkip(
            "no_target",
            "no plan JSON to evaluate — produce one with `terraform show -json plan.tfplan > plan.json`, or pass `target`"
          );
        }
      }
      const r = spawnSync("conftest", ["test", "--output", "json", "-p", policyDir, targetFile], {
        cwd,
        encoding: "utf-8",
        env: resolveEnv("restricted") as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
        return toolSkip(
          "conftest_not_installed",
          "conftest (OPA) is not installed — policy_check is opt-in and best-effort; install conftest to enable it"
        );
      }
      // conftest exits non-zero when a policy DENY fires — that's a normal
      // denial (JSON on stdout), not a tool error. But it ALSO exits non-zero
      // when it couldn't evaluate at all (bad policy, parse error, no tests) —
      // there it emits nothing parseable. Distinguish: a non-zero exit that
      // yielded no evaluated tests AND no failures/warnings is a real error, so
      // report it as a skip rather than a false PASS. A genuine denial has
      // failures > 0 and flows through to `passed: false`.
      const result = parseConftestOutput(r.stdout);
      const evaluated =
        result.tested > 0 || result.failures.length > 0 || result.warnings.length > 0;
      if (r.status !== 0 && !evaluated) {
        return toolSkip(
          "conftest_failed",
          `conftest could not evaluate the target: ${r.stderr.trim().slice(0, 300) || "unknown error"}`
        );
      }
      log.info(
        `» policy_check: ${result.passed ? "PASS" : "FAIL"} — ${result.failures.length} failure(s), ${result.warnings.length} warning(s) over ${result.tested} test(s)`
      );
      return toolOk({
        passed: result.passed,
        policy_dir: policyDir,
        target: targetFile,
        failure_count: result.failures.length,
        warning_count: result.warnings.length,
        failures: result.failures,
        warnings: result.warnings,
        tested: result.tested,
      });
    }),
  });
}
