import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_REQUIRED_REDIRECT,
  classifyPushError,
  DeleteBranchTool,
  GitFetchTool,
  GitTool,
  NOSHELL_BLOCKED_ARGS,
  NOSHELL_BLOCKED_SUBCOMMANDS,
  PushBranchTool,
  PushTagsTool,
  rejectIfLeadingDash,
  rejectSpecialRef,
  validateTagName,
} from "#app/mcp/git";
import type { ToolContext } from "#app/mcp/server";
import type { ToolResult } from "#app/mcp/shared";

const mocks = vi.hoisted(() => ({
  $: vi.fn<
    (
      cmd: string,
      args: string[],
      opts?: {
        log?: boolean;
        onError?: (r: { status: number; stdout: string; stderr: string }) => void;
      },
    ) => string
  >(),
  $git: vi.fn<(sub: string, args: string[], opts?: unknown) => Promise<unknown>>(),
  $gitFetchWithDeepen:
    vi.fn<(args: string[], opts?: unknown, label?: string) => Promise<unknown>>(),
  executeLifecycleHook: vi.fn<(params: unknown) => Promise<{ failure?: unknown }>>(),
}));

vi.mock("#app/utils/shell", () => ({ $: mocks.$ }));
vi.mock("#app/utils/gitAuth", () => ({
  $git: mocks.$git,
  $gitFetchWithDeepen: mocks.$gitFetchWithDeepen,
}));
vi.mock("#app/utils/lifecycle", () => ({ executeLifecycleHook: mocks.executeLifecycleHook }));
vi.mock("#app/mcp/guardrails", () => ({
  assertNoBlockedDestroy: vi.fn(),
  assertNoSecretsInDiff: vi.fn(),
  enforceProtectedPaths: vi.fn(),
  enforceRemediationPaths: vi.fn(),
}));

