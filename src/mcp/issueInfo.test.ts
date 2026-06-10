import { describe, expect, it, vi } from "vitest";
import { IssueInfoTool } from "#app/mcp/issueInfo";
import type { ToolContext } from "#app/mcp/server";
import { initToolState, type ToolState } from "#app/toolState";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

const fullIssue = {
  number: 5,
  html_url: "https://gh/issues/5",
  title: "Broken pipeline",
  body: "plain body",
  body_html: "<p>plain body</p>",
  state: "open",
  locked: false,
  labels: ["bug", { name: "infra" }],
  assignees: [{ login: "alice" }],
  user: { login: "bob" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  closed_at: null,
  comments: 2,
  milestone: { title: "v1" },
  pull_request: {
    url: "https://api/pulls/5",
    html_url: "https://gh/pull/5",
    diff_url: "https://gh/pull/5.diff",
    patch_url: "https://gh/pull/5.patch",
  },
};

function makeCtx(issueData: Record<string, unknown>) {
  const get = vi.fn(async (_p: unknown) => ({ data: issueData }));
  const toolState: ToolState = initToolState({ progressComment: undefined });
  const ctx = {
    octokit: { rest: { issues: { get } } },
    repo: { owner: "octo", name: "repo" },
    toolState,
    tmpdir: "/tmp",
    githubInstallationToken: "tok",
  } as unknown as ToolContext;
  return { ctx, get, toolState };
}

describe("IssueInfoTool", () => {
  it("returns issue details and records the issue number in tool state", async () => {
    const { ctx, get, toolState } = makeCtx(fullIssue);
    const result = await runTool(IssueInfoTool(ctx), { issue_number: 5 });

    expect(result.isError).toBeUndefined();
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octo",
        repo: "repo",
        issue_number: 5,
        headers: { accept: "application/vnd.github.full+json" },
      }),
    );
    expect(toolState.issueNumber).toBe(5);

    const text = result.content[0].text;
    expect(text).toContain("Broken pipeline");
    expect(text).toContain("plain body");
    expect(text).toContain("infra");
    expect(text).toContain("alice");
    expect(text).toContain("v1");
    expect(text).toContain("https://gh/pull/5.diff");
    expect(text).toContain("get_issue_comments");
    expect(text).toContain("get_issue_events");
  });

  it("omits the comments hint and nulls pull_request for a bare issue", async () => {
    const { ctx } = makeCtx({
      ...fullIssue,
      comments: 0,
      pull_request: undefined,
      labels: undefined,
      assignees: undefined,
      user: null,
      milestone: undefined,
    });
    const result = await runTool(IssueInfoTool(ctx), { issue_number: 5 });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).not.toContain("get_issue_comments");
    expect(text).toContain("get_issue_events");
    expect(text).toContain("pull_request: null");
  });

  it("surfaces API failures as tool errors", async () => {
    const { ctx, get } = makeCtx(fullIssue);
    get.mockRejectedValueOnce(new Error("API down"));
    const result = await runTool(IssueInfoTool(ctx), { issue_number: 5 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("API down");
  });
});
