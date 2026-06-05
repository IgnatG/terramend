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
  base: type.string.describe("the base branch to merge into (e.g., 'main')"),
  "draft?": type.boolean.describe(
    "if true, create the pull request as a draft. use when the user explicitly asks for a draft PR."
  ),
});

function buildPrBodyWithFooter(ctx: ToolContext, body: string): string {
  const footer = buildTerramendFooter({
    triggeredBy: true,
    workflowRun: ctx.runId
      ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
      : undefined,
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
      log.debug(`Current branch: ${currentBranch}`);

      const bodyWithFooter = buildPrBodyWithFooter(ctx, params.body);

      const result = await ctx.octokit.rest.pulls.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        title: params.title,
        body: bodyWithFooter,
        head: currentBranch,
        base: params.base,
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
