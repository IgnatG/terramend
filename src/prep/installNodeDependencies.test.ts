import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installNodeDependencies } from "#app/prep/installNodeDependencies";
import type { PrepOptions } from "#app/prep/types";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("package-manager-detector", () => ({
  detect: vi.fn(async () => null),
}));

vi.mock("package-manager-detector/commands", () => ({
  resolveCommand: vi.fn(),
}));

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
  },
}));

vi.mock("#app/utils/packageManager", () => ({
  ensurePackageManager: vi.fn(async () => false),
  resolvePackageManagerSpec: vi.fn(async () => null),
}));

vi.mock("#app/utils/subprocess", () => ({
  spawn: vi.fn(),
}));

import { existsSync } from "node:fs";
import { detect } from "package-manager-detector";
import { resolveCommand } from "package-manager-detector/commands";
import { ensurePackageManager, resolvePackageManagerSpec } from "#app/utils/packageManager";
import { spawn } from "#app/utils/subprocess";

const existsSyncMock = vi.mocked(existsSync);
const detectMock = vi.mocked(detect);
const resolveCommandMock = vi.mocked(resolveCommand);
const ensurePackageManagerMock = vi.mocked(ensurePackageManager);
const resolveSpecMock = vi.mocked(resolvePackageManagerSpec);
const spawnMock = vi.mocked(spawn);

const options: PrepOptions = { ignoreScripts: false, binDir: "/tmp/run/pm-bin" };

type SpawnArg = Parameters<typeof spawn>[0];

function spawnResult(init: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return {
    exitCode: init.exitCode ?? 0,
    stdout: init.stdout ?? "",
    stderr: init.stderr ?? "",
    durationMs: 1,
  };
}

/** route spawn calls by command so test setup reads as a behavior table */
function routeSpawn(handlers: Record<string, (call: SpawnArg) => ReturnType<typeof spawnResult>>) {
  spawnMock.mockImplementation(async (call) => {
    const handler = handlers[call.cmd];
    if (!handler) throw new Error(`unexpected spawn: ${call.cmd} ${call.args.join(" ")}`);
    return handler(call);
  });
}

function whichAvailable(available: boolean) {
  return () => spawnResult({ exitCode: available ? 0 : 1 });
}

function declaredSpec(overrides: Partial<{ name: string; version: string }> = {}) {
  return {
    name: "pnpm",
    version: "11.1.1",
    concrete: true,
    source: "packageManager",
    ...overrides,
  } as NonNullable<Awaited<ReturnType<typeof resolvePackageManagerSpec>>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  detectMock.mockResolvedValue(null);
  resolveSpecMock.mockResolvedValue(null);
  ensurePackageManagerMock.mockResolvedValue(false);
});

describe("installNodeDependencies.shouldRun", () => {
  it("runs only when package.json exists in cwd", () => {
    existsSyncMock.mockReturnValueOnce(true);
    expect(installNodeDependencies.shouldRun()).toBe(true);
    existsSyncMock.mockReturnValueOnce(false);
    expect(installNodeDependencies.shouldRun()).toBe(false);
  });
});

