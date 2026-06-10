import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OctokitWithPlugins } from "#app/utils/github";
import {
  captureInitialHead,
  createTempDirectory,
  removeIncludeIfEntries,
  type SetupGitParams,
  setupGit,
  setupTestRepo,
  wipeRunnerLeakSurface,
} from "#app/utils/setup";
import { $ } from "#app/utils/shell";

// pass-through wrappers: the real-git suites below keep their original
// behavior, while the mocked suites override implementations per test and
// restore them via mockReset (vi.fn(impl) resets back to `impl`).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
    execFileSync: vi.fn(actual.execFileSync),
  };
});

vi.mock("#app/utils/shell", () => ({ $: vi.fn(() => "") }));

vi.mock("#app/utils/globals", () => ({
  isCloudflareSandbox: false,
  isGitHubActions: false,
  isInsideDocker: false,
}));

describe("removeIncludeIfEntries", () => {
  let repoDir: string;

  // git push sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE for pre-push hooks
  // and those propagate to execSync's child processes by default. a `git init`
  // inheriting GIT_DIR from the outer repo modifies the outer repo's config
  // rather than creating one in `repoDir`, which makes subsequent writeFileSync
  // on `repoDir/.git/config` fail with ENOENT and masquerades as a test bug.
  // strip the git-specific env vars so this suite runs identically whether
  // invoked directly, via `pnpm -r test`, or via a pre-push hook.
  const cleanEnv = (() => {
    const next = { ...process.env };
    for (const k of Object.keys(next)) {
      if (k.startsWith("GIT_")) delete next[k];
    }
    return next;
  })();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "terramend-setup-test-"));
    execSync("git init -q", { cwd: repoDir, env: cleanEnv });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("removes a benign includeIf.gitdir entry", () => {
    execSync('git config --local "includeIf.gitdir:/work/.gitconfig" "/tmp/included-config"', {
      cwd: repoDir,
      env: cleanEnv,
    });
    expect(
      execSync('git config --local --get-all "includeIf.gitdir:/work/.gitconfig"', {
        cwd: repoDir,
        encoding: "utf-8",
        env: cleanEnv,
      }).trim(),
    ).toBe("/tmp/included-config");

    removeIncludeIfEntries(repoDir);

    expect(() =>
      execSync('git config --local --get-all "includeIf.gitdir:/work/.gitconfig"', {
        cwd: repoDir,
        stdio: "pipe",
        env: cleanEnv,
      }),
    ).toThrow();
  });

  it("does not execute $(...) command substitution embedded in a subsection name", () => {
    // regression: setup previously did
    //   execSync(`git config --local --unset "${key}"`)
    // where `key` was derived from `git config --get-regexp ^includeif\.` output.
    // a subsection like `gitdir:$(touch${IFS}/tmp/pwn)safe` bypasses the
    // split-on-space filter and, when interpolated into a shell command,
    // lets the shell evaluate the command substitution.
    const proof = join(repoDir, "pwn-proof.txt");
    expect(existsSync(proof)).toBe(false);

    const configPath = join(repoDir, ".git", "config");
    writeFileSync(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        // space-free payload: ${IFS} expands to whitespace only if evaluated by a shell.
        // the subsection name is preserved literally by git.
        `[includeIf "gitdir:$(touch\${IFS}${proof})safe"]`,
        `\tpath = /tmp/unused`,
        "",
      ].join("\n"),
    );

    removeIncludeIfEntries(repoDir);

    expect(existsSync(proof)).toBe(false);
  });

  it("handles keys containing whitespace in the subsection name", () => {
    // the old split-on-space approach truncated keys at the first space, so
    // subsections with internal whitespace survived cleanup. the -z path
    // reads keys whole.
    const configPath = join(repoDir, ".git", "config");
    writeFileSync(
      configPath,
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[includeIf "gitdir:/a b c"]',
        "\tpath = /tmp/unused",
        "",
      ].join("\n"),
    );

    removeIncludeIfEntries(repoDir);

    const remaining = execSync("git config --local --get-regexp ^includeif\\. || true", {
      cwd: repoDir,
      encoding: "utf-8",
      shell: "/bin/bash",
      env: cleanEnv,
    });
    expect(remaining.trim()).toBe("");
  });

  it("is a no-op when no includeIf entries exist", () => {
    expect(() => removeIncludeIfEntries(repoDir)).not.toThrow();
  });
});

