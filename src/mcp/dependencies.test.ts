import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwaitDependencyInstallationTool,
  StartDependencyInstallationTool,
  startInstallation,
} from "#app/mcp/dependencies";
import type { ToolContext } from "#app/mcp/server";
import { type PrepResult, runPrepPhase } from "#app/prep/index";
import type { ToolState } from "#app/toolState";

vi.mock("#app/prep/index", () => ({
  runPrepPhase: vi.fn(async (): Promise<PrepResult[]> => []),
}));

const runPrepPhaseMock = vi.mocked(runPrepPhase);

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

function makeCtx(overrides?: {
  shell?: "disabled" | "restricted" | "enabled";
  toolState?: Partial<ToolState>;
}): { ctx: ToolContext; toolState: ToolState } {
  const toolState = { ...overrides?.toolState } as ToolState;
  const ctx = {
    payload: { shell: overrides?.shell ?? "restricted" },
    toolState,
    tmpdir: join("/tmp", "terramend"),
  } as unknown as ToolContext;
  return { ctx, toolState };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: Error) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const nodeOk: PrepResult = {
  language: "node",
  packageManager: "pnpm",
  dependenciesInstalled: true,
  issues: [],
};
const pythonOk: PrepResult = {
  language: "python",
  packageManager: "pip",
  configFile: "requirements.txt",
  dependenciesInstalled: true,
  issues: [],
};
const nodeFailed: PrepResult = {
  language: "node",
  packageManager: "npm",
  dependenciesInstalled: false,
  issues: ["ERESOLVE unable to resolve dependency tree"],
};
const pythonFailedNoIssues: PrepResult = {
  language: "python",
  packageManager: "poetry",
  configFile: "pyproject.toml",
  dependenciesInstalled: false,
  issues: [],
};
const unknownLang: PrepResult = { language: "unknown", dependenciesInstalled: false, issues: [] };

beforeEach(() => {
  vi.clearAllMocks();
  runPrepPhaseMock.mockImplementation(async () => []);
});

describe("startInstallation", () => {
  it("suppresses lifecycle scripts when shell is disabled", () => {
    const { ctx } = makeCtx({ shell: "disabled" });
    startInstallation(ctx);
    expect(runPrepPhaseMock).toHaveBeenCalledWith({
      ignoreScripts: true,
      binDir: join(join("/tmp", "terramend"), "pm-bin"),
    });
  });

  it("allows lifecycle scripts when shell is not disabled", () => {
    const { ctx } = makeCtx({ shell: "restricted" });
    startInstallation(ctx);
    expect(runPrepPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreScripts: false }),
    );
  });

  it("is idempotent — a second call does not restart the prep phase", () => {
    const { ctx } = makeCtx();
    startInstallation(ctx);
    startInstallation(ctx);
    expect(runPrepPhaseMock).toHaveBeenCalledTimes(1);
  });

  it("transitions to completed when every result installed", async () => {
    const d = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(d.promise);
    const { ctx, toolState } = makeCtx();
    startInstallation(ctx);
    expect(toolState.dependencyInstallation?.status).toBe("in_progress");

    d.resolve([nodeOk]);
    await d.promise;
    expect(toolState.dependencyInstallation?.status).toBe("completed");
    expect(toolState.dependencyInstallation?.results).toEqual([nodeOk]);
  });

  it("transitions to failed when a result has install issues", async () => {
    const d = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(d.promise);
    const { ctx, toolState } = makeCtx();
    startInstallation(ctx);

    d.resolve([nodeFailed]);
    await d.promise;
    expect(toolState.dependencyInstallation?.status).toBe("failed");
  });

  it("stays completed when a failure carries no issues (not treated as failed)", async () => {
    const d = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(d.promise);
    const { ctx, toolState } = makeCtx();
    startInstallation(ctx);

    d.resolve([pythonFailedNoIssues]);
    await d.promise;
    expect(toolState.dependencyInstallation?.status).toBe("completed");
  });

  it("transitions to failed when the prep phase rejects", async () => {
    const d = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(d.promise);
    const { ctx, toolState } = makeCtx();
    startInstallation(ctx);

    d.reject(new Error("prep blew up"));
    await d.promise.catch(() => undefined);
    // give the rejection handler a microtask to run
    await Promise.resolve();
    expect(toolState.dependencyInstallation?.status).toBe("failed");
  });

  it("ignores settlement when the installation state was cleared meanwhile", async () => {
    const clearInstallation = (state: ToolState): void => {
      delete state.dependencyInstallation;
    };
    const ok = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(ok.promise);
    const { ctx, toolState } = makeCtx();
    startInstallation(ctx);
    clearInstallation(toolState);
    ok.resolve([nodeOk]);
    await ok.promise;
    expect(toolState.dependencyInstallation).toBeUndefined();

    const bad = deferred<PrepResult[]>();
    runPrepPhaseMock.mockReturnValueOnce(bad.promise);
    startInstallation(ctx);
    clearInstallation(toolState);
    bad.reject(new Error("late failure"));
    await bad.promise.catch(() => undefined);
    await Promise.resolve();
    expect(toolState.dependencyInstallation).toBeUndefined();
  });
});

