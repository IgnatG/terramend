import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import type { ToolResult } from "#app/mcp/shared";

const cp = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: cp.spawn, spawnSync: cp.spawnSync };
});

/** minimal ChildProcess stand-in. emits nothing until the test says so. */
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = 12345;
  unref = vi.fn();
  kill = vi.fn(() => {
    this.emit("exit", null);
    return true;
  });
}

type ShellModule = typeof import("#app/mcp/shell");

/** fresh module instance so module-level caches (sandbox method, repo root)
 * don't leak between tests. */
async function loadShell(): Promise<ShellModule> {
  vi.resetModules();
  return await import("#app/mcp/shell");
}

function runTool(t: { execute: unknown }, params: Record<string, unknown>): Promise<ToolResult> {
  const exec = t.execute as (args: unknown, context?: unknown) => Promise<ToolResult>;
  return exec(params);
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

function makeCtx(over: Partial<Record<string, unknown>> = {}): {
  ctx: ToolContext;
  toolState: {
    backgroundProcesses: Map<string, { pid: number; outputPath: string; pidPath: string }>;
  };
} {
  const toolState = {
    backgroundProcesses: new Map<string, { pid: number; outputPath: string; pidPath: string }>(),
  };
  const ctx = {
    payload: { shell: over.shell ?? "restricted" },
    toolState,
  } as unknown as ToolContext;
  return { ctx, toolState };
}

let tempDir: string;

beforeEach(() => {
  vi.resetAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), "terramend-shell-test-"));
  vi.stubEnv("TERRAMEND_TEMP_DIR", tempDir);
  // default: no CI, no GHA workspace — sandbox detection returns "none" and
  // the repo-root probe is exercised explicitly where needed.
  vi.stubEnv("CI", "false");
  vi.stubEnv("GITHUB_WORKSPACE", "/work/repo");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSandboxMethod", () => {
  it("is 'none' outside CI and caches the result", async () => {
    const shell = await loadShell();
    expect(shell.getSandboxMethod()).toBe("none");
    expect(shell.getSandboxMethod()).toBe("none");
    expect(cp.spawnSync).not.toHaveBeenCalled();
  });

  it("uses unprivileged unshare when the probe succeeds in CI", async () => {
    vi.stubEnv("CI", "true");
    cp.spawnSync.mockReturnValue({ status: 0 });
    const shell = await loadShell();
    expect(shell.getSandboxMethod()).toBe("unshare");
    expect(cp.spawnSync).toHaveBeenCalledWith(
      "unshare",
      ["--pid", "--fork", "--mount-proc", "true"],
      { timeout: 5000, stdio: "ignore" },
    );
    // cached — no second probe
    shell.getSandboxMethod();
    expect(cp.spawnSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to sudo unshare when unprivileged unshare fails", async () => {
    vi.stubEnv("CI", "true");
    cp.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });
    const shell = await loadShell();
    expect(shell.getSandboxMethod()).toBe("sudo-unshare");
    expect(cp.spawnSync).toHaveBeenLastCalledWith(
      "sudo",
      ["unshare", "--pid", "--fork", "--mount-proc", "true"],
      { timeout: 5000, stdio: "ignore" },
    );
  });

  it("is 'none' when both probes fail (including thrown probes)", async () => {
    vi.stubEnv("CI", "true");
    cp.spawnSync.mockImplementation(() => {
      throw new Error("spawnSync ENOENT");
    });
    const shell = await loadShell();
    expect(shell.getSandboxMethod()).toBe("none");
  });
});

describe("shell tool git-command rejection", () => {
  it("rejects git invocations in all the shapes it detects", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const tool = shell.ShellTool(ctx);
    for (const command of [
      "git status",
      "git",
      "sudo git push origin main",
      "ls; git checkout main",
      "true && git commit -m x",
      "false || sudo git rebase",
    ]) {
      const result = await runTool(tool, { command, description: "d" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("git commands are not allowed");
    }
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("does not reject git as part of another word", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), {
      command: "cat .gitignore",
      description: "d",
    });
    proc.stdout.emit("data", Buffer.from("node_modules\n"));
    proc.emit("exit", 0);
    const result = await resultP;
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("node_modules");
  });
});

