import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssueTool } from "#app/mcp/issue";
import type { ToolContext } from "#app/mcp/server";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";

vi.mock("#app/utils/patchWorkflowRunFields", () => ({
  patchWorkflowRunFields: vi.fn(async () => undefined),
}));

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(createData?: Record<string, unknown>) {
  const create = vi.fn(async (_p: unknown) => ({
    data: {
      id: 9001,
      number: 55,
      node_id: "ISSUE_NODE",
      html_url: "https://gh/issue/55",
      title: "created title",
      state: "open",
      labels: [{ name: "bug" }, "needs-human"],
      assignees: [{ login: "octocat" }],
      ...createData,
    },
  }));
  const ctx = {
    octokit: { rest: { issues: { create } } },
    repo: { owner: "octo", name: "repo" },
    payload: { push: "restricted", event: { trigger: "unknown" } },
    toolState: { createdTargets: new Set<number>() },
  } as unknown as ToolContext;
  return { ctx, create };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IssueTool (create_issue)", () => {
  it("creates an issue, normalizes labels/assignees, and patches the workflow run", async () => {
    const { ctx, create } = makeCtx();
    const result = await runTool(IssueTool(ctx), {
      title: "tighten s3 policy",
      body: "line1\\nline2",
      labels: ["security"],
      assignees: ["octocat"],
    });

    expect(result.isError).toBeUndefined();
    expect(create).toHaveBeenCalledWith({
      owner: "octo",
      repo: "repo",
      title: "tighten s3 policy",
      body: "line1\nline2", // double-escaped newline repaired
      labels: ["security"],
      assignees: ["octocat"],
    });
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { issueNodeId: "ISSUE_NODE" });
    const text = result.content[0].text;
    expect(text).toContain("success: true");
    expect(text).toContain("number: 55");
    expect(text).toContain("bug");
    expect(text).toContain("needs-human");
    expect(text).toContain("octocat");
  });

  it("defaults labels and assignees to empty arrays", async () => {
    const { ctx, create } = makeCtx();
    await runTool(IssueTool(ctx), { title: "t", body: "b" });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ labels: [], assignees: [] }));
  });

  it("skips the workflow-run patch when the node_id is missing", async () => {
    const { ctx } = makeCtx({ node_id: "" });
    const result = await runTool(IssueTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBeUndefined();
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
  });

  it("tolerates a response without labels/assignees arrays", async () => {
    const { ctx } = makeCtx({ labels: undefined, assignees: undefined });
    const result = await runTool(IssueTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
  });

  it("propagates GitHub API failures as tool errors", async () => {
    const { ctx, create } = makeCtx();
    create.mockRejectedValueOnce(new Error("validation failed"));
    const result = await runTool(IssueTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("validation failed");
  });

  it("is blocked under push: disabled (read-only access)", async () => {
    const { ctx, create } = makeCtx();
    (ctx.payload as { push: string }).push = "disabled";
    const result = await runTool(IssueTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/read-only access/);
    expect(create).not.toHaveBeenCalled();
  });
});
