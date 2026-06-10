import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFooter,
  CreateCommentTool,
  deleteProgressComment,
  duplicateReplyDecision,
  EditCommentTool,
  ReplyToReviewCommentTool,
  ReportProgressTool,
  reportProgress,
} from "#app/mcp/comment";
import type { ToolContext } from "#app/mcp/server";
import { initToolState, type ToolState } from "#app/toolState";
import { TERRAMEND_DIVIDER } from "#app/utils/buildTerramendFooter";
import { log } from "#app/utils/cli";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";

vi.mock("#app/utils/patchWorkflowRunFields", () => ({
  patchWorkflowRunFields: vi.fn(async () => undefined),
}));

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeOctokit() {
  return {
    rest: {
      issues: {
        createComment: vi.fn(async (_p: unknown) => ({
          data: {
            id: 101,
            node_id: "NODE_101",
            html_url: "https://gh/comment/101",
            body: "created body" as string | null,
          },
        })),
        updateComment: vi.fn(async (_p: unknown) => ({
          data: {
            id: 101,
            node_id: "NODE_101" as string | undefined,
            html_url: "https://gh/comment/101",
            body: "updated body" as string | null,
            updated_at: "2026-06-10T00:00:00Z",
          },
        })),
        deleteComment: vi.fn(async (_p: unknown) => ({})),
      },
      pulls: {
        createReplyForReviewComment: vi.fn(async (_p: unknown) => ({
          data: {
            id: 555,
            html_url: "https://gh/review/555",
            body: "reply body",
            in_reply_to_id: 42,
          },
        })),
        updateReviewComment: vi.fn(async (_p: unknown) => ({
          data: {
            id: 777,
            node_id: "NODE_777",
            html_url: "https://gh/review/777",
            body: "review updated",
          },
        })),
        deleteReviewComment: vi.fn(async (_p: unknown) => ({})),
      },
    },
  };
}

function makeCtx(overrides?: { toolState?: Partial<ToolState>; event?: Record<string, unknown> }): {
  ctx: ToolContext;
  octokit: ReturnType<typeof makeOctokit>;
  toolState: ToolState;
} {
  const octokit = makeOctokit();
  const toolState: ToolState = {
    ...initToolState({ progressComment: undefined }),
    ...overrides?.toolState,
  };
  const ctx = {
    octokit,
    repo: { owner: "octo", name: "repo" },
    payload: { event: { ...overrides?.event } },
    toolState,
    runId: 1,
    apiToken: "jwt",
    tmpdir: "/tmp",
  } as unknown as ToolContext;
  return { ctx, octokit, toolState };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("API_URL", "https://terramend.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("addFooter", () => {
  it("throws when <br/> is followed by a non-blank line", () => {
    const { ctx } = makeCtx();
    expect(() => addFooter(ctx, "before<br/>\nnext line")).toThrow(/blank line after <br\/> tags/);
  });

  it("accepts <br/> followed by a blank line and appends the footer", () => {
    const { ctx } = makeCtx();
    const result = addFooter(ctx, "before<br/>\n\nafter");
    expect(result).toContain("before<br/>\n\nafter");
    expect(result).toContain(TERRAMEND_DIVIDER);
    expect(result).toContain("via Terramend");
  });

  it("strips an existing footer before appending a fresh one", () => {
    const { ctx } = makeCtx();
    const body = `hello world\n\n${TERRAMEND_DIVIDER}\n<sup>stale footer</sup>`;
    const result = addFooter(ctx, body);
    expect(result.startsWith("hello world")).toBe(true);
    expect(result).not.toContain("stale footer");
    expect(result.indexOf(TERRAMEND_DIVIDER)).toBe(result.lastIndexOf(TERRAMEND_DIVIDER));
  });

  it("repairs double-escaped newlines in the body", () => {
    const { ctx } = makeCtx();
    const result = addFooter(ctx, "line1\\nline2");
    expect(result).toContain("line1\nline2");
    expect(result).not.toContain("line1\\nline2");
  });
});

describe("duplicateReplyDecision", () => {
  it("returns null when there is no prior reply", () => {
    expect(duplicateReplyDecision({ existing: undefined, bodyWithFooter: "x" })).toBeNull();
  });

  it("returns null when the prior reply has a different body", () => {
    expect(
      duplicateReplyDecision({
        existing: { commentId: 1, url: "u", bodyWithFooter: "other" },
        bodyWithFooter: "x",
      }),
    ).toBeNull();
  });

  it("flags an identical body to the same parent as a duplicate", () => {
    const decision = duplicateReplyDecision({
      existing: { commentId: 7, url: "https://gh/r/7", bodyWithFooter: "same" },
      bodyWithFooter: "same",
    });
    expect(decision).toMatchObject({
      kind: "already-replied",
      commentId: 7,
      url: "https://gh/r/7",
    });
    expect(decision?.reason).toMatch(/identical body/);
  });
});

