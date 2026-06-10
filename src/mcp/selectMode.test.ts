import { beforeEach, describe, expect, it, vi } from "vitest";
import { SelectModeTool } from "#app/mcp/selectMode";
import type { ToolContext } from "#app/mcp/server";
import type { Mode } from "#app/modes";
import type { ToolState } from "#app/toolState";
import { apiFetch } from "#app/utils/apiFetch";

vi.mock("#app/utils/apiFetch", () => ({
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

const MODES: Mode[] = [
  { name: "Build", description: "implement changes", prompt: "BUILD-PROMPT" },
  { name: "Plan", description: "plan work", prompt: "PLAN-PROMPT" },
  { name: "Review", description: "review a PR", prompt: "REVIEW-PROMPT" },
  { name: "IncrementalReview", description: "review the delta", prompt: "INCR-PROMPT" },
  { name: "Fix", description: "fix CI", prompt: undefined },
];

function makeCtx(overrides?: {
  toolState?: Partial<ToolState>;
  modeInstructions?: Record<string, string>;
  issueNumber?: number;
  githubInstallationToken?: string;
}): { ctx: ToolContext; toolState: ToolState } {
  const toolState = { ...overrides?.toolState } as ToolState;
  const ctx = {
    agentId: "claude",
    repo: { owner: "octo", name: "repo" },
    payload: { event: { issue_number: overrides?.issueNumber } },
    modes: MODES,
    modeInstructions: overrides?.modeInstructions ?? {},
    toolState,
    githubInstallationToken: overrides?.githubInstallationToken ?? "ghs_token",
  } as unknown as ToolContext;
  return { ctx, toolState };
}

function planCommentResponse(
  body: { commentId: number; body: string } | { error: string },
  ok = true,
) {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue(planCommentResponse({ error: "not found" }, false));
});

describe("SelectModeTool", () => {
  it("rejects a second selection once a mode is chosen", async () => {
    const { ctx } = makeCtx({ toolState: { selectedMode: "Build" } });
    const result = await runTool(SelectModeTool(ctx), { mode: "Review" });

    expect(result.content[0].text).toContain("mode already selected");
    expect(result.content[0].text).toContain("Build");
  });

  it("lists the available modes when the requested one is unknown", async () => {
    const { ctx, toolState } = makeCtx();
    const result = await runTool(SelectModeTool(ctx), { mode: "Nonsense" });

    expect(result.content[0].text).toContain("Nonsense");
    expect(result.content[0].text).toContain("not found. available modes:");
    expect(result.content[0].text).toContain("Build, Plan, Review, IncrementalReview, Fix");
    expect(toolState.selectedMode).toBeUndefined();
  });

  it("resolves the mode case-insensitively and records the selection", async () => {
    const { ctx, toolState } = makeCtx();
    const result = await runTool(SelectModeTool(ctx), { mode: "review" });

    expect(result.isError).toBeUndefined();
    expect(toolState.selectedMode).toBe("Review");
    expect(result.content[0].text).toContain("REVIEW-PROMPT");
  });

  it("joins the hardcoded prompt with the user's mode instructions", async () => {
    const { ctx } = makeCtx({ modeInstructions: { Build: "USER-BUILD-RULES" } });
    const result = await runTool(SelectModeTool(ctx), { mode: "Build" });

    expect(result.content[0].text).toContain("BUILD-PROMPT");
    expect(result.content[0].text).toContain("USER-BUILD-RULES");
  });

  it("Fix inherits Build's user instructions (no prompt of its own)", async () => {
    const { ctx } = makeCtx({ modeInstructions: { Build: "USER-BUILD-RULES" } });
    const result = await runTool(SelectModeTool(ctx), { mode: "Fix" });

    expect(result.content[0].text).toContain("modeName: Fix");
    expect(result.content[0].text).toContain("USER-BUILD-RULES");
    expect(result.content[0].text).not.toContain("BUILD-PROMPT");
  });

  it("IncrementalReview inherits Review's user instructions", async () => {
    const { ctx } = makeCtx({ modeInstructions: { Review: "USER-REVIEW-RULES" } });
    const result = await runTool(SelectModeTool(ctx), { mode: "IncrementalReview" });

    expect(result.content[0].text).toContain("INCR-PROMPT");
    expect(result.content[0].text).toContain("USER-REVIEW-RULES");
  });

  describe("Plan mode with an existing plan comment", () => {
    it("returns PlanEdit guidance plus the previous plan body", async () => {
      apiFetchMock.mockResolvedValue(planCommentResponse({ commentId: 88, body: "OLD-PLAN-BODY" }));
      const { ctx, toolState } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan", issue_number: 42 });

      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/repo/octo/repo/issue/42/plan-comment",
          headers: { authorization: "Bearer ghs_token" },
        }),
      );
      expect(toolState.existingPlanCommentId).toBe(88);
      expect(toolState.previousPlanBody).toBe("OLD-PLAN-BODY");
      expect(result.content[0].text).toContain("editing existing plan");
      expect(result.content[0].text).toContain("OLD-PLAN-BODY");
      expect(result.content[0].text).toContain("mcp__"); // claude-formatted tool refs
    });

    it("falls back to the event's issue number when none is passed", async () => {
      apiFetchMock.mockResolvedValue(planCommentResponse({ commentId: 9, body: "B" }));
      const { ctx } = makeCtx({ issueNumber: 7 });
      await runTool(SelectModeTool(ctx), { mode: "Plan" });

      expect(apiFetchMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/api/repo/octo/repo/issue/7/plan-comment" }),
      );
    });

    it("returns plain Plan guidance when the API has no plan comment", async () => {
      const { ctx, toolState } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan", issue_number: 42 });

      expect(toolState.existingPlanCommentId).toBeUndefined();
      expect(result.content[0].text).toContain("PLAN-PROMPT");
      expect(result.content[0].text).not.toContain("editing existing plan");
    });

    it("ignores an OK response whose body is an error payload", async () => {
      apiFetchMock.mockResolvedValue(planCommentResponse({ error: "no plan yet" }, true));
      const { ctx, toolState } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan", issue_number: 42 });

      expect(toolState.existingPlanCommentId).toBeUndefined();
      expect(result.content[0].text).toContain("PLAN-PROMPT");
    });

    it("treats an API error as no existing plan comment", async () => {
      apiFetchMock.mockRejectedValue(new Error("network down"));
      const { ctx } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan", issue_number: 42 });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("PLAN-PROMPT");
    });

    it("skips the lookup without a GitHub installation token", async () => {
      const { ctx } = makeCtx({ githubInstallationToken: "" });
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan", issue_number: 42 });

      expect(apiFetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("PLAN-PROMPT");
    });

    it("skips the lookup when no issue number is available at all", async () => {
      const { ctx } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Plan" });

      expect(apiFetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain("PLAN-PROMPT");
    });
  });

  describe("PR summary snapshot addendum", () => {
    it("appends the snapshot step for Review when a summary file is set", async () => {
      const { ctx } = makeCtx({ toolState: { summaryFilePath: "/tmp/summary.md" } });
      const result = await runTool(SelectModeTool(ctx), { mode: "Review" });

      expect(result.content[0].text).toContain("PR summary snapshot");
      expect(result.content[0].text).toContain("/tmp/summary.md");
      expect(result.content[0].text).toContain("REVIEW-PROMPT");
    });

    it("omits the addendum for Review without a summary file", async () => {
      const { ctx } = makeCtx();
      const result = await runTool(SelectModeTool(ctx), { mode: "Review" });

      expect(result.content[0].text).not.toContain("PR summary snapshot");
    });

    it("never appends the addendum for non-summary modes", async () => {
      const { ctx } = makeCtx({ toolState: { summaryFilePath: "/tmp/summary.md" } });
      const result = await runTool(SelectModeTool(ctx), { mode: "Build" });

      expect(result.content[0].text).not.toContain("PR summary snapshot");
    });
  });
});
