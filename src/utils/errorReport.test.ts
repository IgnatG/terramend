import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolState } from "#app/toolState";
import { reportErrorToComment } from "#app/utils/errorReport";
import { updateProgressComment } from "#app/utils/progressComment";

const createComment = vi.hoisted(() => vi.fn());

vi.mock("#app/utils/github", () => ({
  parseRepoContext: vi.fn(() => ({ owner: "acme", name: "repo" })),
  createOctokit: vi.fn(() => ({ rest: { issues: { createComment } } })),
}));

vi.mock("#app/utils/token", () => ({
  getGitHubInstallationToken: vi.fn(() => "installation-token"),
}));

vi.mock("#app/utils/progressComment", () => ({
  updateProgressComment: vi.fn(async () => ({})),
}));

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    prepushFailureCount: 0,
    backgroundProcesses: new Map(),
    progressComment: undefined,
    hadProgressComment: false,
    usageEntries: [],
    ...overrides,
  };
}

function updatedBody(): string {
  const call = vi.mocked(updateProgressComment).mock.calls[0];
  if (!call) throw new Error("expected updateProgressComment to have been called");
  return call[2];
}

beforeEach(() => {
  createComment.mockResolvedValue({ data: { id: 777 } });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("reportErrorToComment", () => {
  it("updates an existing progress comment with title, error, and rerun link", async () => {
    vi.stubEnv("GITHUB_RUN_ID", "12345");
    const toolState = makeToolState({
      progressComment: { id: 5, type: "issue" },
      model: "anthropic/claude-opus-4-7",
    });

    await reportErrorToComment({ toolState, error: "boom", title: "**Run failed**" });

    expect(updateProgressComment).toHaveBeenCalledTimes(1);
    const call = vi.mocked(updateProgressComment).mock.calls[0];
    if (!call) throw new Error("expected updateProgressComment to have been called");
    expect(call[1]).toEqual({ id: 5, type: "issue" });
    const body = call[2];
    expect(body).toContain("**Run failed**\n\nboom");
    expect(body).toContain("Rerun failed job");
    expect(body).toContain("/trigger/acme/repo/12345?action=rerun");
    expect(toolState.wasUpdated).toBe(true);
    expect(createComment).not.toHaveBeenCalled();
  });

  it("omits the rerun link and title prefix when GITHUB_RUN_ID / title are absent", async () => {
    vi.stubEnv("GITHUB_RUN_ID", undefined);
    const toolState = makeToolState({ progressComment: { id: 9, type: "review" } });

    await reportErrorToComment({ toolState, error: "plain failure" });

    const body = updatedBody();
    expect(body.startsWith("plain failure")).toBe(true);
    expect(body).not.toContain("Rerun failed job");
  });

  it("returns silently when there is no comment and createIfMissing is unset", async () => {
    const toolState = makeToolState({ issueNumber: 42 });

    await reportErrorToComment({ toolState, error: "boom" });

    expect(updateProgressComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(toolState.wasUpdated).toBeUndefined();
  });

  it("returns silently when createIfMissing is set but there is no issue number", async () => {
    const toolState = makeToolState();

    await reportErrorToComment({ toolState, error: "boom", createIfMissing: true });

    expect(createComment).not.toHaveBeenCalled();
    expect(toolState.wasUpdated).toBeUndefined();
  });

  it("creates a fresh issue comment for terminal errors on silent triggers", async () => {
    const toolState = makeToolState({ issueNumber: 42 });

    await reportErrorToComment({ toolState, error: "billing exhausted", createIfMissing: true });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment).toHaveBeenCalledWith({
      owner: "acme",
      repo: "repo",
      issue_number: 42,
      body: expect.stringContaining("billing exhausted"),
    });
    expect(toolState.progressComment).toEqual({ id: 777, type: "issue" });
    expect(toolState.wasUpdated).toBe(true);
  });

  it("swallows a failed fallback comment create instead of throwing", async () => {
    createComment.mockRejectedValueOnce(new Error("403 Forbidden"));
    const toolState = makeToolState({ issueNumber: 42 });

    await expect(
      reportErrorToComment({ toolState, error: "boom", createIfMissing: true }),
    ).resolves.toBeUndefined();
    expect(toolState.wasUpdated).toBeUndefined();
    expect(toolState.progressComment).toBeUndefined();
  });

  it("stringifies a non-Error rejection from the fallback create", async () => {
    createComment.mockRejectedValueOnce("string rejection");
    const toolState = makeToolState({ issueNumber: 42 });

    await expect(
      reportErrorToComment({ toolState, error: "boom", createIfMissing: true }),
    ).resolves.toBeUndefined();
    expect(toolState.wasUpdated).toBeUndefined();
  });
});
