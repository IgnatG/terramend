import { describe, expect, it, vi } from "vitest";
import { GetIssueCommentsTool } from "#app/mcp/issueComments";
import type { ToolContext } from "#app/mcp/server";
import { initToolState, type ToolState } from "#app/toolState";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(comments: Record<string, unknown>[]) {
  const listComments = vi.fn();
  const paginate = vi.fn(async (_route: unknown, _params: unknown) => comments);
  const toolState: ToolState = initToolState({ progressComment: undefined });
  const ctx = {
    octokit: { paginate, rest: { issues: { listComments } } },
    repo: { owner: "octo", name: "repo" },
    toolState,
    tmpdir: "/tmp",
    githubInstallationToken: "tok",
  } as unknown as ToolContext;
  return { ctx, paginate, listComments, toolState };
}

describe("GetIssueCommentsTool", () => {
  it("returns all comments with authors and records the issue number", async () => {
    const { ctx, paginate, listComments, toolState } = makeCtx([
      { id: 1, body: "first comment", body_html: "<p>first comment</p>", user: { login: "alice" } },
      { id: 2, body: null, user: undefined },
    ]);
    const result = await runTool(GetIssueCommentsTool(ctx), { issue_number: 7 });

    expect(result.isError).toBeUndefined();
    expect(toolState.issueNumber).toBe(7);
    expect(paginate).toHaveBeenCalledWith(
      listComments,
      expect.objectContaining({
        owner: "octo",
        repo: "repo",
        issue_number: 7,
        headers: { accept: "application/vnd.github.full+json" },
      }),
    );

    const text = result.content[0].text;
    expect(text).toContain("count: 2");
    expect(text).toContain("first comment");
    expect(text).toContain("alice");
  });

  it("handles an issue with no comments", async () => {
    const { ctx } = makeCtx([]);
    const result = await runTool(GetIssueCommentsTool(ctx), { issue_number: 7 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("count: 0");
  });

  it("surfaces pagination failures as tool errors", async () => {
    const { ctx, paginate } = makeCtx([]);
    paginate.mockRejectedValueOnce(new Error("rate limited"));
    const result = await runTool(GetIssueCommentsTool(ctx), { issue_number: 7 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limited");
  });
});