describe("removeIncludeIfEntries — key handling (mocked git)", () => {
  afterEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
  });

  it("dedupes repeated keys and tolerates unset failures per key", () => {
    // the pass-through wrapper accumulates calls from the real-git suites
    // above — drop them so the call-count assertion sees only this test.
    vi.mocked(execFileSync).mockClear();
    // -z format: "<key>\n<value>" entries, null-separated. same key twice +
    // one valueless entry (no newline → whole entry is the key).
    vi.mocked(execSync).mockImplementation(
      (() =>
        "includeif.gitdir:/w/.gitconfig\n/tmp/a\0includeif.gitdir:/w/.gitconfig\n/tmp/b\0includeif.onbranch:main\0") as unknown as typeof execSync,
    );
    let unsetCalls = 0;
    vi.mocked(execFileSync).mockImplementation((() => {
      unsetCalls += 1;
      // alternate Error / non-Error throws to cover both log-format paths
      if (unsetCalls === 1) throw new Error("unset rejected");
      throw "unset rejected as string";
    }) as unknown as typeof execFileSync);

    expect(() => removeIncludeIfEntries("/repo")).not.toThrow();

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "--unset-all", "includeif.gitdir:/w/.gitconfig"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "--unset-all", "includeif.onbranch:main"],
      expect.objectContaining({ cwd: "/repo", stdio: "pipe" }),
    );
  });

  it("skips the unset pass entirely when the -z output holds no keys", () => {
    vi.mocked(execFileSync).mockClear();
    vi.mocked(execSync).mockImplementation((() => "\0\0") as unknown as typeof execSync);
    vi.mocked(execFileSync).mockImplementation((() => "") as unknown as typeof execFileSync);

    expect(() => removeIncludeIfEntries("/repo")).not.toThrow();

    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("createTempDirectory", () => {
  it("creates a terramend temp dir and exports TERRAMEND_TEMP_DIR", () => {
    const saved = process.env.TERRAMEND_TEMP_DIR;
    const dir = createTempDirectory();
    try {
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain("terramend-");
      expect(process.env.TERRAMEND_TEMP_DIR).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved === undefined) delete process.env.TERRAMEND_TEMP_DIR;
      else process.env.TERRAMEND_TEMP_DIR = saved;
    }
  });
});

describe("wipeRunnerLeakSurface", () => {
  let runnerTemp: string;

  beforeEach(() => {
    runnerTemp = mkdtempSync(join(tmpdir(), "terramend-runner-"));
  });

  afterEach(() => {
    rmSync(runnerTemp, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("is a silent no-op when RUNNER_TEMP is unset", () => {
    vi.stubEnv("RUNNER_TEMP", undefined);
    expect(() => wipeRunnerLeakSurface()).not.toThrow();
  });

  it("wipes leak surfaces while preserving our own file-command paths", () => {
    const fileCommandsDir = join(runnerTemp, "_runner_file_commands");
    mkdirSync(fileCommandsDir);
    const leakedOutput = join(fileCommandsDir, "set_output_abc123");
    const ourOutput = join(fileCommandsDir, "github_output_1");
    const stepScript = join(runnerTemp, "step-uuid.sh");
    const credConfig = join(runnerTemp, "git-credentials-xyz.config");
    const unrelated = join(runnerTemp, "keep.txt");
    for (const file of [leakedOutput, ourOutput, stepScript, credConfig, unrelated]) {
      writeFileSync(file, "x");
    }

    vi.stubEnv("RUNNER_TEMP", runnerTemp);
    vi.stubEnv("GITHUB_OUTPUT", ourOutput);
    // not created yet — exercises the literal-path preserve fallback
    vi.stubEnv("GITHUB_ENV", join(fileCommandsDir, "github_env_not_created_yet"));
    vi.stubEnv("GITHUB_PATH", undefined);
    vi.stubEnv("GITHUB_STATE", undefined);
    vi.stubEnv("GITHUB_STEP_SUMMARY", undefined);

    wipeRunnerLeakSurface();

    expect(existsSync(leakedOutput)).toBe(false);
    expect(existsSync(stepScript)).toBe(false);
    expect(existsSync(credConfig)).toBe(false);
    expect(existsSync(ourOutput)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("tolerates a missing _runner_file_commands dir", () => {
    vi.stubEnv("RUNNER_TEMP", runnerTemp);
    vi.stubEnv("GITHUB_OUTPUT", undefined);
    vi.stubEnv("GITHUB_ENV", undefined);
    vi.stubEnv("GITHUB_PATH", undefined);
    vi.stubEnv("GITHUB_STATE", undefined);
    vi.stubEnv("GITHUB_STEP_SUMMARY", undefined);
    expect(() => wipeRunnerLeakSurface()).not.toThrow();
  });
});

describe("setupTestRepo", () => {
  afterEach(() => {
    vi.mocked($).mockReset();
    vi.unstubAllEnvs();
  });

  it("throws when GITHUB_REPOSITORY is unset", () => {
    vi.stubEnv("GITHUB_REPOSITORY", undefined);
    expect(() => setupTestRepo({ tempDir: "/tmp/x" })).toThrow("GITHUB_REPOSITORY is required");
  });

  it("clones over https with the token in CI", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/repo");
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_TOKEN", "ghs_token");
    vi.stubEnv("GH_TOKEN", undefined);

    setupTestRepo({ tempDir: "/tmp/clone" });

    expect($).toHaveBeenCalledWith("git", [
      "clone",
      "https://x-access-token:ghs_token@github.com/acme/repo.git",
      "/tmp/clone",
    ]);
  });

  it("falls back to GH_TOKEN when GITHUB_TOKEN is unset", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/repo");
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_TOKEN", "gh_alt");

    setupTestRepo({ tempDir: "/tmp/clone" });

    expect($).toHaveBeenCalledWith("git", [
      "clone",
      "https://x-access-token:gh_alt@github.com/acme/repo.git",
      "/tmp/clone",
    ]);
  });

  it("throws in CI when no token is available", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/repo");
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_TOKEN", undefined);
    vi.stubEnv("GH_TOKEN", undefined);

    expect(() => setupTestRepo({ tempDir: "/tmp/clone" })).toThrow(
      "GITHUB_TOKEN or GH_TOKEN is required",
    );
  });

  it("clones over ssh outside CI / Docker", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/repo");
    vi.stubEnv("CI", undefined);

    setupTestRepo({ tempDir: "/tmp/clone" });

    expect($).toHaveBeenCalledWith("git", ["clone", "git@github.com:acme/repo.git", "/tmp/clone"]);
  });
});

describe("captureInitialHead (mocked git)", () => {
  afterEach(() => {
    vi.mocked($).mockReset();
  });

  it("returns a branch head when symbolic-ref resolves", () => {
    vi.mocked($).mockImplementation((_cmd, args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });
    expect(captureInitialHead("/repo")).toEqual({ kind: "branch", name: "main" });
  });

  it("returns a detached head when symbolic-ref throws", () => {
    vi.mocked($).mockImplementation((_cmd, args) => {
      if (args[0] === "symbolic-ref") throw new Error("fatal: ref HEAD is not a symbolic ref");
      if (args[0] === "rev-parse") return "abc1234\n";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });
    expect(captureInitialHead("/repo")).toEqual({ kind: "detached", sha: "abc1234" });
  });

  it("falls through to the sha when symbolic-ref returns an empty name", () => {
    vi.mocked($).mockImplementation((_cmd, args) => {
      if (args[0] === "symbolic-ref") return "  ";
      if (args[0] === "rev-parse") return "def5678";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });
    expect(captureInitialHead("/repo")).toEqual({ kind: "detached", sha: "def5678" });
  });
});

describe("setupGit (mocked git)", () => {
  function makeParams(overrides: Partial<SetupGitParams> = {}): SetupGitParams {
    return {
      gitToken: "tok",
      owner: "acme",
      name: "repo",
      octokit: {} as unknown as OctokitWithPlugins,
      toolState: {
        prepushFailureCount: 0,
        backgroundProcesses: new Map(),
        progressComment: undefined,
        hadProgressComment: false,
        usageEntries: [],
      },
      shell: "restricted",
      postCheckoutScript: null,
      ...overrides,
    };
  }

  /** dispatch execSync by command; returns the recorded command list. */
  function mockGitExec(opts: { currentEmail?: string; failOnSet?: boolean } = {}): string[] {
    const commands: string[] = [];
    vi.mocked(execSync).mockImplementation(((command: string) => {
      commands.push(command);
      if (command === "git config user.email") {
        if (opts.currentEmail === undefined) throw new Error("not configured");
        return opts.currentEmail;
      }
      if (opts.failOnSet && command.startsWith("git config --local user.email")) {
        throw new Error("config file locked");
      }
      if (command.includes("--unset-all http")) throw new Error("no extraheader");
      if (command.includes("--get-regexp")) throw new Error("no includeif entries");
      return "";
    }) as unknown as typeof execSync);
    return commands;
  }

  function mockGitShell(): void {
    vi.mocked($).mockImplementation((_cmd, args) => {
      if (args[0] === "symbolic-ref") return "main\n";
      if (args[0] === "rev-parse") return "abc1234\n";
      return "";
    });
  }

  afterEach(() => {
    vi.mocked(execSync).mockReset();
    vi.mocked(execFileSync).mockReset();
    vi.mocked($).mockReset();
  });

  it("sets the terramend identity when no user.email is configured", async () => {
    const commands = mockGitExec();
    mockGitShell();
    const params = makeParams();

    await setupGit(params);

    expect(
      commands.some((c) => c.includes('user.email "terramend[bot]@users.noreply.github.com"')),
    ).toBe(true);
    expect(commands.some((c) => c.includes('user.name "terramend[bot]"'))).toBe(true);
    expect(commands.some((c) => c.includes("core.hooksPath"))).toBe(false);
    expect($).toHaveBeenCalledWith(
      "git",
      ["remote", "set-url", "origin", "https://github.com/acme/repo.git"],
      { cwd: process.cwd() },
    );
    expect($).toHaveBeenCalledWith("git", ["config", "--local", "credential.helper", ""], {
      cwd: process.cwd(),
    });
    expect(params.toolState.pushUrl).toBe("https://github.com/acme/repo.git");
    expect(params.toolState.initialHead).toEqual({ kind: "branch", name: "main" });
  });

  it("replaces the generic github-actions bot identity", async () => {
    const commands = mockGitExec({
      currentEmail: "github-actions[bot]@users.noreply.github.com\n",
    });
    mockGitShell();

    await setupGit(makeParams());

    expect(commands.some((c) => c.includes('user.email "terramend[bot]'))).toBe(true);
  });

  it("keeps a custom git identity untouched", async () => {
    const commands = mockGitExec({ currentEmail: "dev@example.com\n" });
    mockGitShell();

    await setupGit(makeParams());

    expect(commands.some((c) => c.includes('user.email "terramend[bot]'))).toBe(false);
  });

  it("disables git hooks when shell is disabled", async () => {
    const commands = mockGitExec({ currentEmail: "dev@example.com\n" });
    mockGitShell();

    await setupGit(makeParams({ shell: "disabled" }));

    expect(commands.some((c) => c.includes("core.hooksPath /dev/null"))).toBe(true);
  });

  it("continues past a failing git-config step and still configures auth", async () => {
    mockGitExec({ failOnSet: true });
    mockGitShell();
    const params = makeParams();

    await expect(setupGit(params)).resolves.toBeUndefined();

    expect(params.toolState.pushUrl).toBe("https://github.com/acme/repo.git");
  });

  it("tolerates a non-Error throw from the git-config step", async () => {
    vi.mocked(execSync).mockImplementation((() => {
      // non-Error throw — exercises the String(error) logging fallback
      throw "config locked";
    }) as unknown as typeof execSync);
    mockGitShell();
    const params = makeParams();

    await expect(setupGit(params)).resolves.toBeUndefined();

    expect(params.toolState.pushUrl).toBe("https://github.com/acme/repo.git");
  });

  it("records a detached initial head on detached-entry runs", async () => {
    mockGitExec({ currentEmail: "dev@example.com\n" });
    vi.mocked($).mockImplementation((_cmd, args) => {
      if (args[0] === "symbolic-ref") throw new Error("not a symbolic ref");
      if (args[0] === "rev-parse") return "face0ff\n";
      return "";
    });
    const params = makeParams();

    await setupGit(params);

    expect(params.toolState.initialHead).toEqual({ kind: "detached", sha: "face0ff" });
  });
});
