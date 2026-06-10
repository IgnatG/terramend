import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli as runGhaCli } from "#app/commands/gha";

vi.mock("#app/commands/gha", () => ({ runCli: vi.fn(async () => {}) }));

const ORIGINAL_ARGV = process.argv;

type ConsoleSpy = { mock: { calls: unknown[][] } };

let logSpy: ConsoleSpy;
let errorSpy: ConsoleSpy;
let exitSpy: { mock: { calls: unknown[][] } };

/**
 * cli.ts runs its command dispatch at module top level, so each scenario
 * re-imports it with a fresh module registry and stubbed process.argv.
 * `process.exit` is mocked to throw, which the module's own top-level catch
 * converts into a second exit(1) — flows that exit therefore reject the
 * dynamic import with "process.exit:1".
 */
async function importCli(argv: string[]): Promise<{ rejection: unknown }> {
  process.argv = ["node", "/usr/local/bin/terramend", ...argv];
  vi.resetModules();
  try {
    await import("#app/cli");
    return { rejection: undefined };
  } catch (error) {
    return { rejection: error };
  }
}

function loggedLines(spy: ConsoleSpy): string {
  return spy.mock.calls.map((call) => call.join(" ")).join("\n");
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("cli entry", () => {
  it("prints the version and exits 0 on --version", async () => {
    vi.stubEnv("CLI_VERSION", "1.2.3");

    const { rejection } = await importCli(["--version"]);

    expect(logSpy).toHaveBeenCalledWith("1.2.3");
    expect(exitSpy.mock.calls[0]).toEqual([0]);
    expect(rejection).toBeInstanceOf(Error);
  });

  it("prints usage and exits 0 when no command is given", async () => {
    await importCli([]);

    expect(loggedLines(logSpy)).toContain("usage: terramend <command>");
    expect(loggedLines(logSpy)).toContain("gha");
    expect(exitSpy.mock.calls[0]).toEqual([0]);
  });

  it("prints the banner and usage on --help without a command", async () => {
    await importCli(["--help"]);

    expect(loggedLines(logSpy)).toContain("terramend");
    expect(loggedLines(logSpy)).toContain("usage: terramend <command>");
    expect(exitSpy.mock.calls[0]).toEqual([0]);
  });

  it("prints usage and exits 0 on --help with an unknown command", async () => {
    await importCli(["--help", "wat"]);

    expect(loggedLines(logSpy)).toContain("usage: terramend <command>");
    expect(exitSpy.mock.calls[0]).toEqual([0]);
    expect(runGhaCli).not.toHaveBeenCalled();
  });

  it("dispatches the gha command with its arguments", async () => {
    const { rejection } = await importCli(["gha", "token", "--post"]);

    expect(rejection).toBeUndefined();
    expect(runGhaCli).toHaveBeenCalledWith({
      args: ["token", "--post"],
      prog: "terramend",
      showHelp: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("forwards showHelp to the gha command on --help gha", async () => {
    const { rejection } = await importCli(["--help", "gha"]);

    expect(rejection).toBeUndefined();
    expect(runGhaCli).toHaveBeenCalledWith({ args: [], prog: "terramend", showHelp: true });
  });

  it("errors with usage on an unknown command", async () => {
    await importCli(["frobnicate"]);

    expect(loggedLines(errorSpy)).toContain("unknown command:");
    expect(loggedLines(errorSpy)).toContain("usage: terramend <command>");
    expect(exitSpy.mock.calls[0]).toEqual([1]);
  });

  it("errors with usage on an unknown global option", async () => {
    await importCli(["--bogus"]);

    expect(loggedLines(errorSpy)).toContain("unknown or unexpected option: --bogus");
    expect(exitSpy.mock.calls[0]).toEqual([1]);
  });

  it("reports command failures via the top-level catch and exits 1", async () => {
    vi.mocked(runGhaCli).mockRejectedValueOnce(new Error("gha blew up"));

    const { rejection } = await importCli(["gha"]);

    expect(loggedLines(errorSpy)).toContain("gha blew up");
    expect(exitSpy.mock.calls[0]).toEqual([1]);
    expect(rejection).toBeInstanceOf(Error);
  });
});
