import { type } from "arktype";
import { log } from "#app/utils/cli";
import { fixDoubleEscapedString } from "#app/utils/fixDoubleEscapedString";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";
import type { ToolContext } from "#app/mcp/server";
import { execute, tool } from "#app/mcp/shared";

export const Issue = type({
  title: type.string.describe("the title of the issue"),
  body: type.string.describe("the body content of the issue"),
  labels: type.string
    .array()
    .describe("optional array of label names to apply to the issue")
    .optional(),
  assignees: type.string
    .array()
    .describe("optional array of usernames to assign to the issue")
    .optional(),
});

export function IssueTool(ctx: ToolContext) {
  return tool({
    name: "create_issue",
    description: "Create a new GitHub issue",
    parameters: Issue,
    execute: execute(async (params) => {
      const result = await ctx.octokit.rest.issues.create({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        title: params.title,
        body: fixDoubleEscapedString(params.body),
        labels: params.labels ?? [],
        assignees: params.assignees ?? [],
      });

      log.info(`» created issue #${result.data.number} (id ${result.data.id})`);

      const nodeId = result.data.node_id;
      if (typeof nodeId === "string" && nodeId.length > 0) {
        await patchWorkflowRunFields(ctx, {
          issueNodeId: nodeId,
        });
      }

      return {
        success: true,
        issueId: result.data.id,
        number: result.data.number,
        url: result.data.html_url,
        title: result.data.title,
        state: result.data.state,
        labels: result.data.labels?.map((label) =>
          typeof label === "string" ? label : label.name
        ),
        assignees: result.data.assignees?.map((assignee) => assignee.login),
      };
    }),
  });
}
