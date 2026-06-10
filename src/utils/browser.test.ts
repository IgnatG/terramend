import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolState } from "#app/toolState";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

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
  },
}));

vi.mock("#app/utils/secrets", () => ({
  filterEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
}));

vi.mock("#app/utils/version", () => ({
  getDevDependencyVersion: vi.fn(() => "1.2.3"),
}));

type SpawnSyncFn = typeof import("node:child_process").spawnSync;

function spawnSyncResult(
  init: { status?: number | null; stdout?: string; stderr?: string } = {},
): ReturnType<SpawnSyncFn> {
  return {
    status: init.status ?? 0,
    stdout: init.stdout ?? "",
    stderr: init.stderr ?? "",
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<SpawnSyncFn>;
}

function makeToolState(overrides: Partial<ToolState> = {}): ToolState {
  return { ...overrides } as ToolState;
}

// browser.ts caches the system chrome lookup in module state, so each test
// imports a fresh module instance. vi.resetModules() re-runs the mock
// factories too, so the mock handles must come from the fresh registry —
// top-level imports of the mocked modules would go stale.
async function loadBrowser() {
  vi.resetModules();
  const childProcess = await import("node:child_process");
  const fs = await import("node:fs");
  const browser = await import("#app/utils/browser");
  return {
    ...browser,
    spawnSyncMock: vi.mocked(childProcess.spawnSync),
    execFileSyncMock: vi.mocked(childProcess.execFileSync),
    existsSyncMock: vi.mocked(fs.existsSync),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureBrowserDaemon", () => {
  it("is idempotent: returns the stored error without re-running", async () => {
    const { ensureBrowserDaemon, spawnSyncMock } = await loadBrowser();
    const toolState = makeToolState({ browserDaemon: { error: "previous failure" } });

    expect(ensureBrowserDaemon(toolState)).toBe("previous failure");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns undefined when the daemon is already running", async () => {
    const { ensureBrowserDaemon, spawnSyncMock } = await loadBrowser();
    const toolState = makeToolState({ browserDaemon: { binDir: "/bin" } });

    expect(ensureBrowserDaemon(toolState)).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("stores and returns an error when the npm install fails", async () => {
    const { ensureBrowserDaemon, spawnSyncMock } = await loadBrowser();
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 1, stderr: "E404 not found" }));
    const toolState = makeToolState();

    const error = ensureBrowserDaemon(toolState);

    expect(error).toBe("agent-browser install failed: E404 not found");
    expect(toolState.browserDaemon).toEqual({ error });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "agent-browser@1.2.3"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });

  it("falls back to stdout, then a generic message, for install failures", async () => {
    const first = await loadBrowser();
    first.spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({ status: 1, stdout: "stdout detail" }),
    );
    expect(first.ensureBrowserDaemon(makeToolState())).toBe(
      "agent-browser install failed: stdout detail",
    );

    const second = await loadBrowser();
    second.spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 1 }));
    expect(second.ensureBrowserDaemon(makeToolState())).toBe(
      "agent-browser install failed: unknown error",
    );
  });

  it("errors when the binary is not on PATH after install", async () => {
    const { ensureBrowserDaemon, spawnSyncMock, execFileSyncMock } = await loadBrowser();
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 0 }));
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("which: not found");
    });
    const toolState = makeToolState();

    const error = ensureBrowserDaemon(toolState);

    expect(error).toBe("agent-browser binary not found in PATH after install");
    expect(toolState.browserDaemon).toEqual({ error });
  });

  it("errors when the seed command fails, including exit code and output", async () => {
    const { ensureBrowserDaemon, spawnSyncMock, execFileSyncMock } = await loadBrowser();
    spawnSyncMock
      .mockReturnValueOnce(spawnSyncResult({ status: 0 })) // npm install
      .mockReturnValueOnce(spawnSyncResult({ status: 2, stderr: "no display" })); // seed
    execFileSyncMock.mockReturnValueOnce("/usr/local/bin/agent-browser\n");
    const toolState = makeToolState();

    const error = ensureBrowserDaemon(toolState);

    expect(error).toBe("agent-browser open about:blank failed (exit=2): no display");
    expect(toolState.browserDaemon).toEqual({ error });
  });

  it("falls back to the seed command's stdout when stderr is empty", async () => {
    const { ensureBrowserDaemon, spawnSyncMock, execFileSyncMock } = await loadBrowser();
    spawnSyncMock
      .mockReturnValueOnce(spawnSyncResult({ status: 0 })) // npm install
      .mockReturnValueOnce(spawnSyncResult({ status: 3, stdout: "daemon died" })); // seed
    execFileSyncMock.mockReturnValueOnce("/usr/local/bin/agent-browser\n");

    const error = ensureBrowserDaemon(makeToolState());

    expect(error).toBe("agent-browser open about:blank failed (exit=3): daemon died");
  });

  it("marks the daemon ready with the binary dir on success (no system chrome)", async () => {
    const { ensureBrowserDaemon, spawnSyncMock, execFileSyncMock, existsSyncMock } =
      await loadBrowser();
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue(spawnSyncResult({ status: 0, stdout: "ok" }));
    execFileSyncMock.mockReturnValue("/usr/local/bin/agent-browser\n" as never);
    const toolState = makeToolState();

    const error = ensureBrowserDaemon(toolState);

    expect(error).toBeUndefined();
    expect(toolState.browserDaemon).toEqual({ binDir: "/usr/local/bin" });
    const seedCall = spawnSyncMock.mock.calls[1];
    expect(seedCall?.[0]).toBe("agent-browser");
    expect(seedCall?.[1]).toEqual(["open", "about:blank"]);
    const seedEnv = (seedCall?.[2] as { env?: Record<string, string> })?.env ?? {};
    expect(seedEnv.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined();

    // a second run hits the cached "no system chrome" result without re-probing
    existsSyncMock.mockClear();
    ensureBrowserDaemon(makeToolState());
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it("points agent-browser at the system chrome when present, caching the lookup", async () => {
    const { ensureBrowserDaemon, spawnSyncMock, execFileSyncMock, existsSyncMock } =
      await loadBrowser();
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue(spawnSyncResult({ status: 0 }));
    execFileSyncMock.mockReturnValue("/usr/local/bin/agent-browser\n" as never);

    ensureBrowserDaemon(makeToolState());
    const firstEnv = (spawnSyncMock.mock.calls[1]?.[2] as { env?: Record<string, string> })?.env;
    expect(firstEnv?.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/google-chrome-stable");

    existsSyncMock.mockClear();
    ensureBrowserDaemon(makeToolState());
    // cached: no second filesystem probe
    expect(existsSyncMock).not.toHaveBeenCalled();
    const secondEnv = (spawnSyncMock.mock.calls[3]?.[2] as { env?: Record<string, string> })?.env;
    expect(secondEnv?.AGENT_BROWSER_EXECUTABLE_PATH).toBe("/usr/bin/google-chrome-stable");
  });
});

describe("closeBrowserDaemon", () => {
  it("clears state without spawning when no daemon was started", async () => {
    const { closeBrowserDaemon, spawnSyncMock } = await loadBrowser();
    const toolState = makeToolState({ browserDaemon: { error: "never started" } });

    closeBrowserDaemon(toolState);

    expect(toolState.browserDaemon).toBeUndefined();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("sends the close command when a daemon is running", async () => {
    const { closeBrowserDaemon, spawnSyncMock } = await loadBrowser();
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 0 }));
    const toolState = makeToolState({ browserDaemon: { binDir: "/usr/local/bin" } });

    closeBrowserDaemon(toolState);

    expect(toolState.browserDaemon).toBeUndefined();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "agent-browser",
      ["close"],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("swallows close failures (best-effort)", async () => {
    const { closeBrowserDaemon, spawnSyncMock } = await loadBrowser();
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error("socket gone");
    });
    const toolState = makeToolState({ browserDaemon: { binDir: "/usr/local/bin" } });

    expect(() => closeBrowserDaemon(toolState)).not.toThrow();
    expect(toolState.browserDaemon).toBeUndefined();
  });
});
