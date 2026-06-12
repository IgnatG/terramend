import { type } from "arktype";
import { addFooter } from "#app/mcp/comment";
import { assertTargetInScope } from "#app/mcp/scope";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool, toolOk } from "#app/mcp/shared";
import { log } from "#app/utils/cli";

/**
 * §27 Stale-fix self-healing. A Terramend remediation PR is "base + a minimal,
 * proven fix". When the base branch advances after the PR is opened, the PR goes
 * stale: its diff is computed against an old base, the concern may already be
 * resolved upstream (a human fixed it, or the base changed the file), or the
 * branch simply needs re-deriving on the new base. A scheduled `RefreshRemediation`
 * run sweeps the open remediation PRs and, per PR, either re-derives the fix on
 * the current base and force-updates it, closes it as already-resolved, or leaves
 * it for a human when someone has added their own commits.
 *
 * This file is the GitHub-orchestration seam: a pure classifier (`assessStaleFix`)
 * that decides what to do from git facts, the read tool that surfaces the open
 * remediation PRs with their staleness, and the focused write tool that closes a
 * now-redundant PR. The actual re-derive/validate/verify loop is driven by the
 * mode prompt using the existing scan/validate/verify/push tools — no git merge
 * is performed (re-deriving on the fresh base avoids conflict resolution entirely
 * and keeps the PR diff to exactly the fix).
 */

// the branch-name conventions Terramend opens PRs under: `remediate/<group-id>`
// (incl. `remediate/batch-<hash>`) for a fix and `terramend/generate-<slug>` for
// a generation. The naming is the primary "this is Terramend's PR" signal.
const REMEDIATION_BRANCH = /^(?:remediate\/|terramend\/generate-)/;

/** true when `branch` is a Terramend remediation/generation branch. */
export function isRemediationBranch(branch: string): boolean {
  return REMEDIATION_BRANCH.test(branch);
}

/** the `<group-id>` of a `remediate/<group-id>` branch (the scan group id that
 * keys the fix), or null for a generation branch / non-remediation branch. */
export function groupIdFromBranch(branch: string): string | null {
  return branch.match(/^remediate\/(.+)$/)?.[1] ?? null;
}

/** true when a commit-author login is Terramend's bot (so a commit by it is NOT
 * a human edit). A null/absent login is treated as non-human: Terramend pushes
 * with a git identity that often doesn't map to a GitHub user, so requiring a
 * positive bot match would make every PR look human-touched and never refresh. */
export function isBotActor(login: string | null | undefined): boolean {
  if (!login) return true;
  const normalized = login.replace(/\[bot\]$/i, "").toLowerCase();
  return normalized === "terramend" || normalized === "terramenddev" || /\[bot\]$/i.test(login);
}

export type StaleFixStatus = "current" | "stale" | "human_touched";
export type StaleFixAction = "skip" | "refresh" | "escalate";

export interface StaleFixAssessment {
  status: StaleFixStatus;
  action: StaleFixAction;
  reason: string;
}

/**
 * Decide what a refresh sweep should do with one open remediation PR, from git
 * facts alone. Pure.
 *  - a branch carrying NON-bot commits is `human_touched` → `escalate` (never
 *    force-overwrite a human's work; leave it for review).
 *  - a branch whose base has NOT advanced is `current` → `skip` (the fix is still
 *    derived against the live base).
 *  - otherwise the base moved → `stale` → `refresh`: re-derive the fix on the
 *    current base, then close it if the concern is already resolved or update it.
 */
export function assessStaleFix(input: {
  baseBehindBy: number;
  hasNonBotCommits: boolean;
}): StaleFixAssessment {
  if (input.hasNonBotCommits) {
    return {
      status: "human_touched",
      action: "escalate",
      reason:
        "the PR branch has commit(s) not authored by terramend — auto-refresh would overwrite a human's work; label it needs-human and leave it for review",
    };
  }
  if (input.baseBehindBy <= 0) {
    return {
      status: "current",
      action: "skip",
      reason: "the base has not advanced since the PR was opened — the fix is still current",
    };
  }
  return {
    status: "stale",
    action: "refresh",
    reason:
      `the base advanced ${input.baseBehindBy} commit(s) since the PR was opened — re-scan on the current base, ` +
      "then close the PR if the concern is already resolved or re-derive + force-update the fix otherwise",
  };
}

interface AssessedRemediationPr {
  number: number;
  url: string;
  title: string;
  branch: string;
  base: string;
  group_id: string | null;
  base_behind_by: number;
  head_ahead_by: number;
  has_non_bot_commits: boolean;
  commit_authors: string[];
  labels: string[];
  status: StaleFixStatus;
  recommended_action: StaleFixAction;
  reason: string;
}

export const ListRemediationPrsParams = type({
  "limit?": type.number.describe(
    "max open remediation PRs to assess (default 30). Each is one compare-commits API call.",
  ),
});

