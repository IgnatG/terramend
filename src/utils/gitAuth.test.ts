import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitAuthServer } from "#app/utils/gitAuthServer";

const execSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const realpathSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const spawnMock = vi.fn();
const shellMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  realpathSync: (...args: unknown[]) => realpathSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

vi.mock("#app/utils/subprocess", () => ({
  spawn: (params: unknown) => spawnMock(params),
}));

vi.mock("#app/utils/shell", () => ({
  $: (...args: unknown[]) => shellMock(...args),
}));

vi.mock("#app/utils/secrets", () => ({
  filterEnv: () => ({ PATH: "/usr/bin" }),
}));

type GitAuthModule = typeof import("#app/utils/gitAuth");

// resolveGit/setGitAuthServer mutate module-level state — each test gets a
// fresh module instance.
async function loadGitAuth(): Promise<GitAuthModule> {
  vi.resetModules();
  return await import("#app/utils/gitAuth");
}

function makeAuthServer(): GitAuthServer {
  return {
    port: 45678,
    register: vi.fn(() => "code-1234"),
    revoke: vi.fn(),
    writeAskpassScript: vi.fn(() => "/tmp/askpass-test.js"),
    close: vi.fn(async () => {}),
    [Symbol.asyncDispose]: async () => {},
  };
}

/** loads a fresh module with resolveGit() done and a fake auth server installed. */
async function loadReadyGitAuth(): Promise<{ gitAuth: GitAuthModule; authServer: GitAuthServer }> {
  const gitAuth = await loadGitAuth();
  execSyncMock.mockReturnValueOnce("/usr/bin/git\n");
  realpathSyncMock.mockReturnValueOnce("/usr/libexec/git-core/git");
  readFileSyncMock.mockReturnValue(Buffer.from("git-binary-bytes"));
  gitAuth.resolveGit();
  const authServer = makeAuthServer();
  gitAuth.setGitAuthServer(authServer);
  return { gitAuth, authServer };
}

function okSpawnResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { stdout: "ok\n", stderr: "", exitCode: 0, ...overrides };
}

beforeEach(() => {
  spawnMock.mockResolvedValue(okSpawnResult());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveGit / verifyGitBinary", () => {
  it("resolves the git path through which + realpath and fingerprints it", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    expect(execSyncMock).toHaveBeenCalledWith("which git", { encoding: "utf-8" });
    expect(realpathSyncMock).toHaveBeenCalledWith("/usr/bin/git");

    await gitAuth.$git("fetch", ["origin"], { token: "tok" });
    const spawnParams = spawnMock.mock.calls[0]?.[0] as { cmd: string };
    expect(spawnParams.cmd).toBe("/usr/libexec/git-core/git");
  });

  it("$git refuses to run before resolveGit()", async () => {
    const gitAuth = await loadGitAuth();
    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      /git binary not initialized/,
    );
  });

  it("$git refuses to run when the binary hash changed since startup", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    readFileSyncMock.mockReturnValue(Buffer.from("tampered-binary-bytes"));
    await expect(gitAuth.$git("push", ["origin", "main"], { token: "tok" })).rejects.toThrow(
      /git binary tampered/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("$git refuses to run before setGitAuthServer()", async () => {
    const gitAuth = await loadGitAuth();
    execSyncMock.mockReturnValueOnce("/usr/bin/git\n");
    realpathSyncMock.mockReturnValueOnce("/usr/bin/git");
    readFileSyncMock.mockReturnValue(Buffer.from("git-binary-bytes"));
    gitAuth.resolveGit();
    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      /git auth server not initialized/,
    );
  });
});