describe("CreateCommentTool", () => {
  it("creates a regular comment with footer and marks wasUpdated", async () => {
    const { ctx, octokit, toolState } = makeCtx();
    const result = await runTool(CreateCommentTool(ctx), { issueNumber: 12, body: "hi there" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octo", repo: "repo", issue_number: 12 }),
    );
    const createBody = octokit.rest.issues.createComment.mock.calls[0]?.[0] as { body: string };
    expect(createBody.body).toContain(TERRAMEND_DIVIDER);
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(toolState.wasUpdated).toBe(true);
  });

  it("Plan type: creates, patches planCommentNodeId, then updates with implement link", async () => {
    const { ctx, octokit } = makeCtx();
    const result = await runTool(CreateCommentTool(ctx), {
      issueNumber: 12,
      body: "the plan",
      type: "Plan",
    });

    expect(result.isError).toBeUndefined();
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { planCommentNodeId: "NODE_101" });
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 101 }),
    );
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).toContain("Implement plan");
    expect(updateBody.body).toContain("/trigger/octo/repo/12?action=implement&comment_id=101");
    // the returned payload is the UPDATED comment (with the plan link), not the
    // initial create — pin the fields so a regression to the create result (or
    // an empty object) is caught.
    expect(result.content[0].text).toContain("success: true");
    expect(result.content[0].text).toContain("101");
    expect(result.content[0].text).toContain("https://gh/comment/101");
  });

  it("Plan type without node_id skips the workflow-run patch", async () => {
    const { ctx, octokit } = makeCtx();
    octokit.rest.issues.createComment.mockResolvedValueOnce({
      data: { id: 101, node_id: "", html_url: "https://gh/comment/101", body: "b" },
    });
    await runTool(CreateCommentTool(ctx), { issueNumber: 12, body: "the plan", type: "Plan" });

    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).toHaveBeenCalled();
  });

  it("surfaces addFooter validation failures as tool errors", async () => {
    const { ctx, octokit } = makeCtx();
    const result = await runTool(CreateCommentTool(ctx), {
      issueNumber: 12,
      body: "bad<br/>\nno blank line",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/blank line after <br\/> tags/);
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });
});

