import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckoutPrTool,
  checkoutPrBranch,
  type FormatFilesResult,
  formatFilesWithLineNumbers,
  type PrData,
} from "#app/mcp/checkout";
import type { ToolContext } from "#app/mcp/server";
import type { ToolResult } from "#app/mcp/shared";

const mocks = vi.hoisted(() => ({
  $: vi.fn<(cmd: string, args: string[], opts?: unknown) => string>(),
  $git: vi.fn<(sub: string, args: string[], opts?: unknown) => Promise<unknown>>(),
  $gitFetchWithDeepen:
    vi.fn<(args: string[], opts?: unknown, label?: string) => Promise<unknown>>(),
  executeLifecycleHook: vi.fn<(params: unknown) => Promise<{ warning?: string }>>(),
}));

// controls for the node:fs statSync/unlinkSync overrides used by the stale
// git-lock sweep. everything else falls through to the real node:fs.
const fsCtl = vi.hoisted(() => ({
  locks: new Map<string, number>(),
  unlinked: [] as string[],
  unlinkError: false,
}));

vi.mock("#app/utils/shell", () => ({ $: mocks.$ }));
vi.mock("#app/utils/gitAuth", () => ({
  $git: mocks.$git,
  $gitFetchWithDeepen: mocks.$gitFetchWithDeepen,
}));
vi.mock("#app/utils/lifecycle", () => ({ executeLifecycleHook: mocks.executeLifecycleHook }));
// neutralize backoff sleeps (utils/retry sleeps via node:timers/promises,
// which vitest fake timers do not intercept) so retry-loop tests run instantly.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: () => Promise.resolve() };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && fsCtl.locks.has(path)) {
      return { mtimeMs: fsCtl.locks.get(path) ?? 0 } as ReturnType<typeof actual.statSync>;
    }
    if (typeof path === "string" && path.startsWith(".git/")) {
      throw new Error("ENOENT");
    }
    return (actual.statSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.statSync;
  const unlinkSync = ((path: unknown) => {
    if (fsCtl.unlinkError) throw new Error("EPERM");
    fsCtl.unlinked.push(String(path));
  }) as typeof actual.unlinkSync;
  return { ...actual, statSync, unlinkSync };
});

/**
 * parses TOC entries like "- src/math.ts → lines 7-42 · diff-<hex>" into structured data.
 */
function parseTocEntries(toc: string) {
  const entries: Array<{ filename: string; startLine: number; endLine: number }> = [];
  for (const line of toc.split("\n")) {
    const match = line.match(/^- (.+) → lines (\d+)-(\d+) · diff-[0-9a-f]+$/);
    if (match) {
      entries.push({
        filename: match[1] ?? "",
        startLine: parseInt(match[2] ?? "", 10),
        endLine: parseInt(match[3] ?? "", 10),
      });
    }
  }
  return entries;
}

// fixture captured by action/scripts/refresh-test-fixtures.ts. running
// the formatter against checked-in JSON keeps this test offline and
// deterministic — re-fetch the fixture (with creds) when GitHub's
// pulls.listFiles response shape changes, then review the snapshot diff.
type DiffFixture = {
  owner: string;
  name: string;
  pullNumber: number;
  files: Parameters<typeof formatFilesWithLineNumbers>[0];
};

function loadFixture<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "__fixtures__", file), "utf-8")) as T;
}

