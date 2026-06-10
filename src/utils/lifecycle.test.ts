import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_HOOK_TIMEOUT_MS } from "#app/lifecycle";
import { describeSetupFailure, executeLifecycleHook } from "#app/utils/lifecycle";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "#app/utils/subprocess";

// executeLifecycleHook shells out (bash for the hook, git for the
// normalize-after pass) — mock spawn so the tests stay subprocess-free and
// OS-independent. error classes / codes stay real.
vi.mock("#app/utils/subprocess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/subprocess")>();
  return { ...actual, spawn: vi.fn() };
});

const spawnMock = vi.mocked(spawn);

function ok(stdout = "", stderr = "", exitCode = 0) {
  return { stdout, stderr, exitCode, durationMs: 1 };
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue(ok());
});

describe("LIFECYCLE_HOOK_TIMEOUT_MS", () => {
  it("is ten minutes", () => {
    expect(LIFECYCLE_HOOK_TIMEOUT_MS).toBe(600_000);
  });
});

describe("describeSetupFailure", () => {
  it("returns an empty string when there was no failure", () => {
    expect(describeSetupFailure(undefined)).toBe("");
  });

  it("describes a non-zero exit with its output", () => {
    const text = describeSetupFailure({ kind: "exit", exitCode: 3, output: "pnpm install died" });
    expect(text).toContain("exited with code 3");
    expect(text).toContain("pnpm install died");
  });

  it("falls back to (empty) when the exit produced no output", () => {
    expect(describeSetupFailure({ kind: "exit", exitCode: 1, output: "" })).toContain("(empty)");
  });

  it("describes a timeout", () => {
    expect(describeSetupFailure({ kind: "timeout" })).toContain("timed out");
  });

  it("describes a spawn failure with the spawn error", () => {
    expect(describeSetupFailure({ kind: "spawn", spawnError: "ENOENT bash" })).toContain(
      "failed to start: ENOENT bash",
    );
  });
});

describe("executeLifecycleHook", () => {
  it("is a no-op when no script is configured", async () => {
    const result = await executeLifecycleHook({ event: "setup", script: null });
    expect(result).toEqual({});
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns no warning when the hook exits 0", async () => {
    const result = await executeLifecycleHook({ event: "setup", script: "true" });
    expect(result).toEqual({});
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0]?.[0];
    expect(opts?.cmd).toBe("bash");
    expect(opts?.args).toEqual(["-c", "true"]);
    expect(opts?.timeout).toBe(LIFECYCLE_HOOK_TIMEOUT_MS);
  });

  it("returns a structured exit failure with stderr preferred over stdout", async () => {
    spawnMock.mockResolvedValue(ok("stdout text", "stderr text\n", 2));
    const result = await executeLifecycleHook({ event: "setup", script: "exit 2" });
    expect(result.failure).toEqual({ kind: "exit", exitCode: 2, output: "stderr text" });
    expect(result.warning).toContain("failed with exit code 2");
    expect(result.warning).toContain("stderr text");
  });

  it("falls back to stdout when stderr is empty", async () => {
    spawnMock.mockResolvedValue(ok("only stdout\n", "", 1));
    const result = await executeLifecycleHook({ event: "post-checkout", script: "exit 1" });
    expect(result.failure).toEqual({ kind: "exit", exitCode: 1, output: "only stdout" });
  });

  it("classifies a spawn timeout as a non-retryable timeout failure", async () => {
    spawnMock.mockRejectedValue(new SpawnTimeoutError("hook timed out", SPAWN_TIMEOUT_CODE));
    const result = await executeLifecycleHook({ event: "setup", script: "sleep 9999" });
    expect(result.failure).toEqual({ kind: "timeout" });
    expect(result.warning).toContain("timed out after 10min");
    expect(result.warning).toContain("do NOT retry");
  });

  it("classifies an activity timeout as a timeout failure too", async () => {
    spawnMock.mockRejectedValue(new SpawnTimeoutError("idle", SPAWN_ACTIVITY_TIMEOUT_CODE));
    const result = await executeLifecycleHook({ event: "setup", script: "sleep 9999" });
    expect(result.failure).toEqual({ kind: "timeout" });
  });

  it("classifies any other throw as a retryable spawn failure", async () => {
    spawnMock.mockRejectedValue(new Error("ENOENT: bash not found"));
    const result = await executeLifecycleHook({ event: "setup", script: "true" });
    expect(result.failure).toEqual({ kind: "spawn", spawnError: "ENOENT: bash not found" });
    expect(result.warning).toContain("failed to spawn");
    expect(result.warning).toContain("retry the operation");
  });

  describe("normalizeWorkingTreeAfter", () => {
    function gitCalls(): string[][] {
      return spawnMock.mock.calls
        .map((c) => c[0])
        .filter((opts) => opts?.cmd === "git")
        .map((opts) => opts?.args ?? []);
    }

    it("discards tracked drift the hook introduced on a previously clean tree", async () => {
      // call order: git diff (pre) → bash hook → git diff (post) → git restore
      let diffCalls = 0;
      spawnMock.mockImplementation(async (opts) => {
        if (opts.cmd === "git" && opts.args?.[0] === "diff") {
          diffCalls += 1;
          return ok(diffCalls === 1 ? "" : "pnpm-lock.yaml\npackage.json\n");
        }
        return ok();
      });
      const result = await executeLifecycleHook({
        event: "setup",
        script: "pnpm install",
        normalizeWorkingTreeAfter: true,
      });
      expect(result).toEqual({});
      expect(gitCalls()).toEqual([
        ["diff", "--name-only", "HEAD"],
        ["diff", "--name-only", "HEAD"],
        ["restore", "--staged", "--worktree", "."],
      ]);
    });

    it("skips normalization when the tree had pre-existing tracked changes", async () => {
      spawnMock.mockImplementation(async (opts) => {
        if (opts.cmd === "git" && opts.args?.[0] === "diff") return ok("preexisting.ts\n");
        return ok();
      });
      await executeLifecycleHook({
        event: "setup",
        script: "pnpm install",
        normalizeWorkingTreeAfter: true,
      });
      // only the pre-hook snapshot ran; no post-hook diff, no restore.
      expect(gitCalls()).toEqual([["diff", "--name-only", "HEAD"]]);
    });

    it("does nothing when the hook leaves the tree clean", async () => {
      await executeLifecycleHook({
        event: "setup",
        script: "true",
        normalizeWorkingTreeAfter: true,
      });
      expect(gitCalls()).toEqual([
        ["diff", "--name-only", "HEAD"],
        ["diff", "--name-only", "HEAD"],
      ]);
    });

    it("still normalizes when the hook itself failed", async () => {
      let diffCalls = 0;
      spawnMock.mockImplementation(async (opts) => {
        if (opts.cmd === "git" && opts.args?.[0] === "diff") {
          diffCalls += 1;
          return ok(diffCalls === 1 ? "" : "pnpm-lock.yaml\n");
        }
        if (opts.cmd === "bash") return ok("", "boom", 1);
        return ok();
      });
      const result = await executeLifecycleHook({
        event: "setup",
        script: "pnpm install && exit 1",
        normalizeWorkingTreeAfter: true,
      });
      expect(result.failure).toEqual({ kind: "exit", exitCode: 1, output: "boom" });
      expect(gitCalls()).toEqual([
        ["diff", "--name-only", "HEAD"],
        ["diff", "--name-only", "HEAD"],
        ["restore", "--staged", "--worktree", "."],
      ]);
    });
  });
});
