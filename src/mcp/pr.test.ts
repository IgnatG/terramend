import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertUnderPrCap, recordRemediationPrOpened } from "#app/mcp/guardrails";
import {
  CreatePullRequestTool,
  pickBaseBranch,
  resolveBaseBranch,
  UpdatePullRequestBodyTool,
} from "#app/mcp/pr";
import type { ToolContext } from "#app/mcp/server";
import type { ToolState } from "#app/toolState";
import { TERRAMEND_DIVIDER } from "#app/utils/buildTerramendFooter";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";
import { $ } from "#app/utils/shell";

vi.mock("#app/utils/shell", () => ({
  $: vi.fn(() => "feature-branch"),
}));

vi.mock("#app/mcp/guardrails", () => ({
  assertUnderPrCap: vi.fn(),
  recordRemediationPrOpened: vi.fn(),
}));

vi.mock("#app/utils/patchWorkflowRunFields", () => ({
  patchWorkflowRunFields: vi.fn(async () => undefined),
}));

const shellMock = vi.mocked($);

describe("pickBaseBranch (deterministic base: declared → default → main → master → main)", () => {
  it("an explicit declaration always wins", () => {
    expect(
      pickBaseBranch({
        declared: "release",
        defaultBranch: "main",
        mainExists: true,
        masterExists: true,
      }),
    ).toBe("release");
  });

  it("uses the repository default branch when nothing is declared", () => {
    expect(pickBaseBranch({ defaultBranch: "master", mainExists: true, masterExists: true })).toBe(
      "master",
    );
  });

  it("prefers main when neither a declaration nor a default branch is known", () => {
    expect(pickBaseBranch({ mainExists: true, masterExists: true })).toBe("main");
  });

  it("falls back to master when main does not exist", () => {
    expect(pickBaseBranch({ mainExists: false, masterExists: true })).toBe("master");
  });

  it("ultimately defaults to main", () => {
    expect(pickBaseBranch({ mainExists: false, masterExists: false })).toBe("main");
  });
});

describe("resolveBaseBranch (ctx wiring; git not probed when a declaration or default exists)", () => {
  const ctx = (over: { baseBranch?: string; defaultBranch?: string }): ToolContext =>
    ({
      payload: { baseBranch: over.baseBranch },
      repo: { data: { default_branch: over.defaultBranch } },
    }) as unknown as ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the explicit base_branch override", () => {
    expect(resolveBaseBranch(ctx({ baseBranch: "release", defaultBranch: "main" }))).toBe(
      "release",
    );
    expect(shellMock).not.toHaveBeenCalled();
  });

  it("trims the override", () => {
    expect(resolveBaseBranch(ctx({ baseBranch: "  release  ", defaultBranch: "main" }))).toBe(
      "release",
    );
  });

  it("uses the repository default branch when no override is set", () => {
    expect(resolveBaseBranch(ctx({ defaultBranch: "master" }))).toBe("master");
    expect(shellMock).not.toHaveBeenCalled();
  });

  it("probes git only in the last-resort case and finds main on the remote ref", () => {
    shellMock.mockImplementation((_cmd, args) => {
      const argList = args as string[];
      if (argList.includes("refs/remotes/origin/main")) return "ok";
      throw new Error("ref absent");
    });
    expect(resolveBaseBranch(ctx({}))).toBe("main");
  });

  it("falls back to a local master ref when no main exists anywhere", () => {
    shellMock.mockImplementation((_cmd, args) => {
      const argList = args as string[];
      if (argList.includes("refs/heads/master")) return "ok";
      throw new Error("ref absent");
    });
    expect(resolveBaseBranch(ctx({}))).toBe("master");
  });

  it("defaults to main when neither branch resolves", () => {
    shellMock.mockImplementation(() => {
      throw new Error("ref absent");
    });
    expect(resolveBaseBranch(ctx({}))).toBe("main");
  });
});