describe("installNodeDependencies.run", () => {
  it("skips install when no lockfile is detected (default npm path)", async () => {
    routeSpawn({ which: whichAvailable(true) });

    const result = await installNodeDependencies.run(options);

    expect(result).toEqual({
      language: "node",
      packageManager: "npm",
      dependenciesInstalled: false,
      issues: [],
    });
    // only the availability probe ran — no installer
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("fails fast when the manager is missing and shell is disabled", async () => {
    detectMock.mockResolvedValue({ name: "pnpm", agent: "pnpm" });
    routeSpawn({ which: whichAvailable(false) });

    const result = await installNodeDependencies.run({ ...options, ignoreScripts: true });

    expect(result.dependenciesInstalled).toBe(false);
    expect(result.issues[0]).toContain("cannot be installed when shell is disabled");
  });

  it("provisions a declared manager via corepack and runs the frozen install", async () => {
    resolveSpecMock.mockResolvedValue(declaredSpec());
    detectMock.mockResolvedValue({ name: "pnpm", agent: "pnpm" });
    ensurePackageManagerMock.mockResolvedValue(true);
    resolveCommandMock.mockReturnValue({ command: "pnpm", args: ["install", "--frozen-lockfile"] });
    routeSpawn({
      which: whichAvailable(false),
      pnpm: () => spawnResult({ stdout: "done" }),
    });

    const result = await installNodeDependencies.run(options);

    expect(ensurePackageManagerMock).toHaveBeenCalledWith({
      spec: declaredSpec(),
      binDir: options.binDir,
    });
    expect(result).toEqual({
      language: "node",
      packageManager: "pnpm",
      dependenciesInstalled: true,
      issues: [],
    });
  });

  it("re-pins an already-available declared manager before installing", async () => {
    resolveSpecMock.mockResolvedValue(declaredSpec());
    detectMock.mockResolvedValue({ name: "pnpm", agent: "pnpm" });
    resolveCommandMock.mockReturnValue({ command: "pnpm", args: ["install", "--frozen-lockfile"] });
    routeSpawn({
      which: whichAvailable(true),
      pnpm: () => spawnResult(),
    });

    const result = await installNodeDependencies.run(options);

    expect(ensurePackageManagerMock).toHaveBeenCalledTimes(1);
    expect(result.dependenciesInstalled).toBe(true);
  });

  it("falls back to npm install -g when corepack cannot provision", async () => {
    resolveSpecMock.mockResolvedValue(declaredSpec({ name: "bun", version: "1.3.0" }));
    detectMock.mockResolvedValue({ name: "bun", agent: "bun" });
    ensurePackageManagerMock.mockResolvedValue(false);
    resolveCommandMock.mockReturnValue({ command: "bun", args: ["install", "--frozen-lockfile"] });
    const npmCalls: SpawnArg[] = [];
    routeSpawn({
      which: whichAvailable(false),
      npm: (call) => {
        npmCalls.push(call);
        return spawnResult();
      },
      bun: () => spawnResult(),
    });

    const result = await installNodeDependencies.run(options);

    expect(npmCalls[0]?.args).toEqual(["install", "-g", "bun@1.3.0"]);
    expect(result.dependenciesInstalled).toBe(true);
  });

  it("surfaces fallback installer failures as issues", async () => {
    detectMock.mockResolvedValue({ name: "yarn", agent: "yarn" });
    routeSpawn({
      which: whichAvailable(false),
      npm: (call) => {
        // exercise the stderr-forwarding callback
        call.onStderr?.("");
        return spawnResult({ exitCode: 1, stderr: "registry down" });
      },
    });

    const result = await installNodeDependencies.run(options);

    expect(result).toEqual({
      language: "node",
      packageManager: "yarn",
      dependenciesInstalled: false,
      issues: ["registry down"],
    });
  });

  it("installs deno via curl and prepends its bin dir to PATH", async () => {
    const originalPath = process.env.PATH;
    const originalHome = process.env.HOME;
    vi.stubEnv("HOME", "/home/runner");
    vi.stubEnv("PATH", "/usr/bin");
    try {
      detectMock.mockResolvedValue({ name: "deno", agent: "deno" });
      resolveCommandMock.mockReturnValue({ command: "deno", args: ["install", "--frozen"] });
      const shCalls: SpawnArg[] = [];
      routeSpawn({
        which: whichAvailable(false),
        sh: (call) => {
          shCalls.push(call);
          return spawnResult();
        },
        deno: () => spawnResult(),
      });

      const result = await installNodeDependencies.run(options);

      expect(shCalls[0]?.args).toEqual(["-c", "curl -fsSL https://deno.land/install.sh | sh"]);
      const denoBin = join("/home/runner", ".deno", "bin");
      expect(process.env.PATH?.startsWith(`${denoBin}:`)).toBe(true);
      expect(result.dependenciesInstalled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
    }
  });

  it("reports an issue when no frozen-install command exists for the agent", async () => {
    detectMock.mockResolvedValue({ name: "npm", agent: "npm" });
    resolveCommandMock.mockReturnValue(null);
    routeSpawn({ which: whichAvailable(true) });

    const result = await installNodeDependencies.run(options);

    expect(result.issues).toEqual(["no frozen-install command available for npm"]);
  });

  it("appends --ignore-scripts when shell is disabled", async () => {
    detectMock.mockResolvedValue({ name: "npm", agent: "npm" });
    resolveCommandMock.mockReturnValue({ command: "npm", args: ["ci"] });
    const npmCalls: SpawnArg[] = [];
    routeSpawn({
      which: whichAvailable(true),
      npm: (call) => {
        npmCalls.push(call);
        return spawnResult();
      },
    });

    const result = await installNodeDependencies.run({ ...options, ignoreScripts: true });

    expect(npmCalls[0]?.args).toEqual(["ci", "--ignore-scripts"]);
    expect(result.dependenciesInstalled).toBe(true);
  });

  it("returns the command output as an issue when the install fails", async () => {
    detectMock.mockResolvedValue({ name: "npm", agent: "npm" });
    resolveCommandMock.mockReturnValue({ command: "npm", args: ["ci"] });
    routeSpawn({
      which: whichAvailable(true),
      npm: () => spawnResult({ exitCode: 1, stdout: "npm ERR!", stderr: "lockfile out of sync" }),
    });

    const result = await installNodeDependencies.run(options);

    expect(result.dependenciesInstalled).toBe(false);
    expect(result.issues[0]).toContain("`npm ci` failed:");
    expect(result.issues[0]).toContain("npm ERR!");
    expect(result.issues[0]).toContain("lockfile out of sync");
  });

  it("reports the exit code when a failing install produces no output", async () => {
    detectMock.mockResolvedValue({ name: "npm", agent: "npm" });
    resolveCommandMock.mockReturnValue({ command: "npm", args: ["ci"] });
    routeSpawn({
      which: whichAvailable(true),
      npm: () => spawnResult({ exitCode: 7 }),
    });

    const result = await installNodeDependencies.run(options);

    expect(result.issues[0]).toContain("exited with code 7");
  });
});
