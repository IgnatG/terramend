import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLearningsReflectionPrompt,
  buildPostRunPrompt,
  buildStopHookPrompt,
  buildSummaryStalePrompt,
  buildUnsubmittedReviewPrompt,
  collectPostRunIssues,
  finalizeAgentResult,
  getUnsubmittedReview,
  runPostRunRetryLoop,
  shouldRunReflection,
} from "#app/agents/postRun";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  getGitStatus,
  MAX_POST_RUN_RETRIES,
} from "#app/agents/shared";
import type { ToolState } from "#app/toolState";

// getGitStatus shells out to `git status --porcelain` in the test runner's
// cwd, which is the (frequently dirty) dev checkout — mock it so the
// dirty-tree gate is deterministic. everything else stays real.
vi.mock("#app/agents/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/agents/shared")>();
  return { ...actual, getGitStatus: vi.fn(() => "") };
});

const getGitStatusMock = vi.mocked(getGitStatus);

beforeEach(() => {
  getGitStatusMock.mockReset();
  getGitStatusMock.mockReturnValue("");
});

const tempDir = mkdtempSync(join(tmpdir(), "terramend-postrun-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    progressComment: undefined,
    hadProgressComment: true,
    prepushFailureCount: 0,
    backgroundProcesses: new Map(),
    usageEntries: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolState> = {}): AgentRunContext {
  // runPostRunRetryLoop / collectPostRunIssues / finalizeAgentResult only read
  // `ctx.toolState`, so a minimal context is sufficient for these tests.
  return { toolState: makeToolState(overrides) } as unknown as AgentRunContext;
}

function makeUsage(n: number): AgentUsage {
  return { agent: "test", inputTokens: n, outputTokens: n };
}

describe("getUnsubmittedReview", () => {
  it("returns null when mode is not a review mode", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Build" }))).toBeNull();
    expect(getUnsubmittedReview(makeToolState())).toBeNull();
  });

  it("returns null when a review was already submitted", () => {
    expect(
      getUnsubmittedReview(
        makeToolState({
          selectedMode: "Review",
          review: { id: 1, nodeId: "n", reviewedSha: undefined },
        }),
      ),
    ).toBeNull();
  });

  it("fires for Review even when report_progress wrote a final summary", () => {
    // Review's only valid exit is `create_pull_request_review`. a summary
    // comment is not a substitute, and accepting it here previously let
    // subagent-flipped `finalSummaryWritten` silence the gate.
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", finalSummaryWritten: true })),
    ).toBe("Review");
  });

  it("returns null for IncrementalReview when report_progress wrote a final summary", () => {
    // IncrementalReview treats `report_progress` as a legitimate
    // "no review warranted" exit, matching the post-failure error message.
    expect(
      getUnsubmittedReview(
        makeToolState({ selectedMode: "IncrementalReview", finalSummaryWritten: true }),
      ),
    ).toBeNull();
  });

  it("returns null when there is no progress comment to anchor the failure to", () => {
    expect(
      getUnsubmittedReview(makeToolState({ selectedMode: "Review", hadProgressComment: false })),
    ).toBeNull();
  });

  it("returns the selected mode when the gate should fire", () => {
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "Review" }))).toBe("Review");
    expect(getUnsubmittedReview(makeToolState({ selectedMode: "IncrementalReview" }))).toBe(
      "IncrementalReview",
    );
  });
});

describe("buildStopHookPrompt", () => {
  it("embeds the exit code and the hook output in a fenced block", () => {
    const prompt = buildStopHookPrompt({ exitCode: 3, output: "lint failed: 2 errors" });
    expect(prompt).toContain("exited with code 3");
    expect(prompt).toContain("```\nlint failed: 2 errors\n```");
  });

  it("falls back to (no output) when the hook produced nothing", () => {
    expect(buildStopHookPrompt({ exitCode: 1, output: "" })).toContain("(no output)");
  });
});

describe("buildSummaryStalePrompt", () => {
  it("names the summary file path", () => {
    const prompt = buildSummaryStalePrompt("/tmp/run/summary.md");
    expect(prompt).toContain("PR SUMMARY UNTOUCHED");
    expect(prompt).toContain("`/tmp/run/summary.md`");
  });
});

