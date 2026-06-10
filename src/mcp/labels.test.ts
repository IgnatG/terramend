import { describe, expect, it, vi } from "vitest";
import { AddLabelsTool } from "#app/mcp/labels";
import type { ToolContext } from "#app/mcp/server";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx() {
  const addLabels = vi.fn(async (_p: unknown) => ({
    data: [{ name: "bug" }, { name: "infra" }],
  }));
  const ctx = {
    octokit: { rest: { issues: { addLabels } } },
    repo: { owner: "octo", name: "repo" },
  } as unknown as ToolContext;
  return { ctx, addLabels };
}

describe("AddLabelsTool", () => {
  it("adds labels and returns the resulting label set", async () => {
    const { ctx, addLabels } = makeCtx();
    const result = await runTool(AddLabelsTool(ctx), {
      issue_number: 12,
      labels: ["bug", "infra"],
    });

    expect(result.isError).toBeUndefined();
    expect(addLabels).toHaveBeenCalledWith({
      owner: "octo",
      repo: "repo",
      issue_number: 12,
      labels: ["bug", "infra"],
    });
    const text = result.content[0].text;
    expect(text).toContain("success: true");
    expect(text).toContain("bug");
    expect(text).toContain("infra");
  });

  it("surfaces API failures as tool errors", async () => {
    const { ctx, addLabels } = makeCtx();
    addLabels.mockRejectedValueOnce(new Error("Label does not exist"));
    const result = await runTool(AddLabelsTool(ctx), { issue_number: 12, labels: ["nope"] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Label does not exist");
  });
});
