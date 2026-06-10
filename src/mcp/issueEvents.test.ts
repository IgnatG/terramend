import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetIssueEventsTool } from "#app/mcp/issueEvents";
import type { ToolContext } from "#app/mcp/server";
import type { ToolState } from "#app/toolState";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(events: unknown[]): {
  ctx: ToolContext;
  toolState: ToolState;
  paginate: ReturnType<typeof vi.fn>;
} {
  const toolState = {} as ToolState;
  const listEventsForTimeline = { endpoint: "timeline" };
  const paginate = vi.fn(async (endpoint: unknown) => {
    expect(endpoint).toBe(listEventsForTimeline);
    return events;
  });
  const ctx = {
    octokit: { paginate, rest: { issues: { listEventsForTimeline } } },
    repo: { owner: "octo", name: "repo" },
    toolState,
  } as unknown as ToolContext;
  return { ctx, toolState, paginate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GetIssueEventsTool", () => {
  it("records the issue number on tool state and queries the timeline", async () => {
    const { ctx, toolState, paginate } = makeCtx([]);
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    expect(result.isError).toBeUndefined();
    expect(toolState.issueNumber).toBe(17);
    expect(paginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: "octo", repo: "repo", issue_number: 17 }),
    );
    expect(result.content[0].text).toContain("count: 0");
  });

  it("filters out events that are not cross_referenced/referenced", async () => {
    const { ctx } = makeCtx([
      { event: "labeled", id: 1 },
      { event: "assigned", id: 2 },
      { not_an_event: true },
      { event: 42 },
    ]);
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    expect(result.content[0].text).toContain("events: []");
    expect(result.content[0].text).toContain("count: 0");
  });

  it("extracts cross-referenced issues and pull requests with actor fallbacks", async () => {
    const { ctx } = makeCtx([
      {
        event: "cross_referenced",
        actor: { login: "alice" },
        created_at: "2026-06-01T00:00:00Z",
        source: {
          type: "issue",
          issue: { number: 12, title: "linked issue", html_url: "https://gh/i/12" },
        },
      },
      {
        event: "cross_referenced",
        user: { login: "bob" },
        source: {
          type: "issue",
          pull_request: { number: 34, title: "linked PR", html_url: "https://gh/pr/34" },
        },
      },
      // cross_referenced without a source object — only the base fields survive
      { event: "cross_referenced", id: 3 },
    ]);
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    const text = result.content[0].text;
    expect(text).toContain("count: 3");
    expect(text).toContain("actor: alice");
    expect(text).toContain("actor: bob");
    expect(text).toContain("linked issue");
    expect(text).toContain("https://gh/i/12");
    expect(text).toContain("linked PR");
    expect(text).toContain("https://gh/pr/34");
  });

  it("extracts commit references from referenced events", async () => {
    const { ctx } = makeCtx([
      {
        event: "referenced",
        id: 99,
        actor: { login: "carol" },
        created_at: "2026-06-02T00:00:00Z",
        commit_id: "abc123",
        commit_url: "https://gh/commit/abc123",
      },
    ]);
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    const text = result.content[0].text;
    expect(text).toContain("count: 1");
    expect(text).toContain("commit_id");
    expect(text).toContain("abc123");
    expect(text).toContain("99");
    expect(text).toContain("carol");
  });

  it("keeps a referenced event without commit fields (base fields only)", async () => {
    const { ctx } = makeCtx([{ event: "referenced", id: 5 }]);
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    expect(result.content[0].text).toContain("count: 1");
    expect(result.content[0].text).toContain("referenced");
  });

  it("propagates pagination failures as tool errors", async () => {
    const { ctx, paginate } = makeCtx([]);
    paginate.mockRejectedValueOnce(new Error("rate limited"));
    const result = await runTool(GetIssueEventsTool(ctx), { issue_number: 17 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("rate limited");
  });
});
