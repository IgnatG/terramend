import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import {
  assessStaleFix,
  ClosePullRequestTool,
  groupIdFromBranch,
  isBotActor,
  isRemediationBranch,
  ListRemediationPrsTool,
} from "#app/mcp/staleFix";

describe("isRemediationBranch / groupIdFromBranch", () => {
  it("recognises remediate and generate branches, rejects others", () => {
    expect(isRemediationBranch("remediate/abc123")).toBe(true);
    expect(isRemediationBranch("remediate/batch-deadbeef")).toBe(true);
    expect(isRemediationBranch("terramend/generate-s3-site")).toBe(true);
    expect(isRemediationBranch("feature/foo")).toBe(false);
    expect(isRemediationBranch("main")).toBe(false);
  });

  it("extracts the group id from a remediate branch only", () => {
    expect(groupIdFromBranch("remediate/abc123")).toBe("abc123");
    expect(groupIdFromBranch("remediate/batch-deadbeef")).toBe("batch-deadbeef");
    expect(groupIdFromBranch("terramend/generate-s3")).toBeNull();
    expect(groupIdFromBranch("main")).toBeNull();
  });
});

describe("isBotActor", () => {
  it("treats terramend logins and any [bot] as bot; a null login as non-human", () => {
    expect(isBotActor("terramend[bot]")).toBe(true);
    expect(isBotActor("terramenddev")).toBe(true);
    expect(isBotActor("dependabot[bot]")).toBe(true);
    expect(isBotActor(null)).toBe(true); // unmapped author → not provably human
    expect(isBotActor(undefined)).toBe(true);
  });

  it("treats a real user login as non-bot", () => {
    expect(isBotActor("alice")).toBe(false);
    expect(isBotActor("octocat")).toBe(false);
  });
});

describe("assessStaleFix", () => {
  it("escalates a human-touched branch regardless of base movement", () => {
    const a = assessStaleFix({ baseBehindBy: 5, hasNonBotCommits: true });
    expect(a.status).toBe("human_touched");
    expect(a.action).toBe("escalate");
  });

  it("skips a PR whose base has not advanced", () => {
    const a = assessStaleFix({ baseBehindBy: 0, hasNonBotCommits: false });
    expect(a.status).toBe("current");
    expect(a.action).toBe("skip");
  });

  it("flags a stale PR for refresh when the base advanced", () => {
    const a = assessStaleFix({ baseBehindBy: 3, hasNonBotCommits: false });
    expect(a.status).toBe("stale");
    expect(a.action).toBe("refresh");
    expect(a.reason).toContain("3 commit");
  });
});

// --- tool tests ------------------------------------------------------------

function execText(t: ReturnType<typeof ListRemediationPrsTool>) {
  return t.execute as (
    p: unknown,
    c: unknown,
  ) => Promise<{ content: [{ type: "text"; text: string }]; isError?: boolean }>;
}