/** invoke a tool's execute the way fastmcp would, bypassing schema validation */
function runTool(t: { execute: unknown }, params: Record<string, unknown>): Promise<ToolResult> {
  const exec = t.execute as (args: unknown, context?: unknown) => Promise<ToolResult>;
  return exec(params);
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

type CtxOverrides = {
  push?: "enabled" | "restricted" | "disabled";
  shell?: "enabled" | "restricted" | "disabled";
  defaultBranch?: string;
  pushUrl?: string | undefined;
  pushDest?: { remoteName: string; remoteBranch: string; localBranch: string };
  prepushFailureCount?: number;
  prepushScript?: string | null;
  event?: Record<string, unknown>;
};

function makeCtx(over: CtxOverrides = {}): ToolContext {
  return {
    repo: { data: { default_branch: over.defaultBranch ?? "main" } },
    payload: {
      push: over.push ?? "enabled",
      shell: over.shell ?? "disabled",
      event: over.event ?? { trigger: "unknown" },
    },
    gitToken: "test-token",
    prepushScript: over.prepushScript ?? null,
    toolState: {
      pushUrl: "pushUrl" in over ? over.pushUrl : "https://github.com/o/r.git",
      pushDest: over.pushDest,
      prepushFailureCount: over.prepushFailureCount ?? 0,
    },
  } as unknown as ToolContext;
}

type DollarResponse = string | (() => string);

/** route `$("git", args)` calls by "cmd arg arg..." key. arrays are consumed
 * in order for repeated identical calls. unknown calls throw loudly. */
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

// re-export the normalizeUrl function for testing
// note: in a real scenario, we'd export this from git.ts or move to a shared utils file
function normalizeUrl(url: string): string {
  return url.replace(/\.git$/, "").toLowerCase();
}

describe("normalizeUrl", () => {
  it("removes .git suffix", () => {
    expect(normalizeUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });

  it("lowercases URL", () => {
    expect(normalizeUrl("https://github.com/Owner/Repo")).toBe("https://github.com/owner/repo");
  });

  it("handles URL without .git suffix", () => {
    expect(normalizeUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("handles combined case and .git suffix", () => {
    expect(normalizeUrl("https://github.com/OWNER/REPO.git")).toBe("https://github.com/owner/repo");
  });
});

describe("push URL validation", () => {
  // these tests document the expected behavior
  // actual integration testing happens via the agent test suite

  it("should block push when actual URL differs from pushUrl", () => {
    // pushUrl is set by setupGit (base repo) or checkout_pr (fork repo)
    const pushUrl = "https://github.com/fork-owner/repo.git";
    const actualUrl = "https://github.com/base-owner/repo.git"; // different repo

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).not.toBe(actualUrlNormalized);
    // in real code, this mismatch would throw an error
  });

  it("should allow push when actual URL matches pushUrl", () => {
    const pushUrl = "https://github.com/fork-owner/repo.git";
    const actualUrl = "https://github.com/fork-owner/repo"; // same repo, no .git

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).toBe(actualUrlNormalized);
    // in real code, this would allow the push
  });

  it("should handle case differences in URLs", () => {
    const pushUrl = "https://github.com/Owner/Repo.git";
    const actualUrl = "https://github.com/owner/repo";

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).toBe(actualUrlNormalized);
  });
});

describe("classifyPushError", () => {
  describe("concurrent-push", () => {
    it("matches client-side non-fast-forward (`fetch first`)", () => {
      const msg =
        "git push failed (exit 1): To https://github.com/o/r.git\n" +
        " ! [rejected]        feature -> feature (fetch first)\n" +
        "error: failed to push some refs to 'https://github.com/o/r.git'\n" +
        "hint: Updates were rejected because the remote contains work";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });

    it("matches client-side `non-fast-forward` wording", () => {
      const msg = "! [rejected] main -> main (non-fast-forward)";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });

    it("matches server-side `cannot lock ref` (the case from #571)", () => {
      const msg =
        "remote: error: cannot lock ref 'refs/heads/feature': is at " +
        "abc123 but expected def456\n" +
        " ! [remote rejected] feature -> feature (cannot lock ref ...)";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });
  });

  describe("transient", () => {
    it("matches RPC failed with HTTP 502", () => {
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502",
        ),
      ).toBe("transient");
    });

    it("matches early EOF mid-pack", () => {
      expect(
        classifyPushError("fatal: the remote end hung up unexpectedly\nfatal: early EOF"),
      ).toBe("transient");
    });

    it("matches RPC failed", () => {
      expect(
        classifyPushError("fatal: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer"),
      ).toBe("transient");
    });

    it("matches HTTP/2 stream not closed cleanly", () => {
      expect(
        classifyPushError("fatal: HTTP/2 stream 7 was not closed cleanly: PROTOCOL_ERROR (err 1)"),
      ).toBe("transient");
    });

    it("matches DNS resolution failure", () => {
      expect(classifyPushError("fatal: Could not resolve host: github.com")).toBe("transient");
    });

    it("matches unexpected disconnect during sideband read", () => {
      expect(classifyPushError("fatal: unexpected disconnect while reading sideband packet")).toBe(
        "transient",
      );
    });

    it("classifies HTTP 429 (rate-limit / abuse detection) as transient", () => {
      // 429 is the documented exception to the otherwise-permanent 4xx class —
      // GitHub's abuse detection occasionally surfaces it on git push.
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429",
        ),
      ).toBe("transient");
      expect(classifyPushError("remote: HTTP 429: too many requests")).toBe("transient");
    });
  });

  describe("unknown", () => {
    it("does NOT classify auth/403 as transient", () => {
      // permission denied is permanent within a run — retrying just wastes
      // time. must NOT match the HTTP-5xx regex.
      expect(
        classifyPushError(
          "remote: Permission to o/r.git denied to bot.\n" +
            "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
        ),
      ).toBe("unknown");
    });

    it("does NOT classify protected-branch rejection as concurrent-push", () => {
      expect(
        classifyPushError(
          " ! [remote rejected] main -> main (push declined due to repository rule violations)",
        ),
      ).toBe("unknown");
    });

    it("does NOT classify 404 as transient", () => {
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404",
        ),
      ).toBe("unknown");
    });

    it("returns unknown for an empty message", () => {
      expect(classifyPushError("")).toBe("unknown");
    });
  });

  describe("ordering", () => {
    it("prefers concurrent-push over transient when both signals appear", () => {
      // a server-side cannot-lock-ref response that also includes an HTTP
      // 5xx in the libcurl envelope should still route to the recovery
      // path, not a blind retry.
      const msg =
        "remote: error: cannot lock ref 'refs/heads/feature': is at A but expected B\n" +
        "fatal: unable to access ...: The requested URL returned error: 500";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });
  });
});

