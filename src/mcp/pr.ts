import { type } from "arktype";
import { buildTerramendFooter, stripExistingFooter } from "#app/utils/buildTerramendFooter";
import { log } from "#app/utils/cli";
import { fixDoubleEscapedString } from "#app/utils/fixDoubleEscapedString";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";
import { $ } from "#app/utils/shell";
import { assertUnderPrCap, recordRemediationPrOpened } from "#app/mcp/guardrails";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

export const PullRequest = type({
  title: type.string.describe("the title of the pull request"),
  body: type.string.describe("the body content of the pull request"),
  "base?": type.string.describe(
    "the base branch to merge into (e.g. 'main'). Omit to use the run's resolved base branch: the `base_branch` input, else the repository's default branch (main, or master)."
  ),
  "draft?": type.boolean.describe(
    "if true, create the pull request as a draft. use when the user explicitly asks for a draft PR."
  ),
});

/**
 * Pure base-branch picker. Precedence: an explicit `base_branch` declaration
 * always wins; otherwise the repository's default branch (GitHub reports it —
 * normally `main`, sometimes `master`); otherwise prefer `main`, then `master`;
 * final fallback `main`. Split out from git/ctx so it's exhaustively testable.
 */
export function pickBaseBranch(opts: {
  declared?: string | undefined;
  defaultBranch?: string | undefined;
  mainExists: boolean;
  masterExists: boolean;
}): string {
  if (opts.declared) return opts.declared;
  if (opts.defaultBranch) return opts.defaultBranch;
  if (opts.mainExists) return "main";
  if (opts.masterExists) return "master";
  return "main";
}

/** true when `branch` exists as a remote-tracking or local ref. */
function branchExists(branch: string): boolean {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      $("git", ["rev-parse", "--verify", "--quiet", ref], { log: false });
      return true;
    } catch {
      // ref absent — try the next form
    }
  }
  return false;
}

/**
 * Deterministically resolve the branch a PR targets, so the base is never left
 * to the agent's guess. Resolves to the repository's default branch (`main`, or
 * `master`), overridable by the `base_branch` input. Git is only probed for
 * main/master in the last-resort case where neither an explicit declaration nor
 * a GitHub default branch is available (essentially never).
 */
export function resolveBaseBranch(ctx: ToolContext): string {
  const declared = ctx.payload.baseBranch?.trim() || undefined;
  const defaultBranch = ctx.repo.data.default_branch?.trim() || undefined;
  const needsProbe = !declared && !defaultBranch;
  return pickBaseBranch({
    declared,
    defaultBranch,
    mainExists: needsProbe && branchExists("main"),
    masterExists: needsProbe && branchExists("master"),
  });
}

function buildPrBodyWithFooter(ctx: ToolContext, body: string): string {
  const footer = buildTerramendFooter({
    triggeredBy: true,
    model: ctx.toolState.model,
    fallbackFrom: ctx.toolState.modelFallback?.from,
  });

  const bodyWithoutFooter = stripExistingFooter(fixDoubleEscapedString(body));
  return `${bodyWithoutFooter}${footer}`;
}

export const UpdatePullRequestBody = type({
  pull_number: type.number.describe("the pull request number to update"),
  body: type.string.describe("the new body content for the pull request"),
});

export function UpdatePullRequestBodyTool(ctx: ToolContext) {
  return tool({
    name: "update_pull_request_body",
    description: "Update the body/description of an existing pull request",
    parameters: UpdatePullRequestBody,
    execute: execute(async (params) => {
      const bodyWithFooter = buildPrBodyWithFooter(ctx, params.body);

      const result = await ctx.octokit.rest.pulls.update({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number: params.pull_number,
        body: bodyWithFooter,
      });
      log.info(`» updated pull request #${result.data.number}`);

      ctx.toolState.wasUpdated = true;

      return {
        success: true,
        number: result.data.number,
        url: result.data.html_url,
      };
    }),
  });
}

export function CreatePullRequestTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request",
    description: "Create a pull request from the current branch",
    parameters: PullRequest,
    execute: execute(async (params) => {
      // Remediate-mode guardrail: stop at the configured max_prs. No-op otherwise.
      assertUnderPrCap(ctx);

      const currentBranch = $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { log: false });
      const base = params.base ?? resolveBaseBranch(ctx);
      log.debug(`Current branch: ${currentBranch}; PR base: ${base}`);

      const bodyWithFooter = buildPrBodyWithFooter(ctx, params.body);

      const result = await ctx.octokit.rest.pulls.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        title: params.title,
        body: bodyWithFooter,
        head: currentBranch,
        base,
        draft: params.draft ?? false,
      });
      log.info(`» created pull request #${result.data.number} (id ${result.data.id})`);

      // best-effort: request review from the user who triggered the workflow
      const reviewer = ctx.payload.triggerer;
      if (reviewer) {
        try {
          log.debug(`requesting review from ${reviewer} on PR #${result.data.number}`);
          await ctx.octokit.rest.pulls.requestReviewers({
            owner: ctx.repo.owner,
            repo: ctx.repo.name,
            pull_number: result.data.number,
            reviewers: [reviewer],
          });
        } catch {
          log.info(`failed to request review from ${reviewer} on PR #${result.data.number}`);
        }
      }

      if (typeof result.data.node_id === "string" && result.data.node_id.length > 0) {
        await patchWorkflowRunFields(ctx, {
          prNodeId: result.data.node_id,
        });
      }

      // count this toward the per-run remediation PR cap (Remediate mode only).
      recordRemediationPrOpened(ctx);

      return {
        success: true,
        pullRequestId: result.data.id,
        number: result.data.number,
        url: result.data.html_url,
        title: result.data.title,
        head: result.data.head.ref,
        base: result.data.base.ref,
      };
    }),
  });
}