describe("ListRemediationPrsTool", () => {
  function makeCtx(
    openPrs: unknown[],
    compares: Record<string, { ahead_by: number; behind_by: number; commits: unknown[] }>,
  ): ToolContext {
    return {
      repo: { owner: "o", name: "r" },
      payload: {},
      octokit: {
        // paginate is mocked to return the list directly; the first arg (the
        // `pulls.list` route) just needs to exist to be referenced.
        paginate: vi.fn(async () => openPrs),
        rest: {
          pulls: { list: vi.fn() },
          repos: {
            compareCommits: vi.fn(async ({ head }: { head: string }) => ({
              data: compares[head] ?? { ahead_by: 1, behind_by: 0, commits: [] },
            })),
          },
        },
      },
    } as unknown as ToolContext;
  }

  it("filters to remediation branches and assesses each", async () => {
    const openPrs = [
      {
        number: 1,
        html_url: "u1",
        title: "fix a",
        head: { ref: "remediate/aaa" },
        base: { ref: "main" },
        labels: [{ name: "terramend" }],
      },
      {
        number: 2,
        html_url: "u2",
        title: "human PR",
        head: { ref: "feature/x" },
        base: { ref: "main" },
        labels: [],
      },
      {
        number: 3,
        html_url: "u3",
        title: "fix b (stale)",
        head: { ref: "remediate/bbb" },
        base: { ref: "main" },
        labels: [],
      },
    ];
    const compares = {
      "remediate/aaa": {
        ahead_by: 1,
        behind_by: 0,
        commits: [{ author: { login: "terramend[bot]" } }],
      },
      "remediate/bbb": {
        ahead_by: 1,
        behind_by: 4,
        commits: [{ author: { login: "terramend[bot]" } }],
      },
    };
    const ctx = makeCtx(openPrs, compares);
    const text = await execText(ListRemediationPrsTool(ctx))({}, {});
    const out = text.content[0].text;
    expect(out).toContain("ok: true");
    // only the two remediation PRs appear (feature/x filtered out)
    expect(out).toContain("remediate/aaa");
    expect(out).toContain("remediate/bbb");
    expect(out).not.toContain("feature/x");
    // #1 current (behind 0) → skip; #3 stale (behind 4) → refresh
    expect(out).toContain("skip");
    expect(out).toContain("refresh");
  });

  it("marks a branch with a human commit as escalate", async () => {
    const openPrs = [
      {
        number: 5,
        html_url: "u5",
        title: "fix c",
        head: { ref: "remediate/ccc" },
        base: { ref: "main" },
        labels: [],
      },
    ];
    const compares = {
      "remediate/ccc": {
        ahead_by: 2,
        behind_by: 3,
        commits: [{ author: { login: "terramend[bot]" } }, { author: { login: "alice" } }],
      },
    };
    const ctx = makeCtx(openPrs, compares);
    const text = await execText(ListRemediationPrsTool(ctx))({}, {});
    const out = text.content[0].text;
    expect(out).toContain("escalate");
    expect(out).toContain("human_touched");
    expect(out).toContain("alice");
  });
});

describe("ClosePullRequestTool", () => {
  function makeCtx(opts: {
    push?: "disabled" | "restricted" | "enabled";
    issueNumber?: number;
  }): ToolContext & {
    _update: ReturnType<typeof vi.fn>;
    _comment: ReturnType<typeof vi.fn>;
  } {
    const update = vi.fn(async ({ pull_number }: { pull_number: number }) => ({
      data: { number: pull_number, state: "closed", html_url: `u${pull_number}` },
    }));
    const comment = vi.fn(async () => ({ data: { id: 1 } }));
    const ctx = {
      repo: { owner: "o", name: "r" },
      payload: {
        push: opts.push ?? "restricted",
        event:
          opts.issueNumber !== undefined
            ? { trigger: "issue", issue_number: opts.issueNumber, is_pr: true }
            : { trigger: "unknown" },
      },
      toolState: { model: undefined, createdTargets: new Set<number>() },
      octokit: {
        rest: {
          issues: { createComment: comment },
          pulls: { update },
        },
      },
    } as unknown as ToolContext;
    return Object.assign(ctx, { _update: update, _comment: comment });
  }

  it("closes a PR (standalone run = in scope) and posts the comment first", async () => {
    const ctx = makeCtx({});
    const text = await execText(ClosePullRequestTool(ctx) as never)(
      { pull_number: 7, comment: "already resolved on base" },
      {},
    );
    expect(text.content[0].text).toContain("state: closed");
    expect(ctx._comment).toHaveBeenCalledOnce();
    expect(ctx._update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7, state: "closed" }),
    );
  });

  it("is blocked under push: disabled", async () => {
    const ctx = makeCtx({ push: "disabled" });
    const text = await execText(ClosePullRequestTool(ctx) as never)({ pull_number: 7 }, {});
    expect(text.isError).toBe(true);
    expect(text.content[0].text).toContain("read-only");
    expect(ctx._update).not.toHaveBeenCalled();
  });

  it("refuses to close a PR outside the run's scope", async () => {
    const ctx = makeCtx({ issueNumber: 42 });
    const text = await execText(ClosePullRequestTool(ctx) as never)({ pull_number: 7 }, {});
    expect(text.isError).toBe(true);
    expect(text.content[0].text).toContain("scoped to #42");
    expect(ctx._update).not.toHaveBeenCalled();
  });
});