describe("StartDependencyInstallationTool", () => {
  it("starts the installation and reports started", async () => {
    const { ctx } = makeCtx();
    const result = await runTool(StartDependencyInstallationTool(ctx), {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("status: started");
    expect(runPrepPhaseMock).toHaveBeenCalledTimes(1);
  });

  it("reports in_progress without restarting", async () => {
    const { ctx } = makeCtx();
    startInstallation(ctx);
    const result = await runTool(StartDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("status: in_progress");
    expect(runPrepPhaseMock).toHaveBeenCalledTimes(1);
  });

  it("returns the cached summary once completed", async () => {
    const { ctx } = makeCtx({
      toolState: {
        dependencyInstallation: {
          status: "completed",
          promise: undefined,
          results: [nodeOk, pythonOk],
        },
      },
    });
    const result = await runTool(StartDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("status: completed");
    expect(result.content[0].text).toContain("Node.js dependencies installed successfully");
    expect(result.content[0].text).toContain("via pip (from requirements.txt)");
    expect(runPrepPhaseMock).not.toHaveBeenCalled();
  });

  it("summarizes a failed run with undefined results as no-language-detected", async () => {
    const { ctx } = makeCtx({
      toolState: {
        dependencyInstallation: { status: "failed", promise: undefined, results: undefined },
      },
    });
    const result = await runTool(StartDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("status: failed");
    expect(result.content[0].text).toContain("No supported language detected");
  });
});

describe("AwaitDependencyInstallationTool", () => {
  it("auto-starts the installation and awaits the results", async () => {
    runPrepPhaseMock.mockResolvedValueOnce([nodeOk]);
    const { ctx } = makeCtx();
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.isError).toBeUndefined();
    expect(runPrepPhaseMock).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("Node.js dependencies installed successfully");
  });

  it("returns cached results when the installation already completed", async () => {
    const { ctx } = makeCtx({
      toolState: {
        dependencyInstallation: { status: "completed", promise: undefined, results: [pythonOk] },
      },
    });
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("status: completed");
    expect(runPrepPhaseMock).not.toHaveBeenCalled();
  });

  it("returns the failure summary with errors and remediation guidance", async () => {
    const { ctx } = makeCtx({
      toolState: {
        dependencyInstallation: {
          status: "failed",
          promise: undefined,
          results: [nodeFailed, pythonFailedNoIssues],
        },
      },
    });
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("dependency installation failed via npm");
    expect(result.content[0].text).toContain("ERESOLVE");
    expect(result.content[0].text).toContain("via poetry (from pyproject.toml)");
    expect(result.content[0].text).toContain("unknown error");
  });

  it("skips unknown-language results and falls back to the no-language message", async () => {
    runPrepPhaseMock.mockResolvedValueOnce([unknownLang]);
    const { ctx } = makeCtx();
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.content[0].text).toContain("No supported language detected");
  });

  it("errors when the in-progress state lost its promise (corrupted)", async () => {
    const { ctx } = makeCtx({
      toolState: {
        dependencyInstallation: { status: "in_progress", promise: undefined, results: undefined },
      },
    });
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("corrupted");
  });

  it("errors when the installation state cannot be initialized", async () => {
    const toolState = {} as ToolState;
    Object.defineProperty(toolState, "dependencyInstallation", {
      get: () => undefined,
      set: () => undefined,
    });
    const ctx = {
      payload: { shell: "restricted" },
      toolState,
      tmpdir: join("/tmp", "terramend"),
    } as unknown as ToolContext;
    const result = await runTool(AwaitDependencyInstallationTool(ctx), {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("failed to initialize");
  });
});