describe("EditCommentTool", () => {
  it("updates the comment in place with a footer", async () => {
    const { ctx, octokit } = makeCtx();
    const result = await runTool(EditCommentTool(ctx), { commentId: 101, body: "new text" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octo", repo: "repo", comment_id: 101 }),
    );
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).toContain("new text");
    expect(updateBody.body).toContain(TERRAMEND_DIVIDER);
  });

  it("propagates API failures as tool errors", async () => {
    const { ctx, octokit } = makeCtx();
    octokit.rest.issues.updateComment.mockRejectedValueOnce(new Error("API down"));
    const result = await runTool(EditCommentTool(ctx), { commentId: 101, body: "new text" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("API down");
  });
});

describe("ReplyToReviewCommentTool", () => {
  it("posts a reply, marks wasUpdated, and records it for dedupe", async () => {
    const { ctx, octokit, toolState } = makeCtx();
    const result = await runTool(ReplyToReviewCommentTool(ctx), {
      pull_number: 9,
      comment_id: 42,
      body: "Fixed by renaming.",
    });

    expect(result.isError).toBeUndefined();
    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octo", repo: "repo", pull_number: 9, comment_id: 42 }),
    );
    expect(toolState.wasUpdated).toBe(true);
    expect(toolState.reviewReplies?.get(42)).toMatchObject({
      commentId: 555,
      url: "https://gh/review/555",
    });
  });

  it("skips an identical second reply to the same parent comment", async () => {
    const { ctx, octokit } = makeCtx();
    const tool = ReplyToReviewCommentTool(ctx);
    const params = { pull_number: 9, comment_id: 42, body: "Fixed by renaming." };
    await runTool(tool, params);
    const second = await runTool(tool, params);

    expect(second.isError).toBeUndefined();
    expect(second.content[0].text).toContain("skipped: true");
    expect(octokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledTimes(1);
  });
});

describe("reportProgress", () => {
  it("liveProgress writes do not record lastProgressBody or flip wasUpdated", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
    });
    const result = await reportProgress(ctx, { body: "live checklist", liveProgress: true });

    expect(result.action).toBe("updated");
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 9 }),
    );
    expect(toolState.lastProgressBody).toBeUndefined();
    expect(toolState.wasUpdated).toBeUndefined();
  });

  it("silent events are skipped but the body is still tracked for the summary", async () => {
    const { ctx, octokit, toolState } = makeCtx({ event: { silent: true, issue_number: 7 } });
    const result = await reportProgress(ctx, { body: "quiet" });

    expect(result).toEqual({ body: "quiet", action: "skipped" });
    expect(toolState.lastProgressBody).toBe("quiet");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("updates an existing issue comment; plan mode patches planCommentNodeId", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" }, selectedMode: "Plan" },
      event: { issue_number: 7 },
    });
    const result = await reportProgress(ctx, { body: "progress" });

    expect(result.action).toBe("updated");
    expect(result.commentId).toBe(101);
    expect(toolState.wasUpdated).toBe(true);
    expect(toolState.lastProgressBody).toBe("progress");
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { planCommentNodeId: "NODE_101" });
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).toContain("Implement plan");
  });

  it("warns and falls through to the normal path when target_plan_comment has no stored id", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
      event: { issue_number: 7 },
    });
    const warnSpy = vi.spyOn(log, "warning").mockImplementation(() => {});
    try {
      const result = await reportProgress(ctx, { body: "revise", target_plan_comment: true });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("no existingPlanCommentId in tool state"),
      );
      // without a stored plan-comment id the flag is ignored: the run's own
      // progress comment (id 9) is updated, not a plan comment.
      expect(result.action).toBe("updated");
      expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 9 }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("updates an existing comment without plan extras outside Plan mode", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
      event: { issue_number: 7 },
    });
    const result = await reportProgress(ctx, { body: "progress" });

    expect(result.action).toBe("updated");
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).not.toContain("Implement plan");
  });

  it("skips when the progress comment was deliberately deleted (null)", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: null },
      event: { issue_number: 7 },
    });
    const result = await reportProgress(ctx, { body: "after delete" });

    expect(result).toEqual({ body: "after delete", action: "skipped" });
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("skips when there is no issue/PR to comment on", async () => {
    const { ctx, octokit, toolState } = makeCtx();
    const result = await reportProgress(ctx, { body: "no target" });

    expect(result).toEqual({ body: "no target", action: "skipped" });
    expect(toolState.lastProgressBody).toBe("no target");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("creates a fresh comment and retargets tool state when none exists", async () => {
    const { ctx, octokit, toolState } = makeCtx({ event: { issue_number: 7 } });
    const result = await reportProgress(ctx, { body: "first write" });

    expect(result.action).toBe("created");
    expect(result.commentId).toBe(101);
    expect(toolState.progressComment).toEqual({ id: 101, type: "issue" });
    expect(toolState.wasUpdated).toBe(true);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7 }),
    );
    expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  });

  it("liveProgress creation writes the comment without flipping wasUpdated", async () => {
    const { ctx, octokit, toolState } = makeCtx({ event: { issue_number: 7 } });
    octokit.rest.issues.createComment.mockResolvedValueOnce({
      data: { id: 101, node_id: "NODE_101", html_url: "https://gh/comment/101", body: null },
    });
    const result = await reportProgress(ctx, { body: "live checklist", liveProgress: true });

    expect(result.action).toBe("created");
    expect(result.body).toBe("");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(toolState.progressComment).toEqual({ id: 101, type: "issue" });
    expect(toolState.wasUpdated).toBeUndefined();
    expect(toolState.lastProgressBody).toBeUndefined();
  });

  it("updates with an empty result body fall back to an empty string", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
      event: { issue_number: 7 },
    });
    octokit.rest.issues.updateComment.mockResolvedValueOnce({
      data: {
        id: 9,
        node_id: undefined,
        html_url: "https://gh/comment/9",
        body: null,
        updated_at: "2026-06-10T00:00:00Z",
      },
    });
    const result = await reportProgress(ctx, { body: "x" });

    expect(result.action).toBe("updated");
    expect(result.body).toBe("");
  });

  it("plan mode creation does create-then-update with the implement link", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { selectedMode: "Plan" },
      event: { issue_number: 7 },
    });
    const result = await reportProgress(ctx, { body: "the plan" });

    expect(result.action).toBe("created");
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledTimes(1);
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).toContain("Implement plan");
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { planCommentNodeId: "NODE_101" });
  });

  it("plan mode creation without a node_id skips the workflow-run patch", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { selectedMode: "Plan" },
      event: { issue_number: 7 },
    });
    octokit.rest.issues.updateComment.mockResolvedValueOnce({
      data: {
        id: 101,
        node_id: undefined,
        html_url: "https://gh/comment/101",
        body: null,
        updated_at: "2026-06-10T00:00:00Z",
      },
    });
    const result = await reportProgress(ctx, { body: "the plan" });

    expect(result.action).toBe("created");
    expect(result.body).toBe("");
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
  });

  it("404 on a stale review comment falls back to a fresh top-level comment", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 33, type: "review" } },
      event: { issue_number: 7 },
    });
    octokit.rest.pulls.updateReviewComment.mockRejectedValueOnce(new Error("Not Found"));
    octokit.rest.issues.createComment.mockResolvedValueOnce({
      data: { id: 101, node_id: "NODE_101", html_url: "https://gh/comment/101", body: null },
    });
    const result = await reportProgress(ctx, { body: "final answer" });

    expect(result.action).toBe("created");
    expect(result.commentId).toBe(101);
    expect(result.body).toBe("");
    expect(toolState.progressComment).toEqual({ id: 101, type: "issue" });
    expect(toolState.wasUpdated).toBe(true);
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 7 }),
    );
  });

  it("liveProgress 404 on a review comment rethrows instead of falling back", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 33, type: "review" } },
      event: { issue_number: 7 },
    });
    octokit.rest.pulls.updateReviewComment.mockRejectedValueOnce(new Error("Not Found"));

    await expect(reportProgress(ctx, { body: "checklist", liveProgress: true })).rejects.toThrow(
      "Not Found",
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("404 on an issue-type progress comment rethrows", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
      event: { issue_number: 7 },
    });
    octokit.rest.issues.updateComment.mockRejectedValueOnce(new Error("Not Found"));

    await expect(reportProgress(ctx, { body: "x" })).rejects.toThrow("Not Found");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("non-404 errors on a review comment rethrow", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 33, type: "review" } },
      event: { issue_number: 7 },
    });
    octokit.rest.pulls.updateReviewComment.mockRejectedValueOnce(new Error("rate limited"));

    await expect(reportProgress(ctx, { body: "x" })).rejects.toThrow("rate limited");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("404 with no issue number to fall back to rethrows", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { progressComment: { id: 33, type: "review" } },
    });
    octokit.rest.pulls.updateReviewComment.mockRejectedValueOnce(new Error("Not Found"));

    await expect(reportProgress(ctx, { body: "x" })).rejects.toThrow("Not Found");
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it("target_plan_comment updates the stored plan comment with the implement link", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { existingPlanCommentId: 88, selectedMode: "Plan" },
      event: { issue_number: 7 },
    });
    const result = await reportProgress(ctx, { body: "revised plan", target_plan_comment: true });

    expect(result.action).toBe("updated");
    expect(toolState.wasUpdated).toBe(true);
    expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 88 }),
    );
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).toContain("comment_id=88");
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { planCommentNodeId: "NODE_101" });
  });

  it("target_plan_comment without issue number omits the link and patch", async () => {
    const { ctx, octokit } = makeCtx({
      toolState: { existingPlanCommentId: 88 },
    });
    const result = await reportProgress(ctx, { body: "revised plan", target_plan_comment: true });

    expect(result.action).toBe("updated");
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
    const updateBody = octokit.rest.issues.updateComment.mock.calls[0]?.[0] as { body: string };
    expect(updateBody.body).not.toContain("Implement plan");
  });

  it("target_plan_comment liveProgress writes do not flip wasUpdated", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { existingPlanCommentId: 88 },
    });
    octokit.rest.issues.updateComment.mockResolvedValueOnce({
      data: {
        id: 88,
        node_id: undefined,
        html_url: "https://gh/comment/88",
        body: null,
        updated_at: "2026-06-10T00:00:00Z",
      },
    });
    const result = await reportProgress(ctx, {
      body: "live",
      target_plan_comment: true,
      liveProgress: true,
    });

    expect(result.action).toBe("updated");
    expect(result.body).toBe("");
    expect(toolState.wasUpdated).toBeUndefined();
    expect(toolState.lastProgressBody).toBeUndefined();
  });

  it("target_plan_comment without a stored plan comment warns and falls through", async () => {
    const { ctx, octokit, toolState } = makeCtx({ event: { issue_number: 7 } });
    const result = await reportProgress(ctx, { body: "plan", target_plan_comment: true });

    expect(result.action).toBe("created");
    expect(toolState.progressComment).toEqual({ id: 101, type: "issue" });
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  });
});

