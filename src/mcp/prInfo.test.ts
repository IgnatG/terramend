import { describe, expect, it, vi } from "vitest";
import { PullRequestInfoTool } from "#app/mcp/prInfo";
import type { ToolContext } from "#app/mcp/server";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makePullData(overrides?: Record<string, unknown>) {
  return {
    number: 7,
    html_url: "https://gh/pull/7",
    title: "Enable bucket versioning",
    body: "pr body",
    state: "open",
    draft: false,
    merged: false,
    maintainer_can_modify: true,
    base: { ref: "main", repo: { full_name: "octo/repo" } },
    head: { ref: "feat/versioning", repo: { full_name: "octo/repo" } },
    user: { login: "alice" },
    assignees: [{ login: "bob" }],
    labels: [{ name: "infra" }],
    ...overrides,
  };
}

function makeCtx(pullData: Record<string, unknown>) {
  const pullsGet = vi.fn(async (_p: unknown) => ({ data: pullData }));
  const issuesGet = vi.fn(async (_p: unknown) => ({
    data: { body_html: "<p>pr body</p>" },
  }));
  const graphql = vi.fn(async (_q: string, _v: unknown) => ({
    repository: {
      pullRequest: {
        closingIssuesReferences: { nodes: [{ number: 3, title: "Bucket is unversioned" }] },
      },
    },
  }));
  const ctx = {
    octokit: { rest: { pulls: { get: pullsGet }, issues: { get: issuesGet } }, graphql },
    repo: { owner: "octo", name: "repo" },
    tmpdir: "/tmp",
    githubInstallationToken: "tok",
  } as unknown as ToolContext;
  return { ctx, pullsGet, issuesGet, graphql };
}

describe("PullRequestInfoTool", () => {
  it("returns PR metadata with linked closing issues", async () => {
    const { ctx, pullsGet, issuesGet, graphql } = makeCtx(makePullData());
    const result = await runTool(PullRequestInfoTool(ctx), { pull_number: 7 });

    expect(result.isError).toBeUndefined();
    expect(pullsGet).toHaveBeenCalledWith({ owner: "octo", repo: "repo", pull_number: 7 });
    expect(issuesGet).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 7,
        headers: { accept: "application/vnd.github.full+json" },
      }),
    );
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("closingIssuesReferences"), {
      owner: "octo",
      repo: "repo",
      number: 7,
    });

    const text = result.content[0].text;
    expect(text).toContain("Enable bucket versioning");
    expect(text).toContain("isFork: false");
    expect(text).toContain("base: main");
    expect(text).toContain("head: feat/versioning");
    expect(text).toContain("Bucket is unversioned");
    expect(text).toContain("infra");
  });

  it("flags fork PRs when the head repo differs (or is gone)", async () => {
    const { ctx } = makeCtx(makePullData({ head: { ref: "feat", repo: null } }));
    const result = await runTool(PullRequestInfoTool(ctx), { pull_number: 7 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("isFork: true");
  });

  it("surfaces API failures as tool errors", async () => {
    const { ctx, graphql } = makeCtx(makePullData());
    graphql.mockRejectedValueOnce(new Error("GraphQL exploded"));
    const result = await runTool(PullRequestInfoTool(ctx), { pull_number: 7 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GraphQL exploded");
  });
});
