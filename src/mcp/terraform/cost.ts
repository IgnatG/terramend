import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type RunResult, resolveBaseRef, run } from "#app/mcp/terraform/types";

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

export interface ResourceCost {
  name: string;
  monthlyCost: number;
}

/**
 * Parse the per-resource monthly costs from `infracost breakdown --format json`
 * (`projects[].breakdown.resources[]`), so a cost increase can be attributed to
 * the specific resources that drove it instead of just a total. Skips unpriced
 * (null/zero) resources; returns them sorted most-expensive first. Pure.
 */
export function parseInfracostResources(stdout: string): ResourceCost[] {
  let parsed: {
    projects?: {
      breakdown?: { resources?: { name?: string; monthlyCost?: string | number | null }[] };
    }[];
  };
  try {
    parsed = JSON.parse(stdout || "{}");
  } catch {
    return [];
  }
  const out: ResourceCost[] = [];
  for (const project of parsed.projects ?? []) {
    for (const r of project.breakdown?.resources ?? []) {
      const raw = r.monthlyCost;
      const cost =
        typeof raw === "number" ? raw : raw != null ? Number.parseFloat(raw) : Number.NaN;
      if (Number.isFinite(cost) && cost > 0 && r.name) {
        out.push({ name: r.name, monthlyCost: Math.round(cost * 100) / 100 });
      }
    }
  }
  return out.sort((a, b) => b.monthlyCost - a.monthlyCost);
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
export function computeCostDelta(
  baseline: CostBreakdown | null,
  current: CostBreakdown,
): CostDelta {
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

export interface CostEscalation {
  /** true when the monthly increase meets/exceeds the operator's threshold. */
  escalate: boolean;
  reason?: string;
}

/**
 * §4.16-next — decide whether a cost increase is large enough to escalate the PR
 * to human review (`needs-human`). Compares the monthly delta against the
 * operator's `cost_increase_block_usd` threshold. No threshold set, an unknown
 * delta, or a decrease/no-change ⇒ no escalation. Pure + deterministic so the
 * decision is auditable, not a model judgement.
 */
export function classifyCostEscalation(
  deltaMonthly: number | null,
  thresholdUsd: number | undefined,
): CostEscalation {
  if (thresholdUsd === undefined || deltaMonthly === null || deltaMonthly <= 0) {
    return { escalate: false };
  }
  if (deltaMonthly >= thresholdUsd) {
    return {
      escalate: true,
      reason: `the fix raises monthly cost by ${deltaMonthly}, at or above the ${thresholdUsd} escalation threshold`,
    };
  }
  return { escalate: false };
}

export function runInfracostBreakdown(scanCwd: string, key: string): RunResult {
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
export function infracostBaseline(cwd: string, key: string, tmpdir: string): CostBreakdown | null {
  const baseRef = resolveBaseRef(cwd);
  if (!baseRef) return null;
  const prefixResult = run("git", ["rev-parse", "--show-prefix"], cwd);
  const prefix = prefixResult.status === 0 ? prefixResult.stdout.trim() : "";
  // unique, unpredictable worktree path. the old `infracost-base-<pid>` name was
  // predictable (a local actor could pre-create/symlink it) and collided when
  // two baselines ran in the same process. mkdtemp gives a fresh PARENT dir;
  // the worktree itself goes in a not-yet-existing child (git worktree add
  // refuses a path that already exists). the finally removes both the git
  // worktree registration and the parent dir.
  const baseDir = mkdtempSync(join(tmpdir, "infracost-base-"));
  const worktree = join(baseDir, "wt");
  const add = run("git", ["worktree", "add", "--detach", worktree, baseRef], cwd);
  if (add.status !== 0) {
    rmSync(baseDir, { recursive: true, force: true });
    return null;
  }
  try {
    const scanCwd = prefix ? join(worktree, prefix) : worktree;
    const r = runInfracostBreakdown(scanCwd, key);
    if (r.missing || r.status !== 0) return null;
    return parseInfracostBreakdown(r.stdout);
  } catch {
    return null;
  } finally {
    run("git", ["worktree", "remove", "--force", worktree], cwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
}