// ── the octokit-backed tools ─────────────────────────────────────────────────

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeOctokit() {
  return {
    rest: {
      pulls: {
        update: vi.fn(async (_p: unknown) => ({
          data: { number: 12, html_url: "https://gh/pr/12" },
        })),
        create: vi.fn(async (_p: unknown) => ({
          data: {
            id: 7001,
            number: 12,
            node_id: "PR_NODE",
            html_url: "https://gh/pr/12",
            title: "fix: encrypt bucket",
            head: { ref: "feature-branch" },
            base: { ref: "main" },
          },
        })),
        requestReviewers: vi.fn(async (_p: unknown) => ({})),
      },
    },
  };
}

function makeToolCtx(overrides?: {
  toolState?: Partial<ToolState>;
  triggerer?: string;
  baseBranch?: string;
  push?: "disabled" | "restricted" | "enabled";
  eventIssueNumber?: number;
}): { ctx: ToolContext; octokit: ReturnType<typeof makeOctokit>; toolState: ToolState } {
  const octokit = makeOctokit();
  const toolState = { createdTargets: new Set<number>(), ...overrides?.toolState } as ToolState;
  const event =
    overrides?.eventIssueNumber === undefined
      ? { trigger: "unknown" }
      : { trigger: "pull_request_opened", is_pr: true, issue_number: overrides.eventIssueNumber };
  const ctx = {
    octokit,
    repo: { owner: "octo", name: "repo", data: { default_branch: "main" } },
    payload: {
      triggerer: overrides?.triggerer,
      baseBranch: overrides?.baseBranch,
      push: overrides?.push,
      event,
    },
    toolState,
  } as unknown as ToolContext;
  return { ctx, octokit, toolState };
}

describe("UpdatePullRequestBodyTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates the PR body with a fresh footer and marks wasUpdated", async () => {
    const { ctx, octokit, toolState } = makeToolCtx();
    const result = await runTool(UpdatePullRequestBodyTool(ctx), {
      pull_number: 12,
      body: "new description",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octo", repo: "repo", pull_number: 12 }),
    );
    const sent = octokit.rest.pulls.update.mock.calls[0]?.[0] as { body: string };
    expect(sent.body).toContain("new description");
    expect(sent.body).toContain(TERRAMEND_DIVIDER);
    expect(toolState.wasUpdated).toBe(true);
  });

  it("strips a stale footer before appending a fresh one", async () => {
    const { ctx, octokit } = makeToolCtx();
    await runTool(UpdatePullRequestBodyTool(ctx), {
      pull_number: 12,
      body: `body text\n\n${TERRAMEND_DIVIDER}\n<sup>stale</sup>`,
    });

    const sent = octokit.rest.pulls.update.mock.calls[0]?.[0] as { body: string };
    expect(sent.body.startsWith("body text")).toBe(true);
    expect(sent.body).not.toContain("stale");
    expect(sent.body.indexOf(TERRAMEND_DIVIDER)).toBe(sent.body.lastIndexOf(TERRAMEND_DIVIDER));
  });

  it("repairs a double-escaped body (no real newlines) before sending", async () => {
    const { ctx, octokit } = makeToolCtx();
    await runTool(UpdatePullRequestBodyTool(ctx), { pull_number: 12, body: "line1\\nline2" });

    const sent = octokit.rest.pulls.update.mock.calls[0]?.[0] as { body: string };
    expect(sent.body).toContain("line1\nline2");
    expect(sent.body).not.toContain("line1\\nline2");
  });

  it("propagates API failures as tool errors", async () => {
    const { ctx, octokit } = makeToolCtx();
    octokit.rest.pulls.update.mockRejectedValueOnce(new Error("API down"));
    const result = await runTool(UpdatePullRequestBodyTool(ctx), { pull_number: 12, body: "b" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("API down");
  });
});

describe("CreatePullRequestTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.mockReturnValue("feature-branch");
  });

  it("creates the PR from the current branch against the resolved base", async () => {
    const { ctx, octokit } = makeToolCtx();
    const result = await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBeUndefined();
    expect(assertUnderPrCap).toHaveBeenCalledWith(ctx);
    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "octo",
        repo: "repo",
        head: "feature-branch",
        base: "main",
        draft: false,
      }),
    );
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(ctx, { prNodeId: "PR_NODE" });
    expect(recordRemediationPrOpened).toHaveBeenCalledWith(ctx);
    const text = result.content[0].text;
    expect(text).toContain("success: true");
    expect(text).toContain("number: 12");
    expect(text).toContain("head: feature-branch");
    expect(text).toContain("base: main");
  });

  it("honors an explicit base and the draft flag", async () => {
    const { ctx, octokit } = makeToolCtx();
    await runTool(CreatePullRequestTool(ctx), {
      title: "t",
      body: "b",
      base: "release",
      draft: true,
    });

    expect(octokit.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release", draft: true }),
    );
  });

  it("requests a review from the triggering user (best-effort)", async () => {
    const { ctx, octokit } = makeToolCtx({ triggerer: "octocat" });
    await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(octokit.rest.pulls.requestReviewers).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12, reviewers: ["octocat"] }),
    );
  });

  it("swallows a failed review request and still succeeds", async () => {
    const { ctx, octokit } = makeToolCtx({ triggerer: "octocat" });
    octokit.rest.pulls.requestReviewers.mockRejectedValueOnce(new Error("cannot review own PR"));
    const result = await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("success: true");
  });

  it("skips the reviewer request without a triggerer", async () => {
    const { ctx, octokit } = makeToolCtx();
    await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(octokit.rest.pulls.requestReviewers).not.toHaveBeenCalled();
  });

  it("skips the workflow-run patch when the PR has no node_id", async () => {
    const { ctx, octokit } = makeToolCtx();
    octokit.rest.pulls.create.mockResolvedValueOnce({
      data: {
        id: 7001,
        number: 12,
        node_id: "",
        html_url: "https://gh/pr/12",
        title: "t",
        head: { ref: "feature-branch" },
        base: { ref: "main" },
      },
    });
    const result = await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBeUndefined();
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
  });

  it("stops at the remediation PR cap before touching git or GitHub", async () => {
    vi.mocked(assertUnderPrCap).mockImplementationOnce(() => {
      throw new Error("max_prs reached (3)");
    });
    const { ctx, octokit } = makeToolCtx();
    const result = await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("max_prs reached");
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
    expect(recordRemediationPrOpened).not.toHaveBeenCalled();
  });

  it("is blocked under push: disabled (read-only access)", async () => {
    const { ctx, octokit } = makeToolCtx({ push: "disabled" });
    const result = await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/read-only access/);
    expect(assertUnderPrCap).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });
});

describe("REST write-tool scope binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shellMock.mockReturnValue("feature-branch");
  });

  it("update_pull_request_body refuses a PR outside the run's scope", async () => {
    const { ctx, octokit } = makeToolCtx({ eventIssueNumber: 5 });
    const result = await runTool(UpdatePullRequestBodyTool(ctx), {
      pull_number: 6,
      body: "b",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scoped to #5; refusing to update the body of #6/);
    expect(octokit.rest.pulls.update).not.toHaveBeenCalled();
  });

  it("update_pull_request_body allows the run's scoped PR", async () => {
    const { ctx, octokit } = makeToolCtx({ eventIssueNumber: 12 });
    const result = await runTool(UpdatePullRequestBodyTool(ctx), {
      pull_number: 12,
      body: "b",
    });

    expect(result.isError).toBeUndefined();
    expect(octokit.rest.pulls.update).toHaveBeenCalled();
  });

  it("update_pull_request_body allows a PR the run just created", async () => {
    const { ctx, octokit } = makeToolCtx({ eventIssueNumber: 5 });
    // the run opens PR #12 (create records it as owned)…
    await runTool(CreatePullRequestTool(ctx), { title: "t", body: "b" });
    // …so editing #12's body is now in scope even though the trigger was #5.
    const result = await runTool(UpdatePullRequestBodyTool(ctx), {
      pull_number: 12,
      body: "updated",
    });

    expect(result.isError).toBeUndefined();
    expect(octokit.rest.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12 }),
    );
  });
});
