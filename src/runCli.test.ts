import { execFileSync } from "node:child_process";
import { accessSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTerramendCli } from "#app/runCli";
import actionPackageJson from "#package.json" with { type: "json" };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: vi.fn(),
    existsSync: vi.fn(() => true),
    mkdtempSync: vi.fn(() => "/tmp/terramend-bootstrap-xyz"),
  };
});

const nodeBinDir = dirname(process.execPath);

/** make accessSync succeed only for paths matching the given predicate. */
function allowExecutables(predicate: (path: string) => boolean): void {
  vi.mocked(accessSync).mockImplementation((path) => {
    if (!predicate(String(path))) {
      throw new Error("EACCES");
    }
  });
}

function execCall(index = 0): {
  command: string;
  args: string[];
  options: Record<string, unknown>;
} {
  const call = vi.mocked(execFileSync).mock.calls[index];
  if (!call) throw new Error(`execFileSync call ${index} missing`);
  return {
    command: String(call[0]),
    args: (call[1] ?? []) as string[],
    options: (call[2] ?? {}) as Record<string, unknown>,
  };
}

beforeEach(() => {
  allowExecutables(() => true);
  // pin the Windows executable-extension list so candidate paths are deterministic
  vi.stubEnv("PATHEXT", ".CMD");
  vi.stubEnv("GITHUB_WORKSPACE", "");
  vi.stubEnv("GITHUB_ACTION_REF", "");
  vi.stubEnv("GITHUB_ACTION_REPOSITORY", "");
  vi.stubEnv("TERRAMEND_FORCE_LOCAL_CLI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runTerramendCli – npx bootstrap path", () => {
  it("runs the exact-pinned npm package via npx in a fresh tmpdir", () => {
    runTerramendCli({ cliArgs: ["gha", "token"] });

    const { command, args, options } = execCall();
    expect(command).toContain("npx");
    expect(args).toEqual(["--yes", `terramend@${actionPackageJson.version}`, "gha", "token"]);
    expect(options.cwd).toBe("/tmp/terramend-bootstrap-xyz");
    expect(mkdtempSync).toHaveBeenCalledWith(expect.stringContaining("terramend-bootstrap-"));

    const env = options.env as NodeJS.ProcessEnv;
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org");
    expect(env.COREPACK_NPM_REGISTRY).toBe("https://registry.npmjs.org");
    expect(env.npm_config_min_release_age).toBe("0");
    expect(env.pnpm_config_minimum_release_age).toBe("0");
    expect(env.PATH).toContain(nodeBinDir);
  });

  it("falls back to corepack pnpm dlx when npx is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    allowExecutables((path) => path.includes("corepack"));

    runTerramendCli({ cliArgs: ["gha"] });

    expect(warnSpy).toHaveBeenCalledWith("» npx not found, using corepack pnpm dlx");
    const { command, args } = execCall();
    expect(command).toContain("corepack");
    expect(args).toEqual(["pnpm", "dlx", `terramend@${actionPackageJson.version}`, "gha"]);
  });

  it("throws when neither npx nor corepack can be found", () => {
    allowExecutables(() => false);

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow(
      /could not find npx or corepack on PATH/,
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("ignores PATH entries inside the customer workspace and relative entries", () => {
    const workspace = join(nodeBinDir, "workspace-checkout");
    vi.stubEnv("GITHUB_WORKSPACE", workspace);
    vi.stubEnv("PATH", `${join(workspace, "bin")}${process.platform === "win32" ? ";" : ":"}bin`);
    // every candidate is "accessible" — only the untrusted-path filter can reject
    allowExecutables((path) => path.startsWith(workspace) || !path.includes(nodeBinDir));

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow(
      /could not find npx or corepack on PATH/,
    );
  });
});

describe("runTerramendCli – local CLI path", () => {
  it("runs the checked-out cli.ts when TERRAMEND_FORCE_LOCAL_CLI=1", () => {
    vi.stubEnv("TERRAMEND_FORCE_LOCAL_CLI", "1");

    runTerramendCli({ cliArgs: ["gha"] });

    const { command, args, options } = execCall();
    expect(command).toBe(process.execPath);
    expect(args).toEqual(["cli.ts", "gha"]);
    expect(String(options.cwd)).toContain("src");
  });

  it("runs locally when the action ref is main on terramend/terramend", () => {
    vi.stubEnv("GITHUB_ACTION_REF", "main");
    vi.stubEnv("GITHUB_ACTION_REPOSITORY", "terramend/terramend");

    runTerramendCli({ cliArgs: ["gha"] });

    expect(execCall().command).toBe(process.execPath);
  });

  it("installs action dependencies via corepack pnpm when node_modules is missing", () => {
    vi.stubEnv("TERRAMEND_FORCE_LOCAL_CLI", "1");
    vi.mocked(existsSync).mockReturnValue(false);

    runTerramendCli({ cliArgs: ["gha"] });

    expect(execFileSync).toHaveBeenCalledTimes(2);
    const install = execCall(0);
    expect(install.command).toContain("corepack");
    expect(install.args).toEqual(["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"]);
    expect(execCall(1).args).toEqual(["cli.ts", "gha"]);
  });

  it("throws a descriptive error when corepack is required but missing", () => {
    vi.stubEnv("TERRAMEND_FORCE_LOCAL_CLI", "1");
    vi.mocked(existsSync).mockReturnValue(false);
    allowExecutables(() => false);

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow(
      /could not find corepack on PATH \(needed to install action dependencies via pnpm\)/,
    );
  });
});

function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
}

describe("runTerramendCli – child exit propagation", () => {
  let exitSpy: ReturnType<typeof mockProcessExit>;

  beforeEach(() => {
    exitSpy = mockProcessExit();
  });

  it("propagates a numeric child exit status silently", () => {
    const childError = Object.assign(new Error("Command failed"), { status: 3 });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw childError;
    });

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow("process.exit:3");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits 1 when the child was killed by a signal", () => {
    const childError = Object.assign(new Error("Command failed"), {
      status: null,
      signal: "SIGTERM",
    });
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw childError;
    });

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow("process.exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rethrows genuine spawn failures", () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });

    expect(() => runTerramendCli({ cliArgs: ["gha"] })).toThrow("spawn ENOENT");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("swallows errors and warns when swallowErrors is set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("cleanup blew up");
    });

    expect(() => runTerramendCli({ cliArgs: ["gha"], swallowErrors: true })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith("» terramend cleanup bootstrap failed: cleanup blew up");
  });
});
