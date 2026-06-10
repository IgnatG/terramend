import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installPythonDependencies } from "#app/prep/installPythonDependencies";
import type { PrepOptions } from "#app/prep/types";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
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

vi.mock("#app/utils/subprocess", () => ({
  spawn: vi.fn(),
}));

import { existsSync } from "node:fs";
import type { PythonPrepResult } from "#app/prep/types";
import { spawn } from "#app/utils/subprocess";

const existsSyncMock = vi.mocked(existsSync);
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

/** make only the given files exist in cwd */
function filesPresent(...names: string[]) {
  const paths = new Set(names.map((name) => join(process.cwd(), name)));
  existsSyncMock.mockImplementation((path) => paths.has(String(path)));
}

/** answer `which <name>` probes by availability; everything else by handler */
function routeSpawn(params: {
  available?: string[];
  handlers?: Record<string, (call: SpawnArg) => ReturnType<typeof spawnResult>>;
}) {
  const available = new Set(params.available ?? []);
  spawnMock.mockImplementation(async (call) => {
    if (call.cmd === "which") {
      return spawnResult({ exitCode: available.has(call.args[0] ?? "") ? 0 : 1 });
    }
    const handler = params.handlers?.[call.cmd];
    if (!handler) throw new Error(`unexpected spawn: ${call.cmd} ${call.args.join(" ")}`);
    return handler(call);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** run() is typed as the PrepResult union; narrow to the python shape */
async function runPython(opts: PrepOptions): Promise<PythonPrepResult> {
  const result = await installPythonDependencies.run(opts);
  if (result.language !== "python") {
    throw new Error(`expected a python prep result, got ${result.language}`);
  }
  return result;
}

describe("installPythonDependencies.shouldRun", () => {
  it("is false when no python interpreter is available", async () => {
    routeSpawn({ available: [] });
    await expect(installPythonDependencies.shouldRun()).resolves.toBe(false);
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it("is false with python but no config file", async () => {
    routeSpawn({ available: ["python3"] });
    filesPresent();
    await expect(installPythonDependencies.shouldRun()).resolves.toBe(false);
  });

  it("is true with a fallback `python` binary and a requirements.txt", async () => {
    routeSpawn({ available: ["python"] });
    filesPresent("requirements.txt");
    await expect(installPythonDependencies.shouldRun()).resolves.toBe(true);
  });
});

describe("installPythonDependencies.run", () => {
  it("reports an issue when no config file is found", async () => {
    filesPresent();
    const result = await runPython(options);
    expect(result).toEqual({
      language: "python",
      packageManager: "pip",
      configFile: "unknown",
      dependenciesInstalled: false,
      issues: ["no python config file found"],
    });
  });

  it("skips installation entirely when shell is disabled", async () => {
    filesPresent("requirements.txt");
    const result = await runPython({ ...options, ignoreScripts: true });
    expect(result.dependenciesInstalled).toBe(false);
    expect(result.configFile).toBe("requirements.txt");
    expect(result.issues[0]).toContain("can execute arbitrary code");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("installs requirements.txt via pip when pip is available", async () => {
    filesPresent("requirements.txt");
    const pipCalls: SpawnArg[] = [];
    routeSpawn({
      available: ["pip"],
      handlers: {
        pip: (call) => {
          pipCalls.push(call);
          return spawnResult({ stdout: "installed" });
        },
      },
    });

    const result = await runPython(options);

    expect(pipCalls[0]?.args).toEqual(["install", "-r", "requirements.txt"]);
    expect(result).toEqual({
      language: "python",
      packageManager: "pip",
      configFile: "requirements.txt",
      dependenciesInstalled: true,
      issues: [],
    });
  });

  it("prefers requirements.txt over later configs in priority order", async () => {
    filesPresent("requirements.txt", "pyproject.toml", "Pipfile");
    routeSpawn({ available: ["pip"], handlers: { pip: () => spawnResult() } });
    const result = await runPython(options);
    expect(result.configFile).toBe("requirements.txt");
  });

  it("installs a missing tool (pipenv) before running its install command", async () => {
    filesPresent("Pipfile");
    const pipCalls: SpawnArg[] = [];
    const pipenvCalls: SpawnArg[] = [];
    routeSpawn({
      available: [],
      handlers: {
        pip: (call) => {
          pipCalls.push(call);
          return spawnResult();
        },
        pipenv: (call) => {
          pipenvCalls.push(call);
          return spawnResult();
        },
      },
    });

    const result = await runPython(options);

    expect(pipCalls[0]?.args).toEqual(["install", "pipenv"]);
    expect(pipenvCalls[0]?.args).toEqual(["install"]);
    expect(result.packageManager).toBe("pipenv");
    expect(result.dependenciesInstalled).toBe(true);
  });

  it("does not attempt to install pip itself when missing", async () => {
    filesPresent("setup.py");
    const pipCalls: SpawnArg[] = [];
    routeSpawn({
      available: [],
      handlers: {
        pip: (call) => {
          pipCalls.push(call);
          return spawnResult();
        },
      },
    });

    const result = await runPython(options);

    // only the editable install ran — no `pip install pip` bootstrap
    expect(pipCalls).toHaveLength(1);
    expect(pipCalls[0]?.args).toEqual(["install", "-e", "."]);
    expect(result.dependenciesInstalled).toBe(true);
  });

  it("surfaces tool installation failures as issues", async () => {
    filesPresent("poetry.lock");
    routeSpawn({
      available: [],
      handlers: {
        pip: (call) => {
          // exercise the stderr-forwarding callback
          call.onStderr?.("");
          return spawnResult({ exitCode: 1, stderr: "no network" });
        },
      },
    });

    const result = await runPython(options);

    expect(result).toEqual({
      language: "python",
      packageManager: "poetry",
      configFile: "poetry.lock",
      dependenciesInstalled: false,
      issues: ["no network"],
    });
  });

  it("falls back to a generic message when tool install fails silently", async () => {
    filesPresent("Pipfile.lock");
    routeSpawn({
      available: [],
      handlers: {
        pip: () => spawnResult({ exitCode: 1 }),
      },
    });

    const result = await runPython(options);

    expect(result.issues).toEqual(["failed to install pipenv"]);
  });

  it("reports install command failures with combined output", async () => {
    filesPresent("pyproject.toml");
    routeSpawn({
      available: ["pip"],
      handlers: {
        pip: () => spawnResult({ exitCode: 2, stdout: "resolving...", stderr: "conflict" }),
      },
    });

    const result = await runPython(options);

    expect(result.dependenciesInstalled).toBe(false);
    expect(result.issues).toEqual(["resolving...\nconflict"]);
  });

  it("reports the exit code when a failing install produces no output", async () => {
    filesPresent("pyproject.toml");
    routeSpawn({
      available: ["pip"],
      handlers: {
        pip: () => spawnResult({ exitCode: 3 }),
      },
    });

    const result = await runPython(options);

    expect(result.issues).toEqual(["pip exited with code 3"]);
  });
});