describe("$git invocation hardening", () => {
  it("pins core.hooksPath=/dev/null by default (security control)", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    await gitAuth.$git("push", ["origin", "feature"], { token: "tok" });

    const spawnParams = spawnMock.mock.calls[0]?.[0] as { args: string[] };
    const args = spawnParams.args;
    const hooksFlagIndex = args.indexOf("core.hooksPath=/dev/null");
    expect(hooksFlagIndex).toBeGreaterThan(0);
    expect(args[hooksFlagIndex - 1]).toBe("-c");
    // the pin must come BEFORE the subcommand so it acts as a config override
    expect(hooksFlagIndex).toBeLessThan(args.indexOf("push"));
  });

  it("keeps the hooksPath pin when disableHooks is explicitly true", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    await gitAuth.$git("push", ["origin", "feature"], { token: "tok", disableHooks: true });

    const spawnParams = spawnMock.mock.calls[0]?.[0] as { args: string[] };
    expect(spawnParams.args).toContain("core.hooksPath=/dev/null");
  });

  it("omits the hooksPath pin only when disableHooks is explicitly false", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    await gitAuth.$git("push", ["origin", "feature"], { token: "tok", disableHooks: false });

    const spawnParams = spawnMock.mock.calls[0]?.[0] as { args: string[] };
    expect(spawnParams.args).not.toContain("core.hooksPath=/dev/null");
    // the other -c overrides stay in place regardless
    expect(spawnParams.args).toContain("credential.helper=");
  });

  it("passes the full defense-in-depth -c overrides and askpass env", async () => {
    const { gitAuth, authServer } = await loadReadyGitAuth();
    const result = await gitAuth.$git("fetch", ["origin", "main"], {
      token: "tok",
      cwd: "/work/repo",
    });

    expect(result).toEqual({ stdout: "ok", stderr: "" });
    expect(authServer.register).toHaveBeenCalledWith("tok");
    expect(authServer.writeAskpassScript).toHaveBeenCalledWith("code-1234");

    const spawnParams = spawnMock.mock.calls[0]?.[0] as {
      args: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(spawnParams.cwd).toBe("/work/repo");
    expect(spawnParams.args).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      "-c",
      "protocol.file.allow=never",
      "-c",
      "core.sshCommand=ssh",
      "-c",
      "core.hooksPath=/dev/null",
      "fetch",
      "origin",
      "main",
    ]);
    expect(spawnParams.env.GIT_ASKPASS).toBe("/tmp/askpass-test.js");
    expect(spawnParams.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(spawnParams.env.GIT_CONFIG_COUNT).toBe("0");
    expect(spawnParams.env.GIT_CONFIG_PARAMETERS).toBe("");
    // token must never appear in the subprocess env
    expect(Object.values(spawnParams.env)).not.toContain("tok");
  });

  it("revokes the code and deletes the askpass script even on success", async () => {
    const { gitAuth, authServer } = await loadReadyGitAuth();
    await gitAuth.$git("fetch", ["origin"], { token: "tok" });

    expect(authServer.revoke).toHaveBeenCalledWith("code-1234");
    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/askpass-test.js");
  });

  it("revokes the code when spawn rejects, and swallows unlink failures", async () => {
    const { gitAuth, authServer } = await loadReadyGitAuth();
    spawnMock.mockRejectedValueOnce(new Error("spawn blew up"));
    unlinkSyncMock.mockImplementationOnce(() => {
      throw new Error("already gone");
    });

    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      "spawn blew up",
    );
    expect(authServer.revoke).toHaveBeenCalledWith("code-1234");
  });

  it("treats askpass-compromised stderr as a fatal auth failure", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock.mockResolvedValueOnce(
      okSpawnResult({ stderr: "askpass-compromised\n", exitCode: 0 }),
    );
    await expect(gitAuth.$git("push", ["origin", "x"], { token: "tok" })).rejects.toThrow(
      /askpass code was replayed after revoke/,
    );
  });

  it("surfaces stderr and stdout detail on non-zero exit", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock.mockResolvedValueOnce(
      okSpawnResult({ exitCode: 128, stderr: "fatal: not a repo", stdout: "smart-proto detail" }),
    );
    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      "git fetch failed (exit 128): fatal: not a repo\n--- stdout ---\nsmart-proto detail",
    );
  });

  it("falls back to stdout-only detail, then to (no output)", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock.mockResolvedValueOnce(okSpawnResult({ exitCode: 1, stderr: "", stdout: "only out" }));
    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      "git fetch failed (exit 1): only out",
    );

    spawnMock.mockResolvedValueOnce(okSpawnResult({ exitCode: 1, stderr: "", stdout: "" }));
    await expect(gitAuth.$git("fetch", ["origin"], { token: "tok" })).rejects.toThrow(
      "git fetch failed (exit 1): (no output)",
    );
  });
});

describe("$gitFetchWithDeepen", () => {
  it("passes through on first-attempt success", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    const result = await gitAuth.$gitFetchWithDeepen(["origin", "main"], { token: "tok" });
    expect(result.stdout).toBe("ok");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(shellMock).not.toHaveBeenCalled();
  });

  it("rethrows non-shallow-unreachable errors unchanged", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock.mockResolvedValueOnce(okSpawnResult({ exitCode: 1, stderr: "permission denied" }));
    await expect(gitAuth.$gitFetchWithDeepen(["origin", "main"], { token: "tok" })).rejects.toThrow(
      /permission denied/,
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("stringifies non-Error rejections when checking for shallow-unreachable", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock.mockRejectedValueOnce("raw string failure");
    await expect(gitAuth.$gitFetchWithDeepen(["origin"], { token: "tok" })).rejects.toBe(
      "raw string failure",
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows shallow-unreachable errors when the repo is not shallow", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    const oid = "a".repeat(40);
    spawnMock.mockResolvedValueOnce(
      okSpawnResult({ exitCode: 1, stderr: `fatal: Could not read ${oid}` }),
    );
    shellMock.mockReturnValueOnce("false\n");

    await expect(gitAuth.$gitFetchWithDeepen(["origin", "main"], { token: "tok" })).rejects.toThrow(
      /Could not read/,
    );
    expect(shellMock).toHaveBeenCalledWith("git", ["rev-parse", "--is-shallow-repository"], {
      log: false,
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("retries once with --deepen and strips caller --depth on shallow repos", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    const oid = "b".repeat(64);
    spawnMock
      .mockResolvedValueOnce(okSpawnResult({ exitCode: 1, stderr: `Could not read ${oid}` }))
      .mockResolvedValueOnce(okSpawnResult({ stdout: "deepened" }));
    shellMock.mockReturnValueOnce("true\n");

    const result = await gitAuth.$gitFetchWithDeepen(
      ["--depth=50", "origin", "main"],
      { token: "tok" },
      "checkout fetch",
    );

    expect(result.stdout).toBe("deepened");
    const retryParams = spawnMock.mock.calls[1]?.[0] as { args: string[] };
    expect(retryParams.args).toContain("--deepen=1000");
    expect(retryParams.args).not.toContain("--depth=50");
  });

  it("also recovers from the 'remote did not send all necessary objects' wording", async () => {
    const { gitAuth } = await loadReadyGitAuth();
    spawnMock
      .mockResolvedValueOnce(
        okSpawnResult({ exitCode: 1, stderr: "remote did not send all necessary objects" }),
      )
      .mockResolvedValueOnce(okSpawnResult({ stdout: "deepened" }));
    shellMock.mockReturnValueOnce("true");

    const result = await gitAuth.$gitFetchWithDeepen(["origin", "main"], { token: "tok" });
    expect(result.stdout).toBe("deepened");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