describe("shell tool foreground execution (no sandbox)", () => {
  it("runs bash -c and returns trimmed output with the exit code", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "echo hi", description: "d" });
    proc.stdout.emit("data", Buffer.from("hi\n"));
    proc.emit("exit", 0);
    const result = await resultP;
    expect(textOf(result)).toContain("hi");
    expect(textOf(result)).toContain("exit_code: 0");
    expect(cp.spawn).toHaveBeenCalledTimes(1);
    const call = cp.spawn.mock.calls[0] ?? [];
    expect(call[0]).toBe("bash");
    expect(call[1]).toEqual(["-c", "echo hi"]);
    expect(call[2]).toMatchObject({ detached: true });
  });

  it("combines stdout and stderr and surfaces non-zero exit codes", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "boom", description: "d" });
    proc.stdout.emit("data", Buffer.from("partial output\n"));
    proc.stderr.emit("data", Buffer.from("error: kaboom\n"));
    proc.emit("exit", 3);
    const result = await resultP;
    const text = textOf(result);
    expect(text).toContain("partial output");
    expect(text).toContain("error: kaboom");
    expect(text).toContain("exit_code: 3");
  });

  it("reports exit_code -1 when the process errors before exiting", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "nope", description: "d" });
    proc.emit("error", new Error("spawn failed"));
    const result = await resultP;
    expect(textOf(result)).toContain("exit_code: -1");
  });

  it("kills the process group and reports a timeout", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    try {
      const shell = await loadShell();
      const { ctx } = makeCtx();
      const proc = new FakeProc();
      cp.spawn.mockReturnValue(proc);
      const result = await runTool(shell.ShellTool(ctx), {
        command: "sleep 999",
        description: "d",
        timeout: 20,
      });
      const text = textOf(result);
      expect(text).toContain("timed_out: true");
      expect(text).toContain("exit_code: 124");
      expect(text).toContain("[timed out after 20ms]");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("escalates SIGTERM to SIGKILL when the group survives the grace period", async () => {
    const proc = new FakeProc();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number,
      signal?: string | number,
    ) => {
      if (signal === "SIGKILL") proc.emit("exit", null);
      return true;
    }) as typeof process.kill);
    try {
      const shell = await loadShell();
      const { ctx } = makeCtx();
      cp.spawn.mockReturnValue(proc);
      const result = await runTool(shell.ShellTool(ctx), {
        command: "sleep 999",
        description: "d",
        timeout: 20,
      });
      expect(textOf(result)).toContain("timed_out: true");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("filters secrets from the child env in restricted mode", async () => {
    vi.stubEnv("SOME_PROVIDER_TOKEN", "sekrit");
    const shell = await loadShell();
    const { ctx } = makeCtx({ shell: "restricted" });
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "env", description: "d" });
    proc.emit("exit", 0);
    await resultP;
    const opts = (cp.spawn.mock.calls[0] ?? [])[2] as { env: Record<string, string> };
    expect(opts.env.SOME_PROVIDER_TOKEN).toBeUndefined();
  });

  it("passes the full env through in enabled mode", async () => {
    vi.stubEnv("SOME_PROVIDER_TOKEN", "sekrit");
    const shell = await loadShell();
    const { ctx } = makeCtx({ shell: "enabled" });
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "env", description: "d" });
    proc.emit("exit", 0);
    await resultP;
    const opts = (cp.spawn.mock.calls[0] ?? [])[2] as { env: Record<string, string> };
    expect(opts.env.SOME_PROVIDER_TOKEN).toBe("sekrit");
  });

  it("spills output beyond MAX_OUTPUT_CHARS to a tempfile, returning the tail", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const body = `HEAD-MARKER${"x".repeat(6000)}TAIL-MARKER`;
    const resultP = runTool(shell.ShellTool(ctx), { command: "biglog", description: "d" });
    proc.stdout.emit("data", Buffer.from(body));
    proc.emit("exit", 0);
    const result = await resultP;
    const text = textOf(result);
    expect(text).toContain("chars truncated; full output saved to");
    expect(text).toContain("TAIL-MARKER");
    expect(text).not.toContain("HEAD-MARKER");
    const match = text.match(/saved to (\S*shell-[0-9a-f]{8}\.log)/);
    expect(match).not.toBeNull();
    expect(readFileSync(match?.[1] ?? "", "utf-8")).toBe(body);
  });
});

