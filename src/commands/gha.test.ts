import { dirname } from "node:path";
import * as core from "@actions/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "#app/main";
import { acquireInstallationToken, revokeInstallationToken } from "#app/utils/token";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(() => ""),
  getState: vi.fn(() => ""),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
  saveState: vi.fn(),
  setOutput: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("#app/main", () => ({ main: vi.fn(async () => ({ success: true })) }));
vi.mock("#app/utils/token", () => ({
  acquireInstallationToken: vi.fn(async () => "inst-token"),
  revokeInstallationToken: vi.fn(async () => {}),
}));

// gha.ts prepends the action runtime's node bin dir to PATH at import time —
// import dynamically so the original PATH can be captured and restored.
const SAVED_PATH = process.env.PATH;
let gha: typeof import("#app/commands/gha");

beforeAll(async () => {
  gha = await import("#app/commands/gha");
});

afterAll(() => {
  process.env.PATH = SAVED_PATH;
});

type ConsoleSpy = { mock: { calls: unknown[][] } };

let logSpy: ConsoleSpy;
let errorSpy: ConsoleSpy;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function loggedLines(spy: ConsoleSpy): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

describe("gha module import", () => {
  it("prepends the action runtime's node bin dir to PATH", () => {
    expect(process.env.PATH).toContain(dirname(process.execPath));
  });
});

describe("runCli – help and arg handling", () => {
  it("prints gha usage when showHelp is set", async () => {
    await gha.runCli({ args: [], prog: "terramend", showHelp: true });

    expect(loggedLines(logSpy)).toContain("usage: terramend gha [subcommand]");
    expect(main).not.toHaveBeenCalled();
  });

  it("prints gha usage on --help", async () => {
    await gha.runCli({ args: ["--help"], prog: "terramend" });

    expect(loggedLines(logSpy)).toContain("usage: terramend gha [subcommand]");
  });

  it("errors with usage and exits 1 on an unknown option", async () => {
    await expect(gha.runCli({ args: ["--bogus"], prog: "terramend" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(loggedLines(errorSpy)).toContain("usage: terramend gha [subcommand]");
  });

  it("errors and exits 1 on an unknown subcommand", async () => {
    await expect(gha.runCli({ args: ["frobnicate"], prog: "terramend" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(loggedLines(errorSpy)).toContain("unknown gha subcommand: frobnicate");
  });

  it("runs the main action flow when no subcommand is given", async () => {
    await gha.runCli({ args: [], prog: "terramend" });

    expect(main).toHaveBeenCalledOnce();
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

describe("runCli – gha token", () => {
  it("prints token usage on gha token --help", async () => {
    await gha.runCli({ args: ["token", "--help"], prog: "terramend" });

    expect(loggedLines(logSpy)).toContain("usage: terramend gha token [--post]");
    expect(acquireInstallationToken).not.toHaveBeenCalled();
  });

  it("rejects unexpected positional arguments", async () => {
    await expect(gha.runCli({ args: ["token", "extra"], prog: "terramend" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(loggedLines(errorSpy)).toContain("unexpected positional arguments for gha token: extra");
  });

  it("errors with token usage on an unknown token option", async () => {
    await expect(gha.runCli({ args: ["token", "--bogus"], prog: "terramend" })).rejects.toThrow(
      "process.exit:1",
    );
    expect(loggedLines(errorSpy)).toContain("usage: terramend gha token [--post]");
  });

  it("acquires a token scoped to the current repo by default", async () => {
    await gha.runCli({ args: ["token"], prog: "terramend" });

    expect(acquireInstallationToken).toHaveBeenCalledWith({ repos: [] });
    expect(core.setSecret).toHaveBeenCalledWith("inst-token");
    expect(core.saveState).toHaveBeenCalledWith("token", "inst-token");
    expect(core.setOutput).toHaveBeenCalledWith("token", "inst-token");
    expect(core.info).toHaveBeenCalledWith("» installation token acquired (current repo only)");
  });

  it("acquires a token for additional repos from the repos input", async () => {
    vi.mocked(core.getInput).mockReturnValueOnce("octo/a, octo/b ,");

    await gha.runCli({ args: ["token"], prog: "terramend" });

    expect(acquireInstallationToken).toHaveBeenCalledWith({ repos: ["octo/a", "octo/b"] });
    expect(core.info).toHaveBeenCalledWith(
      "» installation token acquired (current repo + octo/a, octo/b)",
    );
  });

  it("revokes the saved token in the post step", async () => {
    vi.mocked(core.getState).mockReturnValueOnce("saved-token");

    await gha.runCli({ args: ["token", "--post"], prog: "terramend" });

    expect(revokeInstallationToken).toHaveBeenCalledWith("saved-token");
    expect(core.info).toHaveBeenCalledWith("» installation token revoked");
  });

  it("skips revocation when no token was saved", async () => {
    await gha.runCli({ args: ["token", "--post"], prog: "terramend" });

    expect(revokeInstallationToken).not.toHaveBeenCalled();
    expect(core.debug).toHaveBeenCalledWith("no token found in state, skipping revocation");
  });
});

describe("run – failure reporting", () => {
  it("setFailed when main reports an unsuccessful run", async () => {
    vi.mocked(main).mockResolvedValueOnce({ success: false, error: "agent gave up" });

    await gha.run([]);

    expect(core.setFailed).toHaveBeenCalledWith("action failed: agent gave up");
  });

  it("setFailed with a fallback message when main fails without an error", async () => {
    vi.mocked(main).mockResolvedValueOnce({ success: false });

    await gha.run([]);

    expect(core.setFailed).toHaveBeenCalledWith("action failed: agent execution failed");
  });

  it("setFailed when main throws", async () => {
    vi.mocked(main).mockRejectedValueOnce(new Error("boom"));

    await gha.run([]);

    expect(core.setFailed).toHaveBeenCalledWith("action failed: boom");
  });

  it("setFailed when token acquisition throws", async () => {
    vi.mocked(acquireInstallationToken).mockRejectedValueOnce(new Error("no app key"));

    await gha.run(["token"]);

    expect(core.setFailed).toHaveBeenCalledWith("no app key");
  });
});
