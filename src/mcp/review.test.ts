import { afterEach, describe, expect, it, vi } from "vitest";

// Unwrap the ToolResult envelope so the CreatePullRequestReviewTool tests can
// assert on the raw object the tool returns (and see thrown errors as
// rejections instead of encoded error text).
vi.mock("#app/mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/mcp/shared")>();
  return {
    ...actual,
    execute: <T, R>(fn: (params: T) => Promise<R>): ((params: T) => Promise<R>) => fn,
  };
});

import {
  buildCommentableMap,
  type CommentableLines,
  CreatePullRequestReviewTool,
  clearStrandedPendingReview,
  commentableLinesForFile,
  createReviewWithStrandedRecovery,
  type DroppedComment,
  duplicateReviewDecision,
  formatDroppedCommentsNote,
  isTransientReviewError,
  MAX_DROPPED_COMMENT_LINES,
  type ReviewCommentInput,
  reviewSkipDecision,
  validateInlineComments,
} from "#app/mcp/review";
import type { ToolContext } from "#app/mcp/server";

describe("commentableLinesForFile", () => {
  it("returns empty sets for missing patches (binary or no changes)", () => {
    const result = commentableLinesForFile(undefined);
    expect(result.LEFT.size).toBe(0);
    expect(result.RIGHT.size).toBe(0);
  });

  it("collects added lines on RIGHT, removed lines on LEFT, context on both", () => {
    const patch = ["@@ -10,3 +10,4 @@", " ctx1", "-old", "+new", "+new2", " ctx2"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect([...LEFT].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect([...RIGHT].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
  });

  it("handles multiple hunks", () => {
    const patch = ["@@ -1,2 +1,2 @@", " a", "-b", "+B", "@@ -20,1 +20,2 @@", " x", "+y"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(RIGHT.has(2)).toBe(true); // +B
    expect(RIGHT.has(21)).toBe(true); // +y
    expect(LEFT.has(2)).toBe(true); // -b
    expect(LEFT.has(20)).toBe(true); // context x
    expect(RIGHT.has(20)).toBe(true); // context x
  });

  it("ignores the 'no newline at end of file' marker", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-old", "\\ No newline at end of file", "+new"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(LEFT.has(1)).toBe(true);
    expect(RIGHT.has(1)).toBe(true);
    expect(LEFT.size).toBe(1);
    expect(RIGHT.size).toBe(1);
  });

  it("parses hunk headers without explicit counts", () => {
    // single-line hunks can omit ",<count>"
    const patch = ["@@ -5 +5 @@", "-old", "+new"].join("\n");
    const { LEFT, RIGHT } = commentableLinesForFile(patch);
    expect(LEFT.has(5)).toBe(true);
    expect(RIGHT.has(5)).toBe(true);
  });
});

function buildMap(entries: Array<[string, string]>): Map<string, CommentableLines> {
  const map = new Map<string, CommentableLines>();
  for (const [file, patch] of entries) {
    map.set(file, commentableLinesForFile(patch));
  }
  return map;
}

describe("validateInlineComments", () => {
  const patch = ["@@ -10,2 +10,3 @@", " ctx", "-old", "+new", "+new2"].join("\n");
  const diffMap = buildMap([["src/foo.ts", patch]]);

  const base = (overrides: Partial<ReviewCommentInput>): ReviewCommentInput => ({
    path: "src/foo.ts",
    line: 11,
    side: "RIGHT",
    body: "LGTM",
    ...overrides,
  });

  it("keeps comments anchored to added lines on RIGHT", () => {
    const result = validateInlineComments([base({ line: 12 })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("keeps comments anchored to removed lines on LEFT", () => {
    const result = validateInlineComments([base({ line: 11, side: "LEFT" })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops comments on files not in the diff", () => {
    const result = validateInlineComments([base({ path: "other/bar.ts" })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toContain("file not in PR diff");
  });

  it("distinguishes binary/no-patch files from files with hunks", () => {
    // file present in the PR but with no patch data (binary file).
    const binaryMap = buildMap([
      ["src/foo.ts", patch],
      ["assets/logo.png", undefined as unknown as string],
    ]);
    const result = validateInlineComments([base({ path: "assets/logo.png", line: 1 })], binaryMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toContain("no textual diff");
    expect(result.dropped[0]!.reason).not.toContain("not inside a diff hunk");
  });

  it("drops comments on lines outside diff hunks", () => {
    const result = validateInlineComments([base({ line: 500 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toContain("line 500");
    expect(result.dropped[0]!.reason).toContain("RIGHT");
  });

  it("drops comments whose side mismatches the hunk (added line on LEFT)", () => {
    // line 12 is "+new" — only in RIGHT. Asking for it on LEFT should drop.
    const result = validateInlineComments([base({ line: 12, side: "LEFT" })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops multi-line comments where start_line is out of range", () => {
    const result = validateInlineComments([base({ line: 12, start_line: 3 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toContain("start_line 3");
  });

  it("keeps multi-line comments fully inside a hunk", () => {
    const result = validateInlineComments([base({ line: 12, start_line: 11 })], diffMap);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops inverted ranges (start_line > line) with a precise reason", () => {
    // both 11 and 12 anchor in the hunk, but GitHub 422s with "invalid line
    // numbers" when start_line > line. dropping locally avoids the opaque
    // remote failure and tells the agent exactly what to fix.
    const result = validateInlineComments([base({ line: 11, start_line: 12 })], diffMap);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.reason).toMatch(/start_line 12 is after line 11/);
    expect(result.dropped[0]!.reason).toMatch(/start_line <= line/);
  });

  it("partitions a batch — valid and invalid comments survive independently", () => {
    const result = validateInlineComments(
      [base({ line: 12 }), base({ line: 9999 }), base({ path: "missing.ts" })],
      diffMap,
    );
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
  });

  it("defaults side to RIGHT when omitted", () => {
    const result = validateInlineComments([{ path: "src/foo.ts", line: 12, body: "" }], diffMap);
    expect(result.valid).toHaveLength(1);
  });
});

describe("formatDroppedCommentsNote", () => {
  it("renders single-line dropped entries with `path:line`", () => {
    const dropped: DroppedComment[] = [
      {
        path: "src/foo.ts",
        line: 42,
        side: "RIGHT",
        reason: "line 42 (RIGHT) is not inside a diff hunk",
      },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("**Note:** 1 inline comment(s) dropped");
    expect(note).toContain("`src/foo.ts:42` (RIGHT)");
    expect(note).toContain("line 42 (RIGHT) is not inside a diff hunk");
  });

  it("renders multi-line dropped entries with `path:start-end`", () => {
    const dropped: DroppedComment[] = [
      {
        path: "src/bar.ts",
        line: 20,
        startLine: 15,
        side: "LEFT",
        reason: "start_line 15 (LEFT) is not inside a diff hunk",
      },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("`src/bar.ts:15-20` (LEFT)");
  });

  it("falls back to single-line format when startLine equals line", () => {
    const dropped: DroppedComment[] = [
      { path: "src/baz.ts", line: 7, startLine: 7, side: "RIGHT", reason: "file not in PR diff" },
    ];
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain("`src/baz.ts:7` (RIGHT)");
    expect(note).not.toContain("7-7");
  });

  it("caps detail lines and reports the remainder so body stays under GitHub's size limit", () => {
    const overflow = MAX_DROPPED_COMMENT_LINES + 7;
    const dropped: DroppedComment[] = Array.from({ length: overflow }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      side: "RIGHT" as const,
      reason: "file not in PR diff",
    }));
    const note = formatDroppedCommentsNote(dropped);
    expect(note).toContain(`**Note:** ${overflow} inline comment(s) dropped`);
    // still reports the full count in the header
    expect(note).toContain(`${overflow} inline comment(s)`);
    // first entry shown, last entry elided
    expect(note).toContain("`src/file0.ts:1` (RIGHT)");
    expect(note).not.toContain(`src/file${overflow - 1}.ts`);
    expect(note).toContain("…and 7 more dropped comment(s) not shown");
  });

  it("does not add a truncation line when drops fit under the cap", () => {
    const dropped: DroppedComment[] = Array.from({ length: MAX_DROPPED_COMMENT_LINES }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      side: "RIGHT" as const,
      reason: "file not in PR diff",
    }));
    const note = formatDroppedCommentsNote(dropped);
    expect(note).not.toContain("more dropped comment(s) not shown");
  });
});

describe("reviewSkipDecision", () => {
  // GitHub 422s `event: "COMMENT"` reviews with no body + no comments
  // ("{\"message\":\"Unprocessable Entity\",\"errors\":[\"\"]}"). verified
  // empirically against repos/terramend/preview-546-run-issues-fixes/pulls/1
  // with and without commit_id set. the skip function must return a decision
  // for every shape that lands on that API call.

  it("skips with 'no-issues' when !approved + empty body + no comments", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
    expect(decision?.reason).toContain("nothing to post");
  });

  it("treats null body the same as empty string", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: null,
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
  });

  it("treats undefined body the same as empty string", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: undefined,
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision?.kind).toBe("no-issues");
  });

  it("skips with 'empty-downgraded-approve' when approved + !prApproveEnabled + empty", () => {
    // this is the F3 regression case — agent requests APPROVE, runtime
    // downgrades to COMMENT (prApproveEnabled off), and the empty COMMENT
    // 422s at GitHub. before this fix, the tool returned a stranded-success
    // shape that didn't map to any persisted review.
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: false,
      prApproveEnabled: false,
    });
    expect(decision?.kind).toBe("empty-downgraded-approve");
    expect(decision?.reason).toContain("prApproveEnabled is disabled");
  });

  it("does NOT skip legitimate bare APPROVE (approved + prApproveEnabled + empty)", () => {
    // GitHub accepts empty APPROVE reviews — the stamp itself is the content.
    // skipping here would silently drop agents' real approvals.
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when body is present (no-issues path)", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "found some issues",
      hasComments: false,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when body is present (downgrade path)", () => {
    // approved+!prApproveEnabled with a body becomes a real COMMENT review
    // (downgrade + body). GitHub accepts those; don't skip.
    const decision = reviewSkipDecision({
      approved: true,
      body: "nits follow",
      hasComments: false,
      prApproveEnabled: false,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when comments are present (no-issues path)", () => {
    const decision = reviewSkipDecision({
      approved: false,
      body: "",
      hasComments: true,
      prApproveEnabled: true,
    });
    expect(decision).toBeNull();
  });

  it("does NOT skip when comments are present (downgrade path)", () => {
    const decision = reviewSkipDecision({
      approved: true,
      body: "",
      hasComments: true,
      prApproveEnabled: false,
    });
    expect(decision).toBeNull();
  });
});

describe("duplicateReviewDecision", () => {
  // regression: colinhacks/zod#5897 had two reviews submitted from the same
  // workflow run 8 seconds apart — a substantive review followed by an empty
  // "No new issues found." follow-up. the agent re-classified the first
  // review's non-blocking observations as "no actionable issues" and
  // submitted the canonical body per modes.ts. this guard makes the second
  // call a no-op without burning a GitHub API call or polluting the PR.

  it("allows the first submission when no prior review exists", () => {
    const decision = duplicateReviewDecision({
      existing: undefined,
      currentCheckoutSha: "sha1",
    });
    expect(decision).toBeNull();
  });

  it("blocks a second submission when checkoutSha matches the prior reviewedSha", () => {
    // exact reproduction of the zod#5897 shape: same session, same checked-out
    // SHA, second create_pull_request_review call.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha1" },
      currentCheckoutSha: "sha1",
    });
    expect(decision?.kind).toBe("already-submitted");
    expect(decision?.reviewId).toBe(100);
    expect(decision?.reason).toContain("already submitted");
    expect(decision?.reason).toContain("checkout_pr");
  });

  it("allows a follow-up when checkoutSha advanced past the prior reviewedSha", () => {
    // the new-commits-mid-review path advances toolState.checkoutSha to the
    // new HEAD before returning, and the agent is told to call checkout_pr
    // again — both paths leave checkoutSha != reviewedSha. those are real
    // follow-up reviews and must go through.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha-old" },
      currentCheckoutSha: "sha-new",
    });
    expect(decision).toBeNull();
  });

  it("blocks when checkoutSha is missing — cannot prove the SHA moved", () => {
    // if the agent never called checkout_pr, we have no anchor to compare
    // against. assume duplicate rather than letting a second review through
    // — the prior review still satisfies the agent's intent.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: "sha1" },
      currentCheckoutSha: undefined,
    });
    expect(decision?.kind).toBe("already-submitted");
  });

  it("blocks when prior reviewedSha is missing — cannot prove the SHA moved", () => {
    // belt-and-suspenders: if for any reason the prior review didn't capture
    // a reviewedSha, treat the second call as a duplicate to be safe.
    const decision = duplicateReviewDecision({
      existing: { id: 100, reviewedSha: undefined },
      currentCheckoutSha: "sha1",
    });
    expect(decision?.kind).toBe("already-submitted");
  });
});

// --- network-boundary helpers (fake octokit) --------------------------------

function octokitErr(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const TRANSIENT_422 = () => octokitErr(422, "An internal error occurred, please try again.");

function makeCtx(over: Record<string, unknown> = {}): ToolContext {
  return {
    agentId: "claude",
    repo: { owner: "octo", name: "repo" },
    prApproveEnabled: true,
    payload: {},
    toolState: {},
    octokit: {},
    ...over,
  } as unknown as ToolContext;
}

describe("isTransientReviewError", () => {
  it("matches only GitHub's generic 422 'internal error' body", () => {
    expect(isTransientReviewError(TRANSIENT_422())).toBe(true);
  });

  it("rejects a 422 that cites a specific cause", () => {
    expect(isTransientReviewError(octokitErr(422, "Validation Failed: invalid line"))).toBe(false);
  });

  it("rejects other statuses and non-error values", () => {
    expect(
      isTransientReviewError(octokitErr(500, "An internal error occurred, please try again.")),
    ).toBe(false);
    expect(isTransientReviewError(new Error("plain"))).toBe(false);
    expect(isTransientReviewError(null)).toBe(false);
    expect(isTransientReviewError("string")).toBe(false);
  });
});

describe("clearStrandedPendingReview", () => {
  const params = (originalErr: unknown) => ({
    owner: "octo",
    repo: "repo",
    pull_number: 7,
    originalErr,
  });

  it("rethrows the original error when it is not a pending-review 422", async () => {
    const original = octokitErr(500, "server exploded");
    await expect(clearStrandedPendingReview(makeCtx(), params(original))).rejects.toBe(original);

    const wrong422 = octokitErr(422, "Validation Failed");
    await expect(clearStrandedPendingReview(makeCtx(), params(wrong422))).rejects.toBe(wrong422);
  });

  it("deletes the leftover PENDING review and resolves", async () => {
    const deletePendingReview = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      octokit: {
        paginate: vi.fn().mockResolvedValue([
          { id: 1, state: "COMMENTED" },
          { id: 9, state: "PENDING" },
        ]),
        rest: { pulls: { listReviews: vi.fn(), deletePendingReview } },
      },
    });

    const original = octokitErr(422, "User can only have one pending review per pull request");
    await expect(clearStrandedPendingReview(ctx, params(original))).resolves.toBeUndefined();
    expect(deletePendingReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7, review_id: 9 }),
    );
  });

  it("rethrows the original when no PENDING leftover exists", async () => {
    const ctx = makeCtx({
      octokit: {
        paginate: vi.fn().mockResolvedValue([{ id: 1, state: "COMMENTED" }]),
        rest: { pulls: { listReviews: vi.fn(), deletePendingReview: vi.fn() } },
      },
    });
    const original = octokitErr(422, "already has a pending review");
    await expect(clearStrandedPendingReview(ctx, params(original))).rejects.toBe(original);
  });

  it("surfaces the original 422 when listReviews itself fails", async () => {
    const ctx = makeCtx({
      octokit: {
        paginate: vi.fn().mockRejectedValue(octokitErr(502, "bad gateway")),
        rest: { pulls: { listReviews: vi.fn(), deletePendingReview: vi.fn() } },
      },
    });
    const original = octokitErr(422, "already has a pending review");
    await expect(clearStrandedPendingReview(ctx, params(original))).rejects.toBe(original);
  });

  it("swallows a 404/422 from the delete but rethrows anything else", async () => {
    const mk = (deleteErr: Error) =>
      makeCtx({
        octokit: {
          paginate: vi.fn().mockResolvedValue([{ id: 9, state: "PENDING" }]),
          rest: {
            pulls: {
              listReviews: vi.fn(),
              deletePendingReview: vi.fn().mockRejectedValue(deleteErr),
            },
          },
        },
      });
    const original = octokitErr(422, "already has a pending review");

    await expect(
      clearStrandedPendingReview(mk(octokitErr(404, "gone")), params(original)),
    ).resolves.toBeUndefined();
    await expect(
      clearStrandedPendingReview(mk(octokitErr(422, "already submitted")), params(original)),
    ).resolves.toBeUndefined();

    const hardErr = octokitErr(500, "delete exploded");
    await expect(clearStrandedPendingReview(mk(hardErr), params(original))).rejects.toBe(hardErr);
  });
});

describe("createReviewWithStrandedRecovery", () => {
  const params = {
    owner: "octo",
    repo: "repo",
    pull_number: 7,
    event: "COMMENT",
  } as Parameters<typeof createReviewWithStrandedRecovery>[1];

  it("passes a first-try success straight through", async () => {
    const response = { data: { id: 1 } };
    const createReview = vi.fn().mockResolvedValue(response);
    const ctx = makeCtx({ octokit: { rest: { pulls: { createReview } } } });

    await expect(createReviewWithStrandedRecovery(ctx, params)).resolves.toBe(response);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("clears a stranded pending draft and retries once", async () => {
    const response = { data: { id: 2 } };
    const createReview = vi
      .fn()
      .mockRejectedValueOnce(octokitErr(422, "user already has a pending review"))
      .mockResolvedValueOnce(response);
    const deletePendingReview = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      octokit: {
        paginate: vi.fn().mockResolvedValue([{ id: 9, state: "PENDING" }]),
        rest: { pulls: { createReview, listReviews: vi.fn(), deletePendingReview } },
      },
    });

    await expect(createReviewWithStrandedRecovery(ctx, params)).resolves.toBe(response);
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(deletePendingReview).toHaveBeenCalledTimes(1);
  });
});

describe("buildCommentableMap", () => {
  it("reuses the checkout snapshot when PR number and sha both match", async () => {
    const cached = buildMap([["src/foo.ts", "@@ -1 +1 @@\n+x"]]);
    const paginate = vi.fn();
    const ctx = makeCtx({
      octokit: { paginate, rest: { pulls: { listFiles: vi.fn() } } },
      toolState: {
        commentableLinesByFile: cached,
        commentableLinesPullNumber: 5,
        commentableLinesCheckoutSha: "sha1",
        checkoutSha: "sha1",
      },
    });

    await expect(buildCommentableMap(ctx, 5)).resolves.toBe(cached);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("refetches when the cache was built for a different sha", async () => {
    const cached = buildMap([["stale.ts", "@@ -1 +1 @@\n+x"]]);
    const paginate = vi.fn().mockResolvedValue([
      { filename: "src/foo.ts", patch: "@@ -1 +1,2 @@\n+a\n+b" },
      { filename: "assets/logo.png" }, // no patch — binary
    ]);
    const ctx = makeCtx({
      octokit: { paginate, rest: { pulls: { listFiles: vi.fn() } } },
      toolState: {
        commentableLinesByFile: cached,
        commentableLinesPullNumber: 5,
        commentableLinesCheckoutSha: "old-sha",
        checkoutSha: "new-sha",
      },
    });

    const map = await buildCommentableMap(ctx, 5);
    expect(map).not.toBe(cached);
    expect(map.get("src/foo.ts")?.RIGHT.has(2)).toBe(true);
    expect(map.get("assets/logo.png")?.RIGHT.size).toBe(0);
  });
});

describe("CreatePullRequestReviewTool", () => {
  const FULL_SHA = "a".repeat(40);
  const patch = ["@@ -10,2 +10,3 @@", " ctx", "-old", "+new", "+new2"].join("\n");

  type RawResult = Record<string, unknown>;
  function runTool(
    toolDef: { execute: unknown },
    params: Record<string, unknown>,
  ): Promise<RawResult> {
    const fn = toolDef.execute as (p: Record<string, unknown>) => Promise<RawResult>;
    return fn(params);
  }

  /** toolState pre-seeded with a commentable-lines snapshot for PR 5 @ sha1. */
  const snapshotState = (over: Record<string, unknown> = {}) => ({
    commentableLinesByFile: buildMap([["src/foo.ts", patch]]),
    commentableLinesPullNumber: 5,
    commentableLinesCheckoutSha: "sha1",
    checkoutSha: "sha1",
    ...over,
  });

  const reviewResponse = (id: number) => ({
    data: {
      id,
      node_id: `node-${id}`,
      html_url: `https://github.test/review/${id}`,
      state: "COMMENTED",
      user: { login: "terramend[bot]" },
      submitted_at: "2026-06-10T00:00:00Z",
    },
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("short-circuits a duplicate submission in the same session", async () => {
    const createReview = vi.fn();
    const ctx = makeCtx({
      toolState: { review: { id: 100, reviewedSha: "sha1" }, checkoutSha: "sha1" },
      octokit: { rest: { pulls: { createReview } } },
    });

    const result = await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      body: "second call",
    });

    expect(result).toMatchObject({ success: true, skipped: true, reviewId: 100 });
    expect(createReview).not.toHaveBeenCalled();
    expect(ctx.toolState.issueNumber).toBe(5);
  });

  it("skips an empty non-approve review before any GitHub call", async () => {
    const ctx = makeCtx({ octokit: {} });
    const result = await runTool(CreatePullRequestReviewTool(ctx), { pull_number: 5 });
    expect(result).toMatchObject({ success: true, skipped: true });
    expect(result.reason).toMatch(/nothing to post/);
  });

  it("drops invalid comments and posts the dropped-comments note as the review body", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 60 } });
    const submitReview = vi.fn().mockResolvedValue(reviewResponse(60));
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: { rest: { pulls: { createReview, submitReview } } },
    });

    const result = await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      commit_id: FULL_SHA,
      comments: [{ path: "not-in-diff.ts", line: 1, body: "x" }],
    });

    expect(result).toMatchObject({ success: true, reviewId: 60 });
    expect(result.droppedComments).toHaveLength(1);
    // the dropped set is surfaced in the posted body, and the invalid comment
    // never reaches GitHub.
    const submitted = submitReview.mock.calls[0]?.[0] as { body: string };
    expect(submitted.body).toContain("**Note:** 1 inline comment(s) dropped");
    expect(createReview.mock.calls[0]?.[0]).toMatchObject({ comments: [] });
  });

  it("submits a comments-only review, rendering suggestions and multi-line ranges", async () => {
    const createReview = vi.fn().mockResolvedValue(reviewResponse(42));
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: { rest: { pulls: { createReview } } },
    });

    const result = await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      commit_id: FULL_SHA,
      comments: [
        { path: "src/foo.ts", line: 12, start_line: 11, suggestion: "  fixed();", body: "tidy" },
      ],
    });

    expect(result).toMatchObject({ success: true, reviewId: 42, state: "COMMENTED" });
    expect(result.droppedComments).toBeUndefined();
    expect(ctx.toolState.review).toEqual({ id: 42, nodeId: "node-42", reviewedSha: "sha1" });
    expect(ctx.toolState.wasUpdated).toBe(true);

    expect(createReview).toHaveBeenCalledTimes(1);
    const sent = createReview.mock.calls[0]?.[0] as {
      event: string;
      commit_id: string;
      comments: Array<Record<string, unknown>>;
    };
    expect(sent.event).toBe("COMMENT");
    expect(sent.commit_id).toBe(FULL_SHA);
    expect(sent.comments[0]).toMatchObject({
      path: "src/foo.ts",
      line: 12,
      start_line: 11,
      side: "RIGHT",
      start_side: "RIGHT",
    });
    expect(String(sent.comments[0]?.body)).toContain("tidy\n\n```suggestion\n  fixed();\n```");
  });

  it("submits a body review via pending+submit, appending the Fix-it footer", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 7 } });
    const submitReview = vi.fn().mockResolvedValue(reviewResponse(7));
    const pulls = {
      createReview,
      submitReview,
      get: vi.fn().mockResolvedValue({ data: { head: { sha: "sha1" } } }),
    };
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: { rest: { pulls } },
    });

    const result = await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      body: "Found two issues.",
    });

    expect(result).toMatchObject({ success: true, reviewId: 7 });
    // pending draft created WITHOUT the event…
    expect(createReview.mock.calls[0]?.[0]).not.toHaveProperty("event");
    // …then submitted with it, body + footer affordance included.
    const submitted = submitReview.mock.calls[0]?.[0] as { event: string; body: string };
    expect(submitted.event).toBe("COMMENT");
    expect(submitted.body).toContain("Found two issues.");
    expect(submitted.body).toContain("Fix it ➔");
  });

  it("downgrades APPROVE to COMMENT when prApproveEnabled is off (no Fix footer)", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 8 } });
    const submitReview = vi.fn().mockResolvedValue(reviewResponse(8));
    const ctx = makeCtx({
      prApproveEnabled: false,
      toolState: snapshotState(),
      octokit: {
        rest: {
          pulls: {
            createReview,
            submitReview,
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "sha1" } } }),
          },
        },
      },
    });

    await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      body: "nits follow",
      approved: true,
    });

    const submitted = submitReview.mock.calls[0]?.[0] as { event: string; body: string };
    expect(submitted.event).toBe("COMMENT");
    // approving reviews suppress Fix buttons even after the downgrade.
    expect(submitted.body).not.toContain("Fix it ➔");
  });

  it("cleans up the pending draft when the submit step fails", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 7 } });
    const submitErr = octokitErr(500, "submit exploded");
    const submitReview = vi.fn().mockRejectedValue(submitErr);
    const deletePendingReview = vi.fn().mockResolvedValue({});
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: {
        rest: {
          pulls: {
            createReview,
            submitReview,
            deletePendingReview,
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "sha1" } } }),
          },
        },
      },
    });

    await expect(
      runTool(CreatePullRequestReviewTool(ctx), { pull_number: 5, body: "B" }),
    ).rejects.toBe(submitErr);
    expect(deletePendingReview).toHaveBeenCalledWith(expect.objectContaining({ review_id: 7 }));
  });

  it("reports new commits pushed mid-review and advances the checkout sha", async () => {
    const createReview = vi.fn().mockResolvedValue(reviewResponse(43));
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: {
        rest: {
          pulls: {
            createReview,
            get: vi.fn().mockResolvedValue({ data: { head: { sha: "sha2" } } }),
          },
        },
      },
    });

    const result = await runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      comments: [{ path: "src/foo.ts", line: 12, body: "x" }],
    });

    expect(result).toMatchObject({ success: true, reviewId: 43 });
    expect(result.newCommits).toMatchObject({ from: "sha1", to: "sha2" });
    expect(ctx.toolState.beforeSha).toBe("sha1");
    expect(ctx.toolState.checkoutSha).toBe("sha2");
    // the review anchors to the sha the agent actually analyzed.
    expect(createReview.mock.calls[0]?.[0]).toMatchObject({ commit_id: "sha1" });
  });

  it("enriches a non-transient 422 with the affected comments and GitHub's message", async () => {
    const createReview = vi.fn().mockRejectedValue(octokitErr(422, "Validation Failed: line"));
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: { rest: { pulls: { createReview } } },
    });

    await expect(
      runTool(CreatePullRequestReviewTool(ctx), {
        pull_number: 5,
        commit_id: FULL_SHA,
        comments: [{ path: "src/foo.ts", line: 12, body: "x" }],
      }),
    ).rejects.toThrow(/Affected comments: src\/foo\.ts:12 \(RIGHT\).*Validation Failed: line/s);
  });

  it("retries GitHub's transient 422 in-tool and surfaces dedicated guidance after exhaustion", async () => {
    vi.useFakeTimers();
    const createReview = vi.fn().mockImplementation(() => Promise.reject(TRANSIENT_422()));
    const ctx = makeCtx({
      toolState: snapshotState(),
      octokit: { rest: { pulls: { createReview } } },
    });

    const pending = runTool(CreatePullRequestReviewTool(ctx), {
      pull_number: 5,
      commit_id: FULL_SHA,
      comments: [{ path: "src/foo.ts", line: 12, body: "x" }],
    }).then(
      () => {
        throw new Error("expected the tool to throw");
      },
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;

    expect(String(err)).toMatch(/transient 422 "internal error".*after 3 attempts/s);
    expect(String(err)).toMatch(/Do NOT modify or drop inline comments/);
    expect(createReview).toHaveBeenCalledTimes(3);
  });

  it("nudges once about unread diff TOC regions, then lets the retry through", async () => {
    const createReview = vi.fn().mockResolvedValue(reviewResponse(50));
    const ctx = makeCtx({
      toolState: snapshotState({
        diffCoverage: {
          diffPath: "/tmp/pr.diff",
          totalLines: 10,
          tocEntries: [{ filename: "src/foo.ts", startLine: 1, endLine: 10 }],
          coveredRanges: [],
          coveragePreflightRan: false,
        },
      }),
      octokit: { rest: { pulls: { createReview } } },
    });
    const params = {
      pull_number: 5,
      commit_id: FULL_SHA,
      comments: [{ path: "src/foo.ts", line: 12, body: "x" }],
    };

    await expect(runTool(CreatePullRequestReviewTool(ctx), params)).rejects.toThrow(
      /diff coverage pre-flight.*src\/foo\.ts \(10 lines, 1-10\)/s,
    );
    // one-time nudge: the same call goes through on retry.
    const result = await runTool(CreatePullRequestReviewTool(ctx), params);
    expect(result).toMatchObject({ success: true, reviewId: 50 });
  });
});