describe("ref/tag validators", () => {
  it("rejectIfLeadingDash blocks values starting with '-'", () => {
    expect(() => rejectIfLeadingDash("--upload-pack=evil", "ref")).toThrow(/starts with '-'/);
    expect(() => rejectIfLeadingDash("main", "ref")).not.toThrow();
  });

  it("rejectSpecialRef blocks fully-qualified ref paths", () => {
    expect(() => rejectSpecialRef("refs/heads/main", "branch")).toThrow(/fully-qualified ref path/);
  });

  it("rejectSpecialRef blocks symbolic refs", () => {
    for (const ref of ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]) {
      expect(() => rejectSpecialRef(ref, "branch")).toThrow(/symbolic ref/);
    }
  });

  it("rejectSpecialRef blocks refspec/revision syntax characters", () => {
    for (const ref of ["evil:refs/heads/main", "+main", "main^", "ma~in", "a b", "a*", "a[b"]) {
      expect(() => rejectSpecialRef(ref, "branch")).toThrow(/refspec\/revision syntax/);
    }
  });

  it("rejectSpecialRef allows ordinary branch names", () => {
    expect(() => rejectSpecialRef("feature/foo-1.2", "branch")).not.toThrow();
    expect(() => rejectSpecialRef("pr-123", "branch")).not.toThrow();
  });

  it("validateTagName allows conservative tag names and blocks injection shapes", () => {
    expect(() => validateTagName("v1.2.3")).not.toThrow();
    expect(() => validateTagName("release/2026-06")).not.toThrow();
    expect(() => validateTagName("-v1")).toThrow(/starts with '-'/);
    expect(() => validateTagName("foo:refs/heads/main")).toThrow(/refspec or flag/);
    expect(() => validateTagName("a b")).toThrow(/refspec or flag/);
  });
});

describe("pushWithRetry backoff (via push_tags / delete_branch)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries transient failures with backoff and eventually succeeds", async () => {
    mocks.$git
      .mockRejectedValueOnce(new Error("fatal: RPC failed; HTTP 502"))
      .mockRejectedValueOnce(new Error("fatal: early EOF"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const t = PushTagsTool(makeCtx({ push: "enabled" }));
    const resultP = runTool(t, { tag: "v1.0.0", force: false });
    await vi.runAllTimersAsync();
    const result = await resultP;

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("v1.0.0");
    expect(mocks.$git).toHaveBeenCalledTimes(3);
    expect(mocks.$git).toHaveBeenCalledWith("push", ["origin", "refs/tags/v1.0.0"], {
      token: "test-token",
      disableHooks: true,
    });
  });

  it("gives up after exhausting all retry attempts and surfaces the final error", async () => {
    mocks.$git.mockRejectedValue(new Error("fatal: Could not resolve host: github.com"));

    const t = PushTagsTool(makeCtx({ push: "enabled" }));
    const resultP = runTool(t, { tag: "v2.0.0", force: false });
    await vi.runAllTimersAsync();
    const result = await resultP;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not resolve host");
    // 1 original attempt + 5 backoff retries
    expect(mocks.$git).toHaveBeenCalledTimes(6);
  });

  it("does not retry non-transient (unknown) errors", async () => {
    mocks.$git.mockRejectedValue(new Error("The requested URL returned error: 403"));

    const t = PushTagsTool(makeCtx({ push: "enabled" }));
    const resultP = runTool(t, { tag: "v3.0.0", force: false });
    await vi.runAllTimersAsync();
    const result = await resultP;

    expect(result.isError).toBe(true);
    expect(mocks.$git).toHaveBeenCalledTimes(1);
  });

  it("does not retry concurrent-push errors (they need caller intervention)", async () => {
    mocks.$git.mockRejectedValue(new Error("! [rejected] x -> x (non-fast-forward)"));

    const t = DeleteBranchTool(makeCtx({ push: "enabled" }));
    const resultP = runTool(t, { branchName: "feature" });
    await vi.runAllTimersAsync();
    const result = await resultP;

    expect(result.isError).toBe(true);
    expect(mocks.$git).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when a transient error turns into an unknown one", async () => {
    mocks.$git
      .mockRejectedValueOnce(new Error("fatal: RPC failed mid-stream"))
      .mockRejectedValueOnce(new Error("remote: Permission denied"));

    const t = PushTagsTool(makeCtx({ push: "enabled" }));
    const resultP = runTool(t, { tag: "v4.0.0", force: false });
    await vi.runAllTimersAsync();
    const result = await resultP;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Permission denied");
    expect(mocks.$git).toHaveBeenCalledTimes(2);
  });
});

