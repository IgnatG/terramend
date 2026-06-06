import { $ } from "#app/utils/shell";
import { log } from "#app/utils/cli";
import type { ToolContext } from "#app/mcp/server";

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

/** modes whose pushes/PRs are bounded by these guardrails. */
const GUARDED_MODES: ReadonlySet<string> = new Set([REMEDIATE_MODE, GENERATE_MODE]);

function isGuardedMode(ctx: ToolContext): boolean {
  return ctx.toolState.selectedMode !== undefined && GUARDED_MODES.has(ctx.toolState.selectedMode);
}

export function resolveAllowedPaths(ctx: ToolContext): string[] {
  const configured = ctx.payload.allowedPaths;
  return configured && configured.length > 0 ? configured : [...DEFAULT_ALLOWED_PATHS];
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
    const c = glob[i];
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
  let out = "";
  $("git", ["diff", "--name-only", base, "HEAD"], {
    log: false,
    onError: (r) => {
      out = r.stdout;
    },
  });
  if (!out) out = $("git", ["diff", "--name-only", base, "HEAD"], { log: false });
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
        "Ensure the run started from a clean checkout."
    );
  }

  const allowed = resolveAllowedPaths(ctx);
  const changed = changedFilesSinceRunStart(ctx);
  const violations = changed.filter((f) => !isPathAllowed(f, allowed));
  if (violations.length > 0) {
    throw new Error(
      `push blocked (Terraform-only guardrail): this run changed files outside the allowed paths [${allowed.join(", ")}]. ` +
        `This mode must only touch Terraform files. Revert these and keep the change to Terraform only:\n` +
        violations.map((v) => `  - ${v}`).join("\n")
    );
  }
  log.info(`» Terraform-only path guardrail ok (${changed.length} file(s), all within [${allowed.join(", ")}])`);
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
        `Stop here and report the remaining work for a future run.`
    );
  }
}

/** record that a guarded-mode PR was opened (after create_pull_request succeeds). */
export function recordRemediationPrOpened(ctx: ToolContext): void {
  if (!isGuardedMode(ctx)) return;
  ctx.toolState.remediationPrsOpened = (ctx.toolState.remediationPrsOpened ?? 0) + 1;
}