describe("buildUnsubmittedReviewPrompt", () => {
  it("Review variant demands create_pull_request_review and offers no report_progress exit", () => {
    const prompt = buildUnsubmittedReviewPrompt("Review");
    expect(prompt).toContain("selected Review mode");
    expect(prompt).toContain("`create_pull_request_review`");
    expect(prompt).not.toContain("report_progress");
  });

  it("IncrementalReview variant offers the report_progress no-findings exit", () => {
    const prompt = buildUnsubmittedReviewPrompt("IncrementalReview");
    expect(prompt).toContain("selected IncrementalReview mode");
    expect(prompt).toContain("`create_pull_request_review`");
    expect(prompt).toContain("`report_progress`");
  });
});

describe("buildPostRunPrompt", () => {
  it("returns an empty string when there are no issues", () => {
    expect(buildPostRunPrompt({})).toBe("");
  });

  it("orders sections stopHook, unsubmittedReview, dirtyTree, summaryStale", () => {
    const prompt = buildPostRunPrompt({
      stopHook: { exitCode: 2, output: "hook says no" },
      unsubmittedReview: "Review",
      dirtyTree: "M src/index.ts",
      summaryStale: { filePath: "/tmp/summary.md" },
    });
    const hook = prompt.indexOf("STOP HOOK FAILED");
    const review = prompt.indexOf("MISSING REVIEW OUTPUT");
    const tree = prompt.indexOf("UNCOMMITTED CHANGES");
    const summary = prompt.indexOf("PR SUMMARY UNTOUCHED");
    expect(hook).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(hook);
    expect(tree).toBeGreaterThan(review);
    expect(summary).toBeGreaterThan(tree);
    expect(prompt).toContain("\n\n---\n\n");
  });

  it("renders a single section without separators", () => {
    const prompt = buildPostRunPrompt({ dirtyTree: "?? new-file.txt" });
    expect(prompt).toContain("?? new-file.txt");
    expect(prompt).not.toContain("---");
  });
});

describe("collectPostRunIssues", () => {
  it("flags a dirty tree in a committing mode", async () => {
    getGitStatusMock.mockReturnValue("M src/a.ts");
    const issues = await collectPostRunIssues(makeCtx({ selectedMode: "Build" }));
    expect(issues.dirtyTree).toBe("M src/a.ts");
  });

  it("flags a dirty tree when no mode was selected", async () => {
    getGitStatusMock.mockReturnValue("M src/a.ts");
    const issues = await collectPostRunIssues(makeCtx());
    expect(issues.dirtyTree).toBe("M src/a.ts");
  });

  it("suppresses the dirty-tree gate in non-committing modes", async () => {
    getGitStatusMock.mockReturnValue("M src/a.ts");
    const issues = await collectPostRunIssues(
      makeCtx({ selectedMode: "Plan", hadProgressComment: false }),
    );
    expect(issues.dirtyTree).toBeUndefined();
  });

  it("reports nothing on a clean tree without summary/review state", async () => {
    const issues = await collectPostRunIssues(makeCtx({ selectedMode: "Build" }));
    expect(issues).toEqual({});
  });

  it("flags a stale summary when the file is byte-identical to its seed", async () => {
    const filePath = join(tempDir, "summary-stale.md");
    writeFileSync(filePath, "seed content");
    const issues = await collectPostRunIssues(
      makeCtx({ summaryFilePath: filePath, summarySeed: "seed content" }),
    );
    expect(issues.summaryStale).toEqual({ filePath });
  });

  it("does not flag the summary when the agent edited it", async () => {
    const filePath = join(tempDir, "summary-edited.md");
    writeFileSync(filePath, "agent rewrote this");
    const issues = await collectPostRunIssues(
      makeCtx({ summaryFilePath: filePath, summarySeed: "seed content" }),
    );
    expect(issues.summaryStale).toBeUndefined();
  });

  it("does not flag the summary when the file is missing", async () => {
    const issues = await collectPostRunIssues(
      makeCtx({ summaryFilePath: join(tempDir, "missing.md"), summarySeed: "seed" }),
    );
    expect(issues.summaryStale).toBeUndefined();
  });

  it("skips the summary-stale check when skipSummaryStale is set", async () => {
    const filePath = join(tempDir, "summary-skipped.md");
    writeFileSync(filePath, "seed content");
    const issues = await collectPostRunIssues(
      makeCtx({ summaryFilePath: filePath, summarySeed: "seed content" }),
      { skipSummaryStale: true },
    );
    expect(issues.summaryStale).toBeUndefined();
  });

  it("flags an unsubmitted review and suppresses the dirty tree for Review mode", async () => {
    getGitStatusMock.mockReturnValue("M src/a.ts");
    const issues = await collectPostRunIssues(makeCtx({ selectedMode: "Review" }));
    expect(issues.unsubmittedReview).toBe("Review");
    expect(issues.dirtyTree).toBeUndefined();
  });
});