describe("ReportProgressTool", () => {
  function makeTodoTracker(collapsible: string) {
    return {
      cancel: vi.fn(),
      settled: vi.fn(async () => undefined),
      renderCollapsible: vi.fn(() => collapsible),
    };
  }

  it("appends the completed task list and marks finalSummaryWritten", async () => {
    const tracker = makeTodoTracker("<details>tasks</details>");
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { todoTracker: tracker as unknown as ToolState["todoTracker"] },
      event: { issue_number: 7 },
    });
    const result = await runTool(ReportProgressTool(ctx), { body: "done" });

    expect(result.isError).toBeUndefined();
    expect(tracker.cancel).toHaveBeenCalledTimes(1);
    expect(tracker.settled).toHaveBeenCalledTimes(1);
    expect(tracker.renderCollapsible).toHaveBeenCalledWith({ completeInProgress: true });
    const createBody = octokit.rest.issues.createComment.mock.calls[0]?.[0] as { body: string };
    expect(createBody.body).toContain("done\n\n<details>tasks</details>");
    expect(toolState.finalSummaryWritten).toBe(true);
  });

  it("skips the collapsible when the tracker renders nothing", async () => {
    const tracker = makeTodoTracker("");
    const { ctx, octokit } = makeCtx({
      toolState: { todoTracker: tracker as unknown as ToolState["todoTracker"] },
      event: { issue_number: 7 },
    });
    await runTool(ReportProgressTool(ctx), { body: "done" });

    const createBody = octokit.rest.issues.createComment.mock.calls[0]?.[0] as { body: string };
    expect(createBody.body).not.toContain("<details>");
  });

  it("returns the no-comment message when reporting is skipped", async () => {
    const { ctx, toolState } = makeCtx({ event: { silent: true } });
    const result = await runTool(ReportProgressTool(ctx), { body: "quiet" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no GitHub comment created");
    expect(toolState.finalSummaryWritten).toBeUndefined();
  });

  it("plan revisions do not touch the todo tracker or finalSummaryWritten", async () => {
    const tracker = makeTodoTracker("<details>tasks</details>");
    const { ctx, toolState } = makeCtx({
      toolState: {
        todoTracker: tracker as unknown as ToolState["todoTracker"],
        existingPlanCommentId: 88,
      },
      event: { issue_number: 7 },
    });
    const result = await runTool(ReportProgressTool(ctx), {
      body: "revised",
      target_plan_comment: true,
    });

    expect(result.isError).toBeUndefined();
    expect(tracker.cancel).not.toHaveBeenCalled();
    expect(toolState.finalSummaryWritten).toBeUndefined();
  });
});