describe("push_tags tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("requires push: enabled", async () => {
    const t = PushTagsTool(makeCtx({ push: "restricted" }));
    const result = await runTool(t, { tag: "v1", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires push: enabled");
    expect(mocks.$git).not.toHaveBeenCalled();
  });

  it("rejects tag names that could be parsed as refspecs", async () => {
    const t = PushTagsTool(makeCtx({ push: "enabled" }));
    const result = await runTool(t, { tag: "foo:refs/heads/main", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("refspec or flag");
  });

  it("adds -f when force is requested and honors shell: enabled hooks", async () => {
    mocks.$git.mockResolvedValue({ stdout: "", stderr: "" });
    const t = PushTagsTool(makeCtx({ push: "enabled", shell: "enabled" }));
    const result = await runTool(t, { tag: "v9", force: true });
    expect(result.isError).toBeUndefined();
    expect(mocks.$git).toHaveBeenCalledWith("push", ["-f", "origin", "refs/tags/v9"], {
      token: "test-token",
      disableHooks: false,
    });
  });
});

describe("delete_branch tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("requires push: enabled", async () => {
    const t = DeleteBranchTool(makeCtx({ push: "restricted" }));
    const result = await runTool(t, { branchName: "feature" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("requires push: enabled");
  });

  it("rejects refs/heads/... and symbolic-ref forms", async () => {
    const t = DeleteBranchTool(makeCtx({ push: "enabled" }));
    expect(textOf(await runTool(t, { branchName: "refs/heads/main" }))).toContain(
      "fully-qualified ref path",
    );
    expect(textOf(await runTool(t, { branchName: "HEAD" }))).toContain("symbolic ref");
    expect(textOf(await runTool(t, { branchName: ":other" }))).toContain("refspec/revision syntax");
  });

  it("blocks deleting the default branch even with push: enabled", async () => {
    const t = DeleteBranchTool(makeCtx({ push: "enabled", defaultBranch: "main" }));
    const result = await runTool(t, { branchName: "main" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot delete the default branch 'main'");
    expect(mocks.$git).not.toHaveBeenCalled();
  });

  it("deletes via an explicit refs/heads/ refspec so tags can't be hit", async () => {
    mocks.$git.mockResolvedValue({ stdout: "", stderr: "" });
    const t = DeleteBranchTool(makeCtx({ push: "enabled" }));
    const result = await runTool(t, { branchName: "feature" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("feature");
    expect(mocks.$git).toHaveBeenCalledWith("push", ["origin", "--delete", "refs/heads/feature"], {
      token: "test-token",
      disableHooks: true,
    });
  });
});

describe("git_fetch tool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects refs with a leading dash", async () => {
    const t = GitFetchTool(makeCtx());
    const result = await runTool(t, { ref: "--upload-pack=evil" });
    expect(result.isError).toBe(true);
    expect(mocks.$gitFetchWithDeepen).not.toHaveBeenCalled();
  });

  it("fetches the requested ref, appending --depth when provided", async () => {
    mocks.$gitFetchWithDeepen.mockResolvedValue({ stdout: "", stderr: "" });
    const t = GitFetchTool(makeCtx());

    expect((await runTool(t, { ref: "main" })).isError).toBeUndefined();
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledWith(
      ["--no-tags", "origin", "main"],
      { token: "test-token" },
      "git_fetch",
    );

    await runTool(t, { ref: "pull/12/head", depth: 1 });
    expect(mocks.$gitFetchWithDeepen).toHaveBeenCalledWith(
      ["--no-tags", "origin", "pull/12/head", "--depth=1"],
      { token: "test-token" },
      "git_fetch",
    );
  });
});

describe("git tool command validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects args[0] duplicating the subcommand (case-insensitive)", async () => {
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "status", args: ["STATUS"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("duplicates the subcommand");
    expect(mocks.$).not.toHaveBeenCalled();
  });

  it("redirects auth-required subcommands to the dedicated tools", async () => {
    const t = GitTool(makeCtx());
    for (const [command, redirect] of Object.entries(AUTH_REQUIRED_REDIRECT)) {
      const result = await runTool(t, { command });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(redirect);
    }
  });

  it("blocks dangerous subcommands when shell is disabled", async () => {
    const t = GitTool(makeCtx({ shell: "disabled" }));
    for (const [command, message] of Object.entries(NOSHELL_BLOCKED_SUBCOMMANDS)) {
      const result = await runTool(t, { command });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(message);
    }
    expect(mocks.$).not.toHaveBeenCalled();
  });

  it("allows those subcommands when shell is restricted (sandboxed shell exists)", async () => {
    dispatch({ "git config user.name": "someone" });
    const t = GitTool(makeCtx({ shell: "restricted" }));
    const result = await runTool(t, { command: "config", args: ["user.name"] });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("someone");
  });

  it("blocks code-executing arg flags (exact and = forms) when shell is disabled", async () => {
    const t = GitTool(makeCtx({ shell: "disabled" }));
    for (const flag of NOSHELL_BLOCKED_ARGS) {
      for (const arg of [flag, `${flag}=evil`]) {
        const result = await runTool(t, { command: "log", args: [arg] });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("can execute arbitrary code");
      }
    }
  });

  it("does not false-positive on flags that merely share a prefix (--exclude)", async () => {
    dispatch({ "git log --exclude=refs/x": "deadbeef commit" });
    const t = GitTool(makeCtx({ shell: "disabled" }));
    const result = await runTool(t, { command: "log", args: ["--exclude=refs/x"] });
    expect(result.isError).toBeUndefined();
  });

  it("passes through ordinary commands and returns their output", async () => {
    dispatch({ "git status": "On branch main" });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "status" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("On branch main");
  });

  it("collapses very long (but under-cap) output into a log group", async () => {
    const longOutput = Array.from({ length: 250 }, (_, i) => `line-${i}`).join("\n");
    dispatch({ "git log": longOutput });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "log" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("line-249");
  });
});

describe("git tool merge-base --is-ancestor exit-code handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns isAncestor: true on exit 0", async () => {
    mocks.$.mockReturnValue("");
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "merge-base", args: ["--is-ancestor", "a", "b"] });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/isAncestor.*true/);
  });

  it("treats exit 1 as data (not an ancestor), not an error", async () => {
    mocks.$.mockImplementation((_cmd, _args, opts) => {
      opts?.onError?.({ status: 1, stdout: "", stderr: "" });
      return "";
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "merge-base", args: ["--is-ancestor", "a", "b"] });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/isAncestor.*false/);
  });

  it("surfaces exit codes > 1 as real errors with stderr detail", async () => {
    mocks.$.mockImplementation((_cmd, _args, opts) => {
      opts?.onError?.({ status: 128, stdout: "", stderr: "fatal: bad revision 'nope'" });
      return "";
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, {
      command: "merge-base",
      args: ["--is-ancestor", "nope", "b"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("exit 128");
    expect(textOf(result)).toContain("bad revision");
  });
});

describe("git tool symmetric-diff trap", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects a bare ref diff when the ref has commits HEAD lacks", async () => {
    dispatch({ "git rev-list --count HEAD..origin/main": "3" });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["origin/main"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("inverse of 3 commit(s)");
    expect(textOf(result)).toContain("--merge-base origin/main");
  });

  it("allows a bare ref diff against an ancestor (HEAD strictly ahead)", async () => {
    dispatch({
      "git rev-list --count HEAD..origin/main": "0",
      "git diff origin/main": "diff body",
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["origin/main"] });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("diff body");
  });

  it("rejects a two-dot range only when BOTH sides have unique commits", async () => {
    dispatch({
      "git rev-list --count b..a": "2",
      "git rev-list --count a..b": "5",
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["a..b"] });
    expect(result.isError).toBe(true);
    // the more-ahead side is named in the recovery instructions
    expect(textOf(result)).toContain("inverse of 5 commit(s)");
    expect(textOf(result)).toContain("'b'");
  });

  it("allows a degenerate two-dot range (one side is an ancestor)", async () => {
    dispatch({
      "git rev-list --count b..a": "0",
      "git rev-list --count a..b": "4",
      "git diff a..b": "ok",
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["a..b"] });
    expect(result.isError).toBeUndefined();
  });

  it("expands the `A..` shorthand to `A..HEAD`", async () => {
    dispatch({
      "git rev-list --count HEAD..a": "1",
      "git rev-list --count a..HEAD": "1",
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["a.."] });
    expect(result.isError).toBe(true);
  });

  it("never blocks three-dot (merge-base) diffs", async () => {
    dispatch({ "git diff a...b": "merge-base diff" });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["a...b"] });
    expect(result.isError).toBeUndefined();
  });

  it("never blocks --merge-base diffs and probes nothing", async () => {
    dispatch({ "git diff --merge-base origin/main": "mb diff" });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "diff", args: ["--merge-base", "origin/main"] });
    expect(result.isError).toBeUndefined();
    expect(mocks.$).toHaveBeenCalledTimes(1);
  });

  it("ignores pathspecs after -- and unresolvable refs", async () => {
    dispatch({
      // rev-list probe for the pathspec-looking positional throws (unresolvable)
      "git rev-list --count HEAD..src/foo.ts": () => {
        throw new Error("fatal: bad revision");
      },
      "git diff src/foo.ts -- origin/main": "diff",
    });
    const t = GitTool(makeCtx());
    const result = await runTool(t, {
      command: "diff",
      args: ["src/foo.ts", "--", "origin/main"],
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("git tool huge-output spill", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("TERRAMEND_TEMP_DIR", tmpdir());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("spills >50K-char output to a tmp file and returns a head preview", async () => {
    const body = Array.from({ length: 2000 }, (_, i) => `log-line-${i} ${"x".repeat(30)}`).join(
      "\n",
    );
    expect(body.length).toBeGreaterThan(50_000);
    dispatch({ "git log": body });

    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "log" });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("log-line-0");
    expect(text).toContain("log-line-49");
    expect(text).not.toContain("log-line-1999");
    expect(text).toContain("output truncated");

    // the full body is persisted to the path named in the response
    const match = text.match(/saved to (\S*git-log-[0-9a-f]{8}\.txt)/);
    expect(match).not.toBeNull();
    const savedPath = match?.[1] ?? "";
    expect(readFileSync(savedPath, "utf-8")).toBe(body);
  });

  it("caps the inline preview when the head lines are themselves huge", async () => {
    const body = "y".repeat(60_001);
    dispatch({ "git show": body });

    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "show" });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("…");
    expect(text).toContain("output truncated");
    // preview is hard-capped at 5000 chars + ellipsis, not the whole line
    const previewLine = text.split("\n")[0] ?? "";
    expect(previewLine.length).toBeLessThanOrEqual(5_001);
  });

  it("errors when TERRAMEND_TEMP_DIR is unset", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", "");
    dispatch({ "git log": "z".repeat(50_001) });
    const t = GitTool(makeCtx());
    const result = await runTool(t, { command: "log" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TERRAMEND_TEMP_DIR not set");
  });
});