describe("finalizeAgentResult", () => {
  it("returns a failed result untouched", async () => {
    const result: AgentResult = { success: false, error: "agent crashed" };
    expect(await finalizeAgentResult({ ctx: makeCtx({ selectedMode: "Review" }), result })).toBe(
      result,
    );
  });

  it("returns a successful result untouched when the hard gates are clean", async () => {
    const result: AgentResult = { success: true, output: "done" };
    expect(await finalizeAgentResult({ ctx: makeCtx({ selectedMode: "Build" }), result })).toBe(
      result,
    );
  });

  it("flips success to failed for an unsubmitted Review", async () => {
    const input: AgentResult = { success: true, output: "done" };
    const result = await finalizeAgentResult({
      ctx: makeCtx({ selectedMode: "Review" }),
      result: input,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Review mode finished without calling create_pull_request_review");
  });

  it("mentions the report_progress exit for IncrementalReview", async () => {
    const input: AgentResult = { success: true, output: "done" };
    const result = await finalizeAgentResult({
      ctx: makeCtx({ selectedMode: "IncrementalReview" }),
      result: input,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "IncrementalReview mode finished without calling create_pull_request_review or report_progress",
    );
  });

  it("never flips success on soft gates (dirty tree, stale summary)", async () => {
    getGitStatusMock.mockReturnValue("M src/a.ts");
    const filePath = join(tempDir, "summary-finalize.md");
    writeFileSync(filePath, "seed content");
    const result = await finalizeAgentResult({
      ctx: makeCtx({
        selectedMode: "Build",
        summaryFilePath: filePath,
        summarySeed: "seed content",
      }),
      result: { success: true, output: "done" },
    });
    expect(result.success).toBe(true);
  });
});

describe("shouldRunReflection", () => {
  it("runs reflection when no mode was selected", () => {
    expect(shouldRunReflection(undefined)).toBe(true);
  });

  it("runs reflection for high-novelty modes", () => {
    expect(shouldRunReflection("Build")).toBe(true);
    expect(shouldRunReflection("Review")).toBe(true);
  });

  it("skips reflection for IncrementalReview", () => {
    expect(shouldRunReflection("IncrementalReview")).toBe(false);
  });
});

describe("buildLearningsReflectionPrompt", () => {
  it("names the learnings file and forbids set_output", () => {
    const prompt = buildLearningsReflectionPrompt("/tmp/run/learnings.md");
    expect(prompt).toContain("REFLECTION");
    expect(prompt).toContain("`/tmp/run/learnings.md`");
    expect(prompt).toContain("do NOT call `set_output`");
  });
});

describe("runPostRunRetryLoop", () => {
  // pin `R` to plain AgentResult so per-test resume mocks can return success
  // and failure shapes without fighting generic inference.
  type ResumeFn = (c: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>;

  it("returns the initial result with usage attached when the gates are clean", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "resumed" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: true, output: "task output" },
      initialUsage: makeUsage(1),
      resume,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.output).toBe("task output");
    expect(result.usage).toEqual(makeUsage(1));
  });

  it("short-circuits on a failed initial result without running the gates", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "resumed" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: false, error: "agent crashed" },
      initialUsage: makeUsage(7),
      resume,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe("agent crashed");
    expect(result.usage).toEqual(makeUsage(7));
  });

  it("resumes once for a dirty tree and succeeds when the tree comes back clean", async () => {
    getGitStatusMock.mockReturnValueOnce("M src/a.ts");
    const resume = vi.fn<ResumeFn>(async () => ({
      success: true,
      output: "committed",
      usage: makeUsage(2),
    }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: true, output: "task output", usage: makeUsage(1) },
      initialUsage: makeUsage(1),
      resume,
    });
    expect(resume).toHaveBeenCalledTimes(1);
    const call = resume.mock.calls[0]?.[0] as unknown as { prompt: string };
    expect(call.prompt).toContain("UNCOMMITTED CHANGES");
    expect(call.prompt).toContain("M src/a.ts");
    expect(result.success).toBe(true);
    expect(result.usage).toEqual({ agent: "test", inputTokens: 3, outputTokens: 3 });
  });

  it("hard-fails after exhausting retries on a still-unsubmitted review", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({
      success: true,
      output: "still no review",
      usage: makeUsage(1),
    }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Review" }),
      initialResult: { success: true, output: "task output", usage: makeUsage(1) },
      initialUsage: makeUsage(1),
      resume,
    });
    expect(resume).toHaveBeenCalledTimes(MAX_POST_RUN_RETRIES);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Review mode finished without calling create_pull_request_review " +
        `after ${MAX_POST_RUN_RETRIES} retry attempts`,
    );
    expect(result.usage).toEqual({
      agent: "test",
      inputTokens: 1 + MAX_POST_RUN_RETRIES,
      outputTokens: 1 + MAX_POST_RUN_RETRIES,
    });
  });

  it("hard-fails without a retry note when the session cannot resume at all", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "resumed" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Review" }),
      initialResult: { success: true, output: "task output" },
      initialUsage: undefined,
      resume,
      canResume: () => false,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toBe("Review mode finished without calling create_pull_request_review");
  });

  it("uses the singular retry note when canResume flips false after one attempt", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "second" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Review" }),
      initialResult: { success: true, output: "first" },
      initialUsage: undefined,
      resume,
      canResume: (r: AgentResult) => r.output !== "second",
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Review mode finished without calling create_pull_request_review after 1 retry attempt",
    );
  });

  it("delivers the reflection prompt once and keeps the task output and set_output", async () => {
    const ctx = makeCtx({ selectedMode: "Build" });
    ctx.toolState.output = "task set_output value";
    const resume = vi.fn(
      async (_c: { prompt: string; previousResult: AgentResult }): Promise<AgentResult> => {
        // simulate a model clobbering set_output during the reflection turn
        ctx.toolState.output = "done";
        return { success: true, output: "updated learnings", usage: makeUsage(2) };
      },
    );
    const result = await runPostRunRetryLoop({
      ctx,
      initialResult: { success: true, output: "task output", usage: makeUsage(1) },
      initialUsage: makeUsage(1),
      resume,
      reflectionPrompt: "REFLECT NOW",
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[0]?.prompt).toBe("REFLECT NOW");
    expect(result.success).toBe(true);
    expect(result.output).toBe("task output");
    expect(ctx.toolState.output).toBe("task set_output value");
    expect(result.usage).toEqual({ agent: "test", inputTokens: 3, outputTokens: 3 });
  });

  it("falls through to the reflection reply when the task turn produced no output", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "reflection reply" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: true, output: "" },
      initialUsage: undefined,
      resume,
      reflectionPrompt: "REFLECT NOW",
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("reflection reply");
  });

  it("preserves the prior successful result when the reflection turn fails", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({
      success: false,
      error: "provider blew up",
      usage: makeUsage(5),
    }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: true, output: "task output", usage: makeUsage(1) },
      initialUsage: makeUsage(1),
      resume,
      reflectionPrompt: "REFLECT NOW",
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.output).toBe("task output");
    expect(result.usage).toEqual({ agent: "test", inputTokens: 6, outputTokens: 6 });
  });

  it("skips the reflection turn when the session cannot resume", async () => {
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "resumed" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({ selectedMode: "Build" }),
      initialResult: { success: true, output: "task output" },
      initialUsage: undefined,
      resume,
      canResume: () => false,
      reflectionPrompt: "REFLECT NOW",
    });
    expect(resume).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it("preserves the successful result when a summary-stale-only resume fails", async () => {
    const filePath = join(tempDir, "summary-loop-fail.md");
    writeFileSync(filePath, "seed content");
    const resume = vi.fn<ResumeFn>(async () => ({ success: false, error: "resume exploded" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({
        selectedMode: "Plan",
        hadProgressComment: false,
        summaryFilePath: filePath,
        summarySeed: "seed content",
      }),
      initialResult: { success: true, output: "task output" },
      initialUsage: undefined,
      resume,
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[0]?.prompt).toContain("PR SUMMARY UNTOUCHED");
    expect(result.success).toBe(true);
    expect(result.output).toBe("task output");
  });

  it("nudges a stale summary at most once per run", async () => {
    const filePath = join(tempDir, "summary-loop-once.md");
    writeFileSync(filePath, "seed content");
    const resume = vi.fn<ResumeFn>(async () => ({ success: true, output: "considered it" }));
    const result = await runPostRunRetryLoop({
      ctx: makeCtx({
        selectedMode: "Plan",
        hadProgressComment: false,
        summaryFilePath: filePath,
        summarySeed: "seed content",
      }),
      initialResult: { success: true, output: "task output" },
      initialUsage: undefined,
      resume,
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});