describe("deleteProgressComment", () => {
  it("deletes an issue-type comment, nulls tool state, and returns true", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
    });
    await expect(deleteProgressComment(ctx)).resolves.toBe(true);

    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 9 }),
    );
    expect(toolState.progressComment).toBeNull();
  });

  it("routes review-type comments to the review endpoint", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 33, type: "review" } },
    });
    await expect(deleteProgressComment(ctx)).resolves.toBe(true);

    expect(octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 33 }),
    );
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
    expect(toolState.progressComment).toBeNull();
  });

  it("returns false when no progress comment exists", async () => {
    const { ctx, octokit } = makeCtx();
    await expect(deleteProgressComment(ctx)).resolves.toBe(false);
    expect(octokit.rest.issues.deleteComment).not.toHaveBeenCalled();
  });

  it("returns false when the comment was already deliberately deleted", async () => {
    const { ctx } = makeCtx({ toolState: { progressComment: null } });
    await expect(deleteProgressComment(ctx)).resolves.toBe(false);
  });

  it("swallows a 404 (already deleted) and still nulls tool state", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
    });
    octokit.rest.issues.deleteComment.mockRejectedValueOnce(new Error("Not Found"));

    await expect(deleteProgressComment(ctx)).resolves.toBe(true);
    expect(toolState.progressComment).toBeNull();
  });

  it("rethrows non-404 errors and leaves tool state untouched", async () => {
    const { ctx, octokit, toolState } = makeCtx({
      toolState: { progressComment: { id: 9, type: "issue" } },
    });
    octokit.rest.issues.deleteComment.mockRejectedValueOnce(new Error("forbidden"));

    await expect(deleteProgressComment(ctx)).rejects.toThrow("forbidden");
    expect(toolState.progressComment).toEqual({ id: 9, type: "issue" });
  });
});
