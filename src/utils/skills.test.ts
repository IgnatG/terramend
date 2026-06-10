import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addSkill, installBundledSkills } from "#app/utils/skills";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
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

import { spawnSync } from "node:child_process";
import { log } from "#app/utils/cli";

const spawnSyncMock = vi.mocked(spawnSync);
const successMock = vi.mocked(log.success);
const warningMock = vi.mocked(log.warning);

const TEMP = mkdtempSync(join(tmpdir(), "terramend-skills-"));

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

function spawnSyncResult(
  init: {
    status?: number | null;
    signal?: string | null;
    stdout?: string;
    stderr?: string;
    error?: Error;
  } = {},
): ReturnType<typeof spawnSync> {
  return {
    // preserve an explicit null status (killed-by-signal shape)
    status: init.status === undefined ? 0 : init.status,
    signal: init.signal ?? null,
    stdout: Buffer.from(init.stdout ?? ""),
    stderr: Buffer.from(init.stderr ?? ""),
    error: init.error,
    pid: 1,
    output: [],
  } as unknown as ReturnType<typeof spawnSync>;
}

describe("installBundledSkills", () => {
  it("writes every bundled skill into all agent auto-scan dirs under HOME", () => {
    const home = join(TEMP, "home");
    installBundledSkills({ home });

    const targets = [".opencode/skills", ".claude/skills", ".agents/skills"].map((dir) =>
      join(home, dir, "terraform-best-practices", "SKILL.md"),
    );
    const contents = targets.map((path) => readFileSync(path, "utf8"));
    for (const content of contents) {
      expect(content.length).toBeGreaterThan(0);
      expect(content).toBe(contents[0]);
    }
    expect(successMock).toHaveBeenCalledWith(expect.stringContaining("terraform-best-practices"));
  });
});

describe("addSkill", () => {
  const params = {
    ref: "owner/repo",
    skill: "my-skill",
    env: { HOME: "/fake/home" },
    agent: "claude-code",
  };

  it("invokes the pinned skills CLI globally and logs success", () => {
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: 0 }));

    addSkill(params);

    const call = spawnSyncMock.mock.calls[0];
    expect(call?.[0]).toBe("npx");
    const args = call?.[1] as string[];
    expect(args).toContain("add");
    expect(args).toContain("owner/repo");
    expect(args).toContain("--skill");
    expect(args).toContain("my-skill");
    expect(args).toContain("-g");
    expect(args.find((a) => a.startsWith("skills@"))).toMatch(/^skills@\d+\.\d+\.\d+$/);
    const opts = call?.[2] as { env?: Record<string, string>; timeout?: number };
    expect(opts.env?.HOME).toBe("/fake/home");
    expect(opts.timeout).toBe(30_000);
    expect(successMock).toHaveBeenCalledWith("installed my-skill skill (claude-code)");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("logs a warning with exit code and both streams on failure", () => {
    spawnSyncMock.mockReturnValueOnce(
      spawnSyncResult({
        status: 1,
        stdout: "clack spinner says no",
        stderr: "boom",
        error: new Error("spawn npx ENOENT"),
      }),
    );

    addSkill(params);

    expect(successMock).not.toHaveBeenCalled();
    const message = warningMock.mock.calls[0]?.[0] as string;
    expect(message).toContain("my-skill skill install failed");
    expect(message).toContain("exit=1 signal=null");
    expect(message).toContain("spawn error: spawn npx ENOENT");
    expect(message).toContain("stderr:\nboom");
    expect(message).toContain("stdout:\nclack spinner says no");
  });

  it("tail-truncates long output streams in the failure message", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    spawnSyncMock.mockReturnValueOnce(spawnSyncResult({ status: null, stdout: lines }));

    addSkill(params);

    const message = warningMock.mock.calls[0]?.[0] as string;
    expect(message).toContain("exit=null");
    expect(message).toContain("...(truncated, last 20 of 30 lines)");
    expect(message).toContain("line 30");
    expect(message).not.toContain("line 10\n");
  });
});
