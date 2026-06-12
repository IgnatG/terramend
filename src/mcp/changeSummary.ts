import { type } from "arktype";
import { resolveBaseBranch } from "#app/mcp/pr";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool, toolOk } from "#app/mcp/shared";
import { skipResult } from "#app/mcp/terraform/types";
import { log } from "#app/utils/cli";
import { $ } from "#app/utils/shell";

/**
 * §36 AI PR summaries — the deterministic Terraform-change anchor. A PR summary
 * written purely by the model drifts (miscounts resources, invents changes). This
 * parses the PR's unified diff for Terraform BLOCK changes (which resource /
 * module / data / variable / output addresses were added or removed, which files
 * were touched) so the human-readable summary is anchored to facts, not prose.
 *
 * Pure parser (`summarizeTerraformResourceDiff`) + a tool that runs the
 * merge-base diff and feeds it in. Block ADDED/REMOVED is precise (a block header
 * on a +/- line); in-place edits to an existing block surface as a touched FILE
 * (attributing a sub-block edit to a specific address needs full-file parsing —
 * we stay honest and report the file rather than guess).
 */

export interface TerraformChangeSummary {
  /** addresses of blocks added in this diff (e.g. `aws_s3_bucket.logs`, `module.vpc`). */
  added: string[];
  /** addresses of blocks removed in this diff. */
  removed: string[];
  /** Terraform files touched (a superset signal — includes in-place edits). */
  files: string[];
  counts: { added: number; removed: number; files: number };
}

const isTfFile = (file: string): boolean => /\.tf$|\.tfvars$/.test(file);

/**
 * Parse a Terraform block header into its address, or null when the line is not a
 * top-level block header. Handles two-label blocks (`resource`/`data`) and
 * single-label blocks (`module`/`variable`/`output`/`provider`). The line is the
 * raw HCL (diff +/- prefix already stripped). Pure.
 */
export function parseBlockAddress(line: string): string | null {
  const s = line.trim();
  const two = s.match(/^(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
  if (two) {
    const [, kind, t, name] = two;
    return kind === "data" ? `data.${t}.${name}` : `${t}.${name}`;
  }
  const one = s.match(/^(module|variable|output|provider)\s+"([^"]+)"\s*\{/);
  if (one) {
    const [, kind, name] = one;
    const prefix = kind === "variable" ? "var" : kind;
    return `${prefix}.${name}`;
  }
  return null;
}

/**
 * Summarise a unified `git diff` into added/removed Terraform block addresses +
 * the touched Terraform files. Tracks the current file from `+++ b/<path>`
 * headers and only considers `.tf`/`.tfvars` files. Pure; deterministic ordering
 * (sorted, de-duplicated). A block counted as both added and removed (moved) is
 * left in both lists — the prose can describe the move.
 */
export function summarizeTerraformResourceDiff(diff: string): TerraformChangeSummary {
  const added = new Set<string>();
  const removed = new Set<string>();
  const files = new Set<string>();
  let file = "";
  let inTf = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim().replace(/^b\//, "");
      file = path === "/dev/null" ? "" : path;
      inTf = !!file && isTfFile(file);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git") || raw.startsWith("@@")) continue;
    if (!inTf) continue;
    if (raw.startsWith("+") || raw.startsWith("-")) {
      files.add(file);
      const addr = parseBlockAddress(raw.slice(1));
      if (addr) (raw.startsWith("+") ? added : removed).add(addr);
    }
  }
  const sort = (s: Set<string>): string[] => [...s].sort();
  return {
    added: sort(added),
    removed: sort(removed),
    files: sort(files),
    counts: { added: added.size, removed: removed.size, files: files.size },
  };
}

export const TerraformChangeSummaryParams = type({
  "base?": type.string.describe(
    "base branch to diff against (default: the run's resolved base branch — main/master or the base_branch input).",
  ),
});

export function TerraformChangeSummaryTool(ctx: ToolContext) {
  return tool({
    name: "terraform_change_summary",
    description:
      "§36 — a DETERMINISTIC anchor for a PR summary: the Terraform `resource`/`module`/`data`/`variable`/" +
      "`output` addresses ADDED and REMOVED on this branch vs its base, plus the Terraform files touched. " +
      "Runs a merge-base `git diff` of `*.tf`/`*.tfvars` and parses the block headers, so the human-readable " +
      "summary you write is grounded in real counts instead of guessed ones. Degrades green (returns " +
      "`ok: false`) when git can't resolve the base (fetch it first) or nothing Terraform changed — then " +
      "summarise from the diff yourself. In-place edits to an existing block surface as a touched `file` " +
      "(not an added/removed address). Use it in SummarizePr (or any PR summary) before writing the prose.",
    parameters: TerraformChangeSummaryParams,
    execute: execute(async ({ base }) => {
      const baseBranch = base ?? resolveBaseBranch(ctx);
      const pathspec = ["--", "*.tf", "*.tfvars"];
      let diff: string | null = null;
      // prefer the remote-tracking base (origin/<base>), fall back to a local ref.
      for (const ref of [`origin/${baseBranch}`, baseBranch]) {
        try {
          diff = $("git", ["diff", "--merge-base", ref, ...pathspec], { log: false });
          break;
        } catch {
          diff = null;
        }
      }
      if (diff === null) {
        return skipResult(
          "base_unresolved",
          `could not diff against '${baseBranch}' (fetch the base first, e.g. git_fetch({ ref: "${baseBranch}" })) — summarise from the diff yourself`,
        );
      }
      const summary = summarizeTerraformResourceDiff(diff);
      if (summary.counts.files === 0) {
        return skipResult(
          "no_terraform_changes",
          "no Terraform files changed vs the base — this PR's summary is not Terraform-specific; summarise from the diff yourself",
        );
      }
      log.info(
        `» terraform_change_summary: +${summary.counts.added} -${summary.counts.removed} block(s) ` +
          `across ${summary.counts.files} file(s) vs ${baseBranch}`,
      );
      return toolOk({ base: baseBranch, ...summary });
    }),
  });
}