export function ListRemediationPrsTool(ctx: ToolContext) {
  return tool({
    name: "list_remediation_prs",
    description:
      "§27 — list the repo's OPEN Terramend remediation/generation PRs (branches `remediate/<id>` or " +
      "`terramend/generate-<slug>`) with their staleness, so a refresh sweep knows which to act on. For each " +
      "PR it compares the head branch against its base and returns `base_behind_by` (how many commits the " +
      "base advanced since the PR was opened), `head_ahead_by`, `has_non_bot_commits` (a human pushed to the " +
      "branch), the `group_id`, labels, and a `recommended_action`: `skip` (still current), `refresh` (base " +
      "moved — re-derive the fix on the current base, then close-if-resolved or force-update), or `escalate` " +
      "(human-touched — label needs-human, don't overwrite). Read-only. Use it as the first step of " +
      "RefreshRemediation.",
    parameters: ListRemediationPrsParams,
    execute: execute(async ({ limit }) => {
      const cap = limit ?? 30;
      const owner = ctx.repo.owner;
      const repo = ctx.repo.name;

      const open = await ctx.octokit.paginate(ctx.octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      const remediation = open.filter((pr) => isRemediationBranch(pr.head.ref)).slice(0, cap);

      const prs: AssessedRemediationPr[] = [];
      const errors: { number: number; error: string }[] = [];
      for (const pr of remediation) {
        try {
          // base..head: ahead_by = the PR's own commits, behind_by = commits on
          // the base the PR lacks (how far the base moved since the fork point).
          const cmp = await ctx.octokit.rest.repos.compareCommits({
            owner,
            repo,
            base: pr.base.ref,
            head: pr.head.ref,
          });
          const commitAuthors = [
            ...new Set(
              (cmp.data.commits ?? [])
                .map((c) => c.author?.login ?? c.commit.author?.name ?? null)
                .filter((a): a is string => a !== null),
            ),
          ];
          const hasNonBotCommits = (cmp.data.commits ?? []).some(
            (c) => !isBotActor(c.author?.login),
          );
          const assessment = assessStaleFix({
            baseBehindBy: cmp.data.behind_by,
            hasNonBotCommits,
          });
          prs.push({
            number: pr.number,
            url: pr.html_url,
            title: pr.title,
            branch: pr.head.ref,
            base: pr.base.ref,
            group_id: groupIdFromBranch(pr.head.ref),
            base_behind_by: cmp.data.behind_by,
            head_ahead_by: cmp.data.ahead_by,
            has_non_bot_commits: hasNonBotCommits,
            commit_authors: commitAuthors,
            labels: pr.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
            status: assessment.status,
            recommended_action: assessment.action,
            reason: assessment.reason,
          });
        } catch (e) {
          errors.push({ number: pr.number, error: e instanceof Error ? e.message : String(e) });
        }
      }

      const counts = {
        refresh: prs.filter((p) => p.recommended_action === "refresh").length,
        skip: prs.filter((p) => p.recommended_action === "skip").length,
        escalate: prs.filter((p) => p.recommended_action === "escalate").length,
      };
      log.info(
        `» list_remediation_prs: ${prs.length} open remediation PR(s) — ` +
          `${counts.refresh} refresh, ${counts.skip} skip, ${counts.escalate} escalate` +
          (errors.length ? ` (${errors.length} errored)` : ""),
      );
      return toolOk({
        count: prs.length,
        action_counts: counts,
        pull_requests: prs,
        ...(errors.length ? { errors } : {}),
        note:
          prs.length === 0
            ? "No open Terramend remediation PRs to refresh."
            : "Act on the `refresh` PRs (re-derive on the current base, then close-if-resolved or force-update); `escalate` PRs get a needs-human label and are left for a human; `skip` PRs are already current.",
      });
    }),
  });
}

export const ClosePullRequest = type({
  pull_number: type.number.describe("the pull request number to close (not merge)."),
  "comment?": type.string.describe(
    "an optional comment explaining why it's being closed — posted before closing (e.g. 'concern already resolved on the base; this fix is now redundant').",
  ),
});

export function ClosePullRequestTool(ctx: ToolContext) {
  return tool({
    name: "close_pull_request",
    description:
      "Close (NOT merge) a pull request. §27 use: a Terramend remediation PR whose concern is already " +
      "resolved on the current base — the fix is redundant, so close it (optionally with an explanatory " +
      "comment) instead of leaving a stale PR open. Blocked under `push: disabled`, and bound to the run's " +
      "scope (a comment-triggered run can only close the PR it was triggered on or one it opened; a " +
      "standalone scheduled sweep may close any). Never merges — closing is reversible.",
    parameters: ClosePullRequest,
    execute: execute(async ({ pull_number, comment }) => {
      // permission gate: closing a PR is a repo write — block it under read-only.
      if (ctx.payload.push === "disabled") {
        throw new Error(
          "Closing a pull request is disabled. This repository is configured for read-only access (push: disabled).",
        );
      }
      // scope gate: same binding as comment/label/PR-body writes (mcp/scope.ts).
      assertTargetInScope(ctx, pull_number, "close");

      const owner = ctx.repo.owner;
      const repo = ctx.repo.name;

      if (comment) {
        await ctx.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: pull_number,
          body: addFooter(ctx, comment),
        });
        log.info(`» commented before closing PR #${pull_number}`);
      }

      const result = await ctx.octokit.rest.pulls.update({
        owner,
        repo,
        pull_number,
        state: "closed",
      });
      ctx.toolState.wasUpdated = true;
      log.info(`» closed pull request #${result.data.number}`);

      return {
        success: true,
        number: result.data.number,
        state: result.data.state,
        url: result.data.html_url,
      };
    }),
  });
}