describe("formatFilesWithLineNumbers", () => {
  it("generates accurate TOC line numbers for terramend/test-repo#1", () => {
    const fx = loadFixture<DiffFixture>("terramend-test-repo-pr-1.diff.json");
    const result: FormatFilesResult = formatFilesWithLineNumbers(fx.files);

    expect(result.content.startsWith(result.toc)).toBe(true);

    const contentLines = result.content.split("\n");
    const tocEntries = parseTocEntries(result.toc);
    expect(tocEntries.length).toBeGreaterThan(0);

    for (const entry of tocEntries) {
      // line numbers are 1-indexed, arrays are 0-indexed
      const firstLine = contentLines[entry.startLine - 1];
      expect(firstLine).toBeDefined();
      // first line of each file section should be the diff header
      expect(firstLine).toBe(`diff --git a/${entry.filename} b/${entry.filename}`);

      expect(entry.endLine).toBeLessThanOrEqual(contentLines.length);
    }

    // verify adjacent files don't overlap and are contiguous
    for (let i = 1; i < tocEntries.length; i++) {
      const prev = tocEntries[i - 1];
      const curr = tocEntries[i];
      expect(curr?.startLine).toBe((prev?.endLine ?? Number.NaN) + 1);
    }

    expect(result.toc).toMatchSnapshot("toc");
    expect(result.content).toMatchSnapshot("content");
  });

  it("renders binary files (no patch) with a placeholder and a TOC entry", () => {
    const result = formatFilesWithLineNumbers([
      { filename: "logo.png", patch: undefined } as unknown as Parameters<
        typeof formatFilesWithLineNumbers
      >[0][number],
    ]);
    expect(result.content).toContain("(binary file or no changes)");
    expect(result.toc).toContain("logo.png");
  });

  it("numbers added, removed, and context lines and passes through markers", () => {
    const patch = [
      "@@ -1,3 +1,3 @@ fn header",
      " context-line",
      "-removed-line",
      "+added-line",
      "\\ No newline at end of file",
      "Xunknown-line-type",
    ].join("\n");
    const result = formatFilesWithLineNumbers([
      { filename: "src/a.ts", patch } as unknown as Parameters<
        typeof formatFilesWithLineNumbers
      >[0][number],
    ]);
    expect(result.content).toContain("@@ -1,3 +1,3 @@ fn header");
    expect(result.content).toContain("|    1 |    1 |   | context-line");
    expect(result.content).toContain("|    2 |      | - | removed-line");
    expect(result.content).toContain("|      |    2 | + | added-line");
    expect(result.content).toContain("\\ No newline at end of file");
    expect(result.content).toContain("Xunknown-line-type");
  });

  it("handles an empty file list", () => {
    const result = formatFilesWithLineNumbers([]);
    expect(result.toc).toContain("## Files (0)");
    expect(result.content.startsWith(result.toc)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkoutPrBranch + CheckoutPrTool (everything below uses the module mocks)
// ---------------------------------------------------------------------------

const HEAD_SHA = "headsha123abcdef";
const BASE_SHA = "basesha000000000";

function makePr(over: Partial<PrData> = {}): PrData {
  return {
    number: 5,
    headSha: HEAD_SHA,
    headRef: "feature",
    headRepoFullName: "o/r",
    baseRef: "main",
    baseRepoFullName: "o/r",
    maintainerCanModify: true,
    ...over,
  };
}

type FakeOctokit = {
  paginate: ReturnType<typeof vi.fn>;
  rest: {
    pulls: { get: ReturnType<typeof vi.fn>; listFiles: Record<string, never> };
    repos: { compareCommits: ReturnType<typeof vi.fn> };
    git: { createRef: ReturnType<typeof vi.fn>; deleteRef: ReturnType<typeof vi.fn> };
  };
};

function makeOctokit(): FakeOctokit {
  return {
    paginate: vi.fn(async () => []),
    rest: {
      pulls: { get: vi.fn(), listFiles: {} },
      repos: { compareCommits: vi.fn() },
      git: {
        createRef: vi.fn(async () => ({ data: {} })),
        deleteRef: vi.fn(async () => ({ data: {} })),
      },
    },
  };
}

type BranchParams = Parameters<typeof checkoutPrBranch>[1];

function makeParams(over: Partial<Record<string, unknown>> = {}): BranchParams {
  return {
    octokit: over.octokit ?? makeOctokit(),
    owner: "o",
    name: "r",
    gitToken: "tok",
    toolState: over.toolState ?? {},
    shell: "disabled",
    postCheckoutScript: null,
    beforeSha: over.beforeSha,
  } as unknown as BranchParams;
}

type DollarResponse = string | (() => string);

function dispatch(table: Record<string, DollarResponse | DollarResponse[]>): void {
  mocks.$.mockImplementation((cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    const entry = table[key];
    if (entry === undefined) throw new Error(`unexpected $ call: ${key}`);
    const next = Array.isArray(entry) ? entry.shift() : entry;
    if (next === undefined) throw new Error(`exhausted responses for: ${key}`);
    return typeof next === "function" ? next() : next;
  });
}

/** dispatch table for a clean same-repo PR #5 checkout (non-shallow) */
function branchDispatch(extra: Record<string, DollarResponse | DollarResponse[]> = {}): void {
  dispatch({
    "git rev-parse --is-shallow-repository": "false",
    "git rev-parse HEAD": [BASE_SHA, HEAD_SHA],
    "git checkout -B main origin/main": "",
    "git checkout pr-5": "",
    "git config branch.pr-5.pushRemote origin": "",
    "git config branch.pr-5.merge refs/heads/feature": "",
    ...extra,
  });
}

describe("checkoutPrBranch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsCtl.locks.clear();
    fsCtl.unlinked.length = 0;
    fsCtl.unlinkError = false;
    mocks.$gitFetchWithDeepen.mockResolvedValue({ stdout: "", stderr: "" });
    mocks.executeLifecycleHook.mockResolvedValue({});
  });

  it("rejects attacker-controlled refs with a leading dash", async () => {
    await expect(checkoutPrBranch(makePr({ baseRef: "-evil" }), makeParams())).rejects.toThrow(
      /starts with '-'/,
    );
    await expect(
      checkoutPrBranch(makePr({ headRef: "--upload-pack=evil" }), makeParams()),
    ).rejects.toThrow(/starts with '-'/);
  });

  it("checks out a same-repo PR and stores the push destination", async () => {
    branchDispatch();
    const toolState: Record<string, unknown> = {};
    const result = await checkoutPrBranch(makePr(), makeParams({ toolState }));

    expect(result.hookWarning).toBeUndefined();
    expect(toolState.issueNumber).toBe(5);
    expect(toolState.checkoutSha).toBe(HEAD_SHA);
    expect(toolState.pushUrl).toBeUndefined();
    expect(toolState.pushDest).toEqual({
      remoteName: "origin",
      remoteBranch: "feature",
      localBranch: "pr-5",
    });
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledWith(
      ["--no-tags", "origin", "main"],
      { token: "tok" },
      "base branch main",
    );
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledWith(
      ["--no-tags", "origin", "+pull/5/head:pr-5"],
      { token: "tok" },
      "PR #5",
    );
    expect(mocks.executeLifecycleHook).toHaveBeenCalledWith({
      event: "post-checkout",
      script: null,
      normalizeWorkingTreeAfter: true,
    });
  });

  it("surfaces a post-checkout hook warning without failing the checkout", async () => {
    branchDispatch();
    mocks.executeLifecycleHook.mockResolvedValue({ warning: "hook flaked" });
    const result = await checkoutPrBranch(makePr(), makeParams());
    expect(result.hookWarning).toBe("hook flaked");
  });

  it("skips fetch+checkout when HEAD already matches the PR head SHA", async () => {
    // dispatch deliberately omits checkout keys: any checkout call would throw
    dispatch({
      "git rev-parse --is-shallow-repository": "false",
      "git rev-parse HEAD": HEAD_SHA,
      "git config branch.pr-5.pushRemote origin": "",
      "git config branch.pr-5.merge refs/heads/feature": "",
    });
    await checkoutPrBranch(makePr(), makeParams());
    // only the base fetch happened
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledTimes(1);
  });

  it("configures a named fork remote and push URL for fork PRs", async () => {
    dispatch({
      "git rev-parse --is-shallow-repository": "false",
      "git rev-parse HEAD": [BASE_SHA, HEAD_SHA],
      "git checkout -B main origin/main": "",
      "git checkout pr-5": "",
      "git remote add pr-5 https://github.com/fork/r.git": "",
      "git config branch.pr-5.pushRemote pr-5": "",
      "git config branch.pr-5.merge refs/heads/feature": "",
    });
    const toolState: Record<string, unknown> = {};
    await checkoutPrBranch(
      makePr({ headRepoFullName: "fork/r", maintainerCanModify: false }),
      makeParams({ toolState }),
    );
    expect(toolState.pushUrl).toBe("https://github.com/fork/r.git");
    expect(toolState.pushDest).toEqual({
      remoteName: "pr-5",
      remoteBranch: "feature",
      localBranch: "pr-5",
    });
  });

  it("updates the fork remote URL when the remote already exists", async () => {
    dispatch({
      "git rev-parse --is-shallow-repository": "false",
      "git rev-parse HEAD": [BASE_SHA, HEAD_SHA],
      "git checkout -B main origin/main": "",
      "git checkout pr-5": "",
      "git remote add pr-5 https://github.com/fork/r.git": () => {
        throw new Error("error: remote pr-5 already exists");
      },
      "git remote set-url pr-5 https://github.com/fork/r.git": "",
      "git config branch.pr-5.pushRemote pr-5": "",
      "git config branch.pr-5.merge refs/heads/feature": "",
    });
    await expect(
      checkoutPrBranch(makePr({ headRepoFullName: "fork/r" }), makeParams()),
    ).resolves.toBeDefined();
  });

  it("sweeps stale git lock files but leaves fresh ones alone", async () => {
    branchDispatch();
    fsCtl.locks.set(".git/shallow.lock", Date.now() - 60_000);
    fsCtl.locks.set(".git/index.lock", Date.now() - 1_000);
    await checkoutPrBranch(makePr(), makeParams());
    expect(fsCtl.unlinked).toContain(".git/shallow.lock");
    expect(fsCtl.unlinked).not.toContain(".git/index.lock");
  });

  it("does not fail the checkout when a stale lock cannot be removed", async () => {
    branchDispatch();
    fsCtl.locks.set(".git/shallow.lock", Date.now() - 60_000);
    fsCtl.unlinkError = true;
    await expect(checkoutPrBranch(makePr(), makeParams())).resolves.toBeDefined();
  });

  it("deepens shallow clones using the compare API ahead/behind counts", async () => {
    branchDispatch({ "git rev-parse --is-shallow-repository": "true" });
    const octokit = makeOctokit();
    octokit.rest.repos.compareCommits.mockResolvedValue({ data: { ahead_by: 3, behind_by: 1 } });
    mocks.$git.mockResolvedValue({ stdout: "", stderr: "" });
    await checkoutPrBranch(makePr(), makeParams({ octokit }));
    expect(mocks.$git).toHaveBeenCalledWith("fetch", ["--deepen=13", "--no-tags", "origin"], {
      token: "tok",
    });
  });

  it("falls back to --deepen=1000 when the compare API fails", async () => {
    branchDispatch({ "git rev-parse --is-shallow-repository": "true" });
    const octokit = makeOctokit();
    octokit.rest.repos.compareCommits.mockRejectedValue(new Error("API down"));
    mocks.$git.mockResolvedValue({ stdout: "", stderr: "" });
    await checkoutPrBranch(makePr(), makeParams({ octokit }));
    expect(mocks.$git).toHaveBeenCalledWith("fetch", ["--deepen=1000", "--no-tags", "origin"], {
      token: "tok",
    });
  });

  it("treats a locally-reachable before_sha as reachable without a temp branch", async () => {
    const beforeSha = "feedbeef00000000000000000000000000000000";
    branchDispatch({ [`git cat-file -t ${beforeSha}`]: "commit" });
    const octokit = makeOctokit();
    await checkoutPrBranch(makePr(), makeParams({ octokit, beforeSha }));
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });

  it("fetches an unreachable before_sha via a disposable temp branch", async () => {
    const beforeSha = "feedbeef00000000000000000000000000000000";
    branchDispatch({
      [`git cat-file -t ${beforeSha}`]: () => {
        throw new Error("fatal: not a valid object name");
      },
    });
    const octokit = makeOctokit();
    await checkoutPrBranch(makePr(), makeParams({ octokit, beforeSha }));
    const tempBranch = `terramend/tmp/${beforeSha.slice(0, 12)}`;
    expect(octokit.rest.git.createRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: `refs/heads/${tempBranch}`,
      sha: beforeSha,
    });
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledWith(
      ["--no-tags", "origin", tempBranch],
      { token: "tok" },
      `before_sha temp branch ${tempBranch}`,
    );
    // async-dispose cleanup deleted the temp branch
    expect(octokit.rest.git.deleteRef).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      ref: `heads/${tempBranch}`,
    });
  });

  it("ignores temp-branch deletion failures during cleanup", async () => {
    const beforeSha = "feedbeef00000000000000000000000000000000";
    branchDispatch({
      [`git cat-file -t ${beforeSha}`]: () => {
        throw new Error("fatal: not a valid object name");
      },
    });
    const octokit = makeOctokit();
    octokit.rest.git.deleteRef.mockRejectedValue(new Error("404 Not Found"));
    await expect(
      checkoutPrBranch(makePr(), makeParams({ octokit, beforeSha })),
    ).resolves.toBeDefined();
  });

  it("keeps retrying when the dispatchability probe itself fails (lenient)", async () => {
    branchDispatch();
    mocks.$gitFetchWithDeepen.mockImplementation(async (args: string[]) => {
      if ((args[2] ?? "").startsWith("+pull/")) {
        throw new Error("fatal: couldn't find remote ref pull/5/head");
      }
      return { stdout: "", stderr: "" };
    });
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockRejectedValue(new Error("502 Bad Gateway"));
    await expect(checkoutPrBranch(makePr(), makeParams({ octokit }))).rejects.toThrow(
      /couldn't find remote ref/,
    );
    // probe failures never abort early: the full retry budget is spent
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledTimes(5);
  });

  it("degrades gracefully when the temp branch cannot be created", async () => {
    const beforeSha = "feedbeef00000000000000000000000000000000";
    branchDispatch({
      [`git cat-file -t ${beforeSha}`]: () => {
        throw new Error("fatal: not a valid object name");
      },
    });
    const octokit = makeOctokit();
    octokit.rest.git.createRef.mockRejectedValue(new Error("422 Reference already exists"));
    await expect(
      checkoutPrBranch(makePr(), makeParams({ octokit, beforeSha })),
    ).resolves.toBeDefined();
  });

  it("aborts cleanly when pull/N/head is missing because the PR moved on", async () => {
    branchDispatch();
    mocks.$gitFetchWithDeepen.mockImplementation(async (args: string[]) => {
      if ((args[2] ?? "").startsWith("+pull/")) {
        throw new Error("fatal: couldn't find remote ref pull/5/head");
      }
      return { stdout: "", stderr: "" };
    });
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({
      data: { state: "closed", head: { sha: HEAD_SHA } },
    });
    await expect(checkoutPrBranch(makePr(), makeParams({ octokit }))).rejects.toThrow(
      /no longer in the state it was at dispatch/,
    );
    // base fetch + a single PR fetch attempt: the abort fires before any retry
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledTimes(2);
  });

  it("retries the missing-ref fetch while the PR still matches, then surfaces it", async () => {
    branchDispatch();
    mocks.$gitFetchWithDeepen.mockImplementation(async (args: string[]) => {
      if ((args[2] ?? "").startsWith("+pull/")) {
        throw new Error("fatal: couldn't find remote ref pull/5/head");
      }
      return { stdout: "", stderr: "" };
    });
    const octokit = makeOctokit();
    octokit.rest.pulls.get.mockResolvedValue({
      data: { state: "open", head: { sha: HEAD_SHA } },
    });
    await expect(checkoutPrBranch(makePr(), makeParams({ octokit }))).rejects.toThrow(
      /couldn't find remote ref pull\/5\/head/,
    );
    // base fetch + 1 initial attempt + 3 backoff retries
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledTimes(5);
  });
});