describe("shell tool sandbox command construction", () => {
  it("wraps the command with proc/socket/fs mounts under unshare", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_WORKSPACE", "/work/it's repo");
    cp.spawnSync.mockReturnValue({ status: 0 }); // unprivileged unshare available
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "ls", description: "d" });
    proc.emit("exit", 0);
    await resultP;

    const call = cp.spawn.mock.calls[0] ?? [];
    expect(call[0]).toBe("unshare");
    const args = call[1] as string[];
    expect(args.slice(0, 5)).toEqual(["--pid", "--fork", "--mount-proc", "bash", "-c"]);
    const script = args[5] ?? "";
    expect(script).toContain("umount /proc");
    expect(script).toContain("mount --bind /dev/null /var/run/docker.sock");
    expect(script).toContain("mkdir -p /var/lib/terramend");
    expect(script).toContain("mount -t tmpfs tmpfs /var/lib/terramend");
    expect(script).toContain('"$RUNNER_TEMP/_runner_file_commands"');
    // repo root comes from GITHUB_WORKSPACE, shell-escaped for the embedded quote
    expect(script).toContain("'/work/it'\\''s repo/.git'");
    expect(script.endsWith("ls")).toBe(true);
  });

  it("drops privileges back to the user under sudo-unshare with a scrubbed env", async () => {
    vi.stubEnv("CI", "true");
    cp.spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "make build", description: "d" });
    proc.emit("exit", 0);
    await resultP;

    const call = cp.spawn.mock.calls[0] ?? [];
    expect(call[0]).toBe("sudo");
    const args = call[1] as string[];
    expect(args[0]).toBe("env");
    // env is forwarded as KEY=value args (incl. the PATH restore var)
    expect(args.some((a) => a.startsWith("SANDBOX_PATH="))).toBe(true);
    const unshareIdx = args.indexOf("unshare");
    expect(unshareIdx).toBeGreaterThan(0);
    const script = args[args.length - 1] ?? "";
    expect(script).toContain("exec su -p -s /bin/bash");
    expect(script).toContain("export PATH=");
    expect(script).toContain("make build");
    // spawn options env is emptied — secrets ride only the explicit env args
    const opts = call[2] as { env: Record<string, string> };
    expect(opts.env).toEqual({});
  });

  it("refuses to run unsandboxed in CI", async () => {
    vi.stubEnv("CI", "true");
    cp.spawnSync.mockReturnValue({ status: 1 }); // both probes fail
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const result = await runTool(shell.ShellTool(ctx), { command: "ls", description: "d" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("pid namespace isolation is required in CI");
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("falls back to `git rev-parse --show-toplevel` when GITHUB_WORKSPACE is unset", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_WORKSPACE", "");
    cp.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "git") return { status: 0, stdout: "/resolved/root\n" };
      return { status: 0 };
    });
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "ls", description: "d" });
    proc.emit("exit", 0);
    await resultP;
    const args = (cp.spawn.mock.calls[0] ?? [])[1] as string[];
    expect(args[5] ?? "").toContain("'/resolved/root/.git'");
    expect(cp.spawnSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("falls back to process.cwd() when the git probe yields nothing", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("GITHUB_WORKSPACE", "");
    cp.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === "git") return { status: 128, stdout: undefined };
      return { status: 0 };
    });
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    cp.spawn.mockReturnValue(proc);
    const resultP = runTool(shell.ShellTool(ctx), { command: "ls", description: "d" });
    proc.emit("exit", 0);
    await resultP;
    const args = (cp.spawn.mock.calls[0] ?? [])[1] as string[];
    expect(args[5] ?? "").toContain(".git");
  });
});

describe("background processes", () => {
  it("starts a detached background process and records its handle", async () => {
    const shell = await loadShell();
    const { ctx, toolState } = makeCtx();
    const proc = new FakeProc();
    proc.pid = 4242;
    cp.spawn.mockReturnValue(proc);
    const result = await runTool(shell.ShellTool(ctx), {
      command: "npm run dev",
      description: "d",
      background: true,
    });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text).toMatch(/bg-[0-9a-f]{8}/);
    expect(text).toContain("pid 4242");
    expect(proc.unref).toHaveBeenCalled();
    expect(toolState.backgroundProcesses.size).toBe(1);
    const entry = [...toolState.backgroundProcesses.values()][0];
    expect(entry?.pid).toBe(4242);
    expect(existsSync(entry?.pidPath ?? "")).toBe(true);
    expect(readFileSync(entry?.pidPath ?? "", "utf-8")).toBe("4242\n");
  });

  it("errors when TERRAMEND_TEMP_DIR is unset for a background process", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", "");
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const result = await runTool(shell.ShellTool(ctx), {
      command: "npm run dev",
      description: "d",
      background: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TERRAMEND_TEMP_DIR not set");
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("errors when the background process fails to start (no pid)", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const proc = new FakeProc();
    proc.pid = undefined;
    cp.spawn.mockReturnValue(proc);
    const result = await runTool(shell.ShellTool(ctx), {
      command: "npm run dev",
      description: "d",
      background: true,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("failed to start background process");
  });

  it("kill_background reports unknown handles", async () => {
    const shell = await loadShell();
    const { ctx } = makeCtx();
    const result = await runTool(shell.KillBackgroundTool(ctx), { handle: "bg-deadbeef" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("no background process with handle bg-deadbeef");
  });

  it("kill_background terminates the group and forgets the handle", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const shell = await loadShell();
      const { ctx, toolState } = makeCtx();
      toolState.backgroundProcesses.set("bg-cafe0123", {
        pid: 777,
        outputPath: join(tempDir, "bg-cafe0123.log"),
        pidPath: join(tempDir, "bg-cafe0123.pid"),
      });
      const result = await runTool(shell.KillBackgroundTool(ctx), { handle: "bg-cafe0123" });
      expect(textOf(result)).toContain("killed background process bg-cafe0123 (pid 777)");
      expect(killSpy).toHaveBeenCalledWith(-777, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-777, "SIGKILL");
      expect(toolState.backgroundProcesses.size).toBe(0);
    } finally {
      killSpy.mockRestore();
    }
  });
});