describe("push_branch tool", () => {
  const REMOTE_URL = "https://github.com/o/r.git";

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.$git.mockResolvedValue({ stdout: "", stderr: "" });
  });

  /** dispatch table for a clean push of local `feature` to origin/feature */
  function happyDispatch(extra: Record<string, DollarResponse | DollarResponse[]> = {}): void {
    dispatch({
      "git status --porcelain": "",
      "git remote get-url --push origin": REMOTE_URL,
      "git rev-parse HEAD": "abc1234",
      ...extra,
    });
  }

  function featureCtx(over: CtxOverrides = {}): ToolContext {
    return makeCtx({
      pushDest: { remoteName: "origin", remoteBranch: "feature", localBranch: "feature" },
      ...over,
    });
  }

  it("refuses to push when push is disabled", async () => {
    const t = PushBranchTool(makeCtx({ push: "disabled" }));
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("read-only");
  });

  it("rejects special-ref branch names before touching git", async () => {
    const t = PushBranchTool(makeCtx());
    const result = await runTool(t, { branchName: "refs/heads/main", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("fully-qualified ref path");
    expect(mocks.$).not.toHaveBeenCalled();
  });

  it("resolves the current branch from HEAD when branchName is omitted", async () => {
    happyDispatch({ "git rev-parse --abbrev-ref HEAD": "feature" });
    const t = PushBranchTool(featureCtx());
    const result = await runTool(t, { force: false });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("successfully pushed feature to origin/feature");
  });

  it("blocks pushing from a dirty working tree, including the status output", async () => {
    dispatch({ "git status --porcelain": " M main.tf\n?? stray.txt" });
    const t = PushBranchTool(featureCtx());
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("working tree is not clean");
    expect(textOf(result)).toContain(" M main.tf");
    expect(textOf(result)).not.toContain("prepush hook failed earlier");
  });

  it("mentions the earlier prepush failure in the dirty-tree error", async () => {
    dispatch({ "git status --porcelain": " M main.tf" });
    const t = PushBranchTool(featureCtx({ prepushFailureCount: 1 }));
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(textOf(result)).toContain("prepush hook failed earlier this run");
  });

  it("fails fast when pushUrl was never set by setupGit", async () => {
    dispatch({ "git status --porcelain": "" });
    const t = PushBranchTool(featureCtx({ pushUrl: undefined }));
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pushUrl not set");
  });

  it("blocks pushes whose destination URL does not match the expected repo", async () => {
    dispatch({
      "git status --porcelain": "",
      "git remote get-url --push origin": "https://github.com/evil/r.git",
    });
    const t = PushBranchTool(featureCtx());
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("destination does not match expected repository");
    expect(textOf(result)).toContain("tampered");
  });

  it("falls back to branch config when no stored destination matches", async () => {
    dispatch({
      "git status --porcelain": "",
      "git config branch.feature.pushRemote": "upstream",
      "git config branch.feature.merge": "refs/heads/topic",
      "git remote get-url --push upstream": REMOTE_URL,
      "git rev-parse HEAD": "abc1234",
    });
    const t = PushBranchTool(makeCtx());
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBeUndefined();
    // local and remote branch names differ -> refspec form
    expect(mocks.$git).toHaveBeenCalledWith("push", ["-u", "upstream", "feature:topic"], {
      token: "test-token",
      disableHooks: true,
    });
    expect(textOf(result)).toContain("successfully pushed feature to upstream/topic");
  });

  it("falls back to origin/<branch> when the branch has no push config", async () => {
    dispatch({
      "git status --porcelain": "",
      "git config branch.feature.pushRemote": () => {
        throw new Error("Command failed with exit code 1");
      },
      "git remote get-url --push origin": REMOTE_URL,
      "git rev-parse HEAD": "abc1234",
    });
    const t = PushBranchTool(makeCtx());
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBeUndefined();
    expect(mocks.$git).toHaveBeenCalledWith("push", ["-u", "origin", "feature"], {
      token: "test-token",
      disableHooks: true,
    });
  });

  it("blocks pr-N pushes to a foreign remote branch when the run is not scoped to PR N", async () => {
    dispatch({
      "git status --porcelain": "",
      "git remote get-url --push origin": REMOTE_URL,
    });
    const t = PushBranchTool(
      makeCtx({
        pushDest: {
          remoteName: "origin",
          remoteBranch: "someone-elses-branch",
          localBranch: "pr-7",
        },
        event: { is_pr: true, issue_number: 8 },
      }),
    );
    const result = await runTool(t, { branchName: "pr-7", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not scoped to PR #7");
    expect(textOf(result)).toContain("wrong branch");
    expect(mocks.$git).not.toHaveBeenCalled();
  });

  it("allows pr-N pushes to a differing remote branch when the run IS scoped to PR N", async () => {
    dispatch({
      "git status --porcelain": "",
      "git remote get-url --push origin": REMOTE_URL,
      "git rev-parse HEAD": "abc1234",
    });
    const t = PushBranchTool(
      makeCtx({
        pushDest: { remoteName: "origin", remoteBranch: "their-branch", localBranch: "pr-7" },
        event: { is_pr: true, issue_number: 7 },
      }),
    );
    const result = await runTool(t, { branchName: "pr-7", force: false });
    expect(result.isError).toBeUndefined();
    expect(mocks.$git).toHaveBeenCalledWith("push", ["-u", "origin", "pr-7:their-branch"], {
      token: "test-token",
      disableHooks: true,
    });
  });

  it("blocks pushes to the default branch in restricted mode", async () => {
    dispatch({
      "git status --porcelain": "",
      "git remote get-url --push origin": REMOTE_URL,
    });
    const t = PushBranchTool(
      makeCtx({
        push: "restricted",
        pushDest: { remoteName: "origin", remoteBranch: "main", localBranch: "feature" },
      }),
    );
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot push directly to default branch 'main'");
  });

  it("uses --force and reports it in the result", async () => {
    happyDispatch();
    const t = PushBranchTool(featureCtx());
    const result = await runTool(t, { branchName: "feature", force: true });
    expect(result.isError).toBeUndefined();
    expect(mocks.$git).toHaveBeenCalledWith("push", ["--force", "-u", "origin", "feature"], {
      token: "test-token",
      disableHooks: true,
    });
  });

  it("renders concurrent-push recovery instructions (merge-only under shell: disabled)", async () => {
    happyDispatch();
    mocks.$git.mockRejectedValue(
      new Error("! [rejected] feature -> feature (fetch first)\nhint: Updates were rejected"),
    );
    const t = PushBranchTool(featureCtx({ shell: "disabled" }));
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("push rejected: the remote branch 'feature' has new commits");
    expect(text).toContain('git_fetch({ ref: "feature" })');
    expect(text).toContain('git({ command: "merge", args: ["origin/feature"] })');
    expect(text).not.toContain("rebase");
    expect(text).toContain("retry push_branch");
  });

  it("offers rebase as an alternative in the recovery when shell is not disabled", async () => {
    happyDispatch();
    mocks.$git.mockRejectedValue(new Error("! [rejected] feature -> feature (non-fast-forward)"));
    const t = PushBranchTool(featureCtx({ shell: "enabled" }));
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(textOf(result)).toContain("(or 'rebase')");
  });

  it("rethrows non-concurrent push errors verbatim", async () => {
    happyDispatch();
    mocks.$git.mockRejectedValue(new Error("remote rejected (repository rule violations)"));
    const t = PushBranchTool(featureCtx());
    const result = await runTool(t, { branchName: "feature", force: false });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("repository rule violations");
  });

  describe("prepush hook handling", () => {
    it("runs the hook and pushes when it succeeds without mutating the tree", async () => {
      dispatch({
        "git status --porcelain": ["", ""],
        "git remote get-url --push origin": REMOTE_URL,
        "git rev-parse HEAD": "abc1234",
      });
      mocks.executeLifecycleHook.mockResolvedValue({});
      const t = PushBranchTool(featureCtx({ prepushScript: "make check" }));
      const result = await runTool(t, { branchName: "feature", force: false });
      expect(result.isError).toBeUndefined();
      expect(mocks.executeLifecycleHook).toHaveBeenCalledWith({
        event: "prepush",
        script: "make check",
      });
    });

    it("renders exit failures with script output and disabled-shell guidance", async () => {
      happyDispatch();
      mocks.executeLifecycleHook.mockResolvedValue({
        failure: { kind: "exit", exitCode: 2, output: "lint exploded" },
      });
      const ctx = featureCtx({ prepushScript: "make check", shell: "disabled" });
      const result = await runTool(PushBranchTool(ctx), { branchName: "feature", force: false });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("prepush hook failed with exit code 2");
      expect(text).toContain("lint exploded");
      expect(text).toContain("shell access is disabled");
      expect(text).toContain("next push_branch call will SKIP the hook");
      expect(
        (ctx as unknown as { toolState: { prepushFailureCount: number } }).toolState
          .prepushFailureCount,
      ).toBe(1);
      expect(mocks.$git).not.toHaveBeenCalled();
    });

    it("renders timeout failures with shell-enabled iterate guidance", async () => {
      happyDispatch();
      mocks.executeLifecycleHook.mockResolvedValue({ failure: { kind: "timeout" } });
      const ctx = featureCtx({ prepushScript: "make check", shell: "enabled" });
      const result = await runTool(PushBranchTool(ctx), { branchName: "feature", force: false });
      const text = textOf(result);
      expect(text).toContain("timed out");
      expect(text).toContain("run the hook command yourself via the shell tool");
    });

    it("renders spawn failures", async () => {
      happyDispatch();
      mocks.executeLifecycleHook.mockResolvedValue({
        failure: { kind: "spawn", spawnError: "ENOENT" },
      });
      const ctx = featureCtx({ prepushScript: "make check" });
      const result = await runTool(PushBranchTool(ctx), { branchName: "feature", force: false });
      expect(textOf(result)).toContain("failed to spawn: ENOENT");
    });

    it("blocks the push when the hook mutates tracked files", async () => {
      dispatch({
        "git status --porcelain": ["", " M generated.ts"],
        "git remote get-url --push origin": REMOTE_URL,
      });
      mocks.executeLifecycleHook.mockResolvedValue({});
      const t = PushBranchTool(featureCtx({ prepushScript: "make check" }));
      const result = await runTool(t, { branchName: "feature", force: false });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("the prepush hook modified the working tree");
      expect(text).toContain(" M generated.ts");
      expect(mocks.$git).not.toHaveBeenCalled();
    });

    it("skips the hook after an earlier failure and says so in the result", async () => {
      happyDispatch();
      const t = PushBranchTool(featureCtx({ prepushScript: "make check", prepushFailureCount: 1 }));
      const result = await runTool(t, { branchName: "feature", force: false });
      expect(result.isError).toBeUndefined();
      expect(mocks.executeLifecycleHook).not.toHaveBeenCalled();
      expect(textOf(result)).toContain("prepush hook skipped");
    });
  });
});