describe("checkout_pr tool", () => {
  const PR_FILES = [
    {
      filename: "src/a.ts",
      patch: "@@ -1,2 +1,3 @@\n context\n+added\n context2",
    },
  ];

  function makeToolCtx(over: Partial<Record<string, unknown>> = {}): {
    ctx: ToolContext;
    octokit: FakeOctokit;
    toolState: Record<string, unknown>;
  } {
    const octokit = (over.octokit as FakeOctokit | undefined) ?? makeOctokit();
    const beforeSha = over.beforeSha as string | undefined;
    octokit.rest.pulls.get.mockResolvedValue({
      data: {
        number: 5,
        title: "improve things",
        body: "pr body",
        html_url: "https://github.com/o/r/pull/5",
        maintainer_can_modify: true,
        head: { sha: HEAD_SHA, ref: "feature", repo: { full_name: "o/r" } },
        base: { ref: "main", repo: { full_name: "o/r" } },
      },
    });
    octokit.paginate.mockResolvedValue(PR_FILES);
    const toolState: Record<string, unknown> = {
      initialHead: over.initialHead,
      beforeSha,
      diffCoverage: undefined,
    };
    const ctx = {
      repo: { owner: "o", name: "r", data: { default_branch: "main" } },
      payload: { shell: "disabled" },
      octokit,
      gitToken: "tok",
      postCheckoutScript: null,
      prepushScript: null,
      toolState,
    } as unknown as ToolContext;
    return { ctx, octokit, toolState };
  }

  function runTool(t: { execute: unknown }, params: Record<string, unknown>): Promise<ToolResult> {
    const exec = t.execute as (args: unknown, context?: unknown) => Promise<ToolResult>;
    return exec(params);
  }

  function textOf(result: ToolResult): string {
    return result.content[0]?.text ?? "";
  }

  /** tool-level dispatch: status probe + the branch-checkout table + commit metadata */
  function toolDispatch(extra: Record<string, DollarResponse | DollarResponse[]> = {}): void {
    dispatch({
      "git status --porcelain": "",
      "git rev-parse --is-shallow-repository": "false",
      "git rev-parse HEAD": [BASE_SHA, HEAD_SHA],
      "git checkout -B main origin/main": "",
      "git checkout pr-5": "",
      "git config branch.pr-5.pushRemote origin": "",
      "git config branch.pr-5.merge refs/heads/feature": "",
      "git rev-list --count origin/main..HEAD": "2",
      "git log --oneline --max-count=200 origin/main..HEAD": "abc one\ndef two",
      ...extra,
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    fsCtl.locks.clear();
    fsCtl.unlinked.length = 0;
    fsCtl.unlinkError = false;
    mocks.$gitFetchWithDeepen.mockResolvedValue({ stdout: "", stderr: "" });
    mocks.executeLifecycleHook.mockResolvedValue({});
    vi.stubEnv("TERRAMEND_TEMP_DIR", tmpdir());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to run with a dirty working tree", async () => {
    dispatch({ "git status --porcelain": " M main.tf\n?? stray.txt" });
    const { ctx } = makeToolCtx();
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 3 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("uncommitted changes");
    // the status output is trimmed before being embedded in the message
    expect(textOf(result)).toContain("M main.tf");
    expect(textOf(result)).toContain("?? stray.txt");
  });

  it("blocks checkout from a foreign pr-N branch (cross-PR clobber guard)", async () => {
    dispatch({
      "git status --porcelain": "",
      "git symbolic-ref --short HEAD": "pr-9",
    });
    const { ctx } = makeToolCtx({ initialHead: { kind: "branch", name: "main" } });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("cannot checkout PR #5 from branch `pr-9`");
    expect(text).toContain("git checkout main");
  });

  it("blocks checkout from an unexpected detached HEAD", async () => {
    dispatch({
      "git status --porcelain": "",
      "git symbolic-ref --short HEAD": () => {
        throw new Error("fatal: ref HEAD is not a symbolic ref");
      },
      "git rev-parse HEAD": "0123456789abcdef",
    });
    const { ctx } = makeToolCtx({ initialHead: { kind: "detached", sha: "fedcba9876543210" } });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("detached HEAD `0123456789abcdef`");
    expect(text).toContain("git checkout fedcba9876543210");
  });

  it("blocks checkout when HEAD kind differs from the run-entry kind", async () => {
    dispatch({
      "git status --porcelain": "",
      "git symbolic-ref --short HEAD": () => {
        throw new Error("fatal: not symbolic");
      },
      "git rev-parse HEAD": "0123456789abcdef",
    });
    const { ctx } = makeToolCtx({ initialHead: { kind: "branch", name: "main" } });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBe(true);
  });

  it("checks out a PR end to end and writes the formatted diff", async () => {
    toolDispatch({ "git symbolic-ref --short HEAD": "main" });
    const { ctx, toolState } = makeToolCtx({ initialHead: { kind: "branch", name: "main" } });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("improve things");
    expect(text).toContain("pr-5");
    expect(toolState.issueNumber).toBe(5);
    expect(toolState.commentableLinesPullNumber).toBe(5);

    // the formatted diff landed on disk at the path named in the response
    const diffPathMatch = text.match(/pr-5-[0-9a-z]+\.diff/);
    expect(diffPathMatch).not.toBeNull();
    const coverage = toolState.diffCoverage as { diffPath: string; totalLines: number };
    expect(existsSync(coverage.diffPath)).toBe(true);
    expect(readFileSync(coverage.diffPath, "utf-8")).toContain("src/a.ts");
  });

  it("computes and writes an incremental diff when beforeSha is set", async () => {
    const beforeSha = "feedbeef00000000000000000000000000000000";
    toolDispatch({ [`git cat-file -t ${beforeSha}`]: "commit" });
    // computeIncrementalDiff shells out via $("sh", ...) — feed it raw
    // range-diff output containing a changed line so post-processing yields
    // non-empty content.
    const base = mocks.$.getMockImplementation();
    mocks.$.mockImplementation((cmd, args, opts) => {
      if (cmd === "sh") return "    ++an added line\n";
      return base ? base(cmd, args, opts) : "";
    });
    const { ctx } = makeToolCtx({ beforeSha });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("-incremental.diff");
    expect(text).toContain("read incrementalDiffPath FIRST");
    const match = text.match(/incrementalDiffPath:\s*(\S+-incremental\.diff)/);
    expect(match).not.toBeNull();
  });

  it("degrades commit metadata gracefully when the base ref is unreachable", async () => {
    toolDispatch({
      "git rev-list --count origin/main..HEAD": () => {
        throw new Error("fatal: bad revision 'origin/main..HEAD'");
      },
    });
    const { ctx } = makeToolCtx();
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("commit metadata is partial");
  });

  it("forwards the post-checkout hook warning into the tool response", async () => {
    toolDispatch();
    mocks.executeLifecycleHook.mockResolvedValue({ warning: "hook flaked" });
    const { ctx } = makeToolCtx();
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("HOOK WARNING");
    expect(textOf(result)).toContain("hook flaked");
  });

  it("fails when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", "");
    toolDispatch();
    const { ctx } = makeToolCtx();
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TERRAMEND_TEMP_DIR not set");
  });

  it("dedupes concurrent checkout_pr calls for the same PR", async () => {
    toolDispatch();
    const { ctx, octokit } = makeToolCtx();
    const tool = CheckoutPrTool(ctx);
    const [a, b] = await Promise.all([
      runTool(tool, { pull_number: 5 }),
      runTool(tool, { pull_number: 5 }),
    ]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    // the underlying checkout ran exactly once
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(octokit.paginate).toHaveBeenCalledTimes(1);
  });

  it("errors when the PR's source repository was deleted", async () => {
    dispatch({ "git status --porcelain": "" });
    const octokit = makeOctokit();
    const { ctx } = makeToolCtx({ octokit });
    octokit.rest.pulls.get.mockResolvedValue({
      data: { head: { repo: null } },
    });
    const result = await runTool(CheckoutPrTool(ctx), { pull_number: 6 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("source repository was deleted");
  });
});
