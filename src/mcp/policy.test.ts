import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyCheckTool, parseConftestOutput } from "#app/mcp/policy";
import type { ToolContext } from "#app/mcp/server";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual, existsSync: vi.fn(() => false) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, default: actual, spawnSync: vi.fn() };
});

vi.mock("#app/utils/secrets", () => ({
  resolveEnv: vi.fn(() => ({})),
}));

const existsSyncMock = vi.mocked(existsSync);
const spawnSyncMock = vi.mocked(spawnSync);

describe("parseConftestOutput", () => {
  it("returns a clean pass for empty/malformed input", () => {
    expect(parseConftestOutput("")).toEqual({
      passed: true,
      failures: [],
      warnings: [],
      tested: 0,
    });
    expect(parseConftestOutput("not json")).toEqual({
      passed: true,
      failures: [],
      warnings: [],
      tested: 0,
    });
    expect(parseConftestOutput("{}")).toEqual({
      passed: true,
      failures: [],
      warnings: [],
      tested: 0,
    });
  });

  it("counts successes and reports zero failures as passed", () => {
    const out = parseConftestOutput(
      JSON.stringify([
        { filename: "plan.json", namespace: "main", successes: 3, failures: [], warnings: [] },
      ]),
    );
    expect(out.passed).toBe(true);
    expect(out.tested).toBe(3);
    expect(out.failures).toHaveLength(0);
  });

  it("captures failures with file + level and fails the gate", () => {
    const out = parseConftestOutput(
      JSON.stringify([
        {
          filename: "plan.json",
          successes: 1,
          failures: [{ msg: "S3 bucket must be encrypted" }],
          warnings: [{ msg: "consider tagging" }],
        },
      ]),
    );
    expect(out.passed).toBe(false);
    expect(out.failures).toEqual([
      { msg: "S3 bucket must be encrypted", file: "plan.json", level: "failure" },
    ]);
    expect(out.warnings).toEqual([
      { msg: "consider tagging", file: "plan.json", level: "warning" },
    ]);
    // 1 success + 1 failure + 1 warning
    expect(out.tested).toBe(3);
  });

  it("warnings alone do not fail the gate", () => {
    const out = parseConftestOutput(
      JSON.stringify([{ filename: "plan.json", warnings: [{ msg: "w" }] }]),
    );
    expect(out.passed).toBe(true);
    expect(out.warnings).toHaveLength(1);
  });

  it("aggregates failures across multiple files", () => {
    const out = parseConftestOutput(
      JSON.stringify([
        { filename: "a.json", failures: [{ msg: "x" }] },
        { filename: "b.json", failures: [{ msg: "y" }] },
      ]),
    );
    expect(out.passed).toBe(false);
    expect(out.failures.map((f) => f.file)).toEqual(["a.json", "b.json"]);
  });

  it("defaults a missing failure message and filename", () => {
    const out = parseConftestOutput(JSON.stringify([{ failures: [{}] }]));
    expect(out.failures[0]).toEqual({ msg: "policy violation", file: "(plan)", level: "failure" });
  });

  it("defaults a missing warning message", () => {
    const out = parseConftestOutput(JSON.stringify([{ warnings: [{}] }]));
    expect(out.warnings[0]).toEqual({ msg: "policy warning", file: "(plan)", level: "warning" });
  });
});

// ── PolicyCheckTool (the shell-out wrapper around the pure parser) ────────────

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

const CWD = join(path("ws"), "repo");

function path(...segs: string[]): string {
  return join("/", ...segs);
}

function makeCtx(cwd: string | undefined = CWD): ToolContext {
  return { payload: { cwd } } as unknown as ToolContext;
}

/** existsSync only returns true for the given absolute paths. */
function filesExist(...paths: string[]): void {
  existsSyncMock.mockImplementation((p) => paths.includes(String(p)));
}

function spawnResult(over: Partial<ReturnType<typeof spawnSync>>): ReturnType<typeof spawnSync> {
  return {
    pid: 1,
    output: [],
    stdout: "[]",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...over,
  } as unknown as ReturnType<typeof spawnSync>;
}

describe("PolicyCheckTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
  });

  it("skips with no_policy_dir when no default policy dir exists", async () => {
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("ok: false");
    expect(result.content[0].text).toContain("code: no_policy_dir");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("skips with no_policy_dir when the explicit policy_dir is missing", async () => {
    const result = await runTool(PolicyCheckTool(makeCtx()), { policy_dir: "rego" });

    expect(result.content[0].text).toContain("code: no_policy_dir");
    expect(existsSyncMock).toHaveBeenCalledWith(join(CWD, "rego"));
  });

  it("skips with target_not_found when the explicit target does not exist", async () => {
    filesExist(join(CWD, "policy"));
    const result = await runTool(PolicyCheckTool(makeCtx()), { target: "missing.json" });

    expect(result.content[0].text).toContain("code: target_not_found");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("skips with no_target when no conventional plan JSON exists", async () => {
    filesExist(join(CWD, "policies"));
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.content[0].text).toContain("code: no_target");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("skips with conftest_not_installed on a spawn ENOENT", async () => {
    filesExist(join(CWD, "policy"), join(CWD, "plan.json"));
    const enoent = Object.assign(new Error("spawn conftest ENOENT"), { code: "ENOENT" });
    spawnSyncMock.mockReturnValue(spawnResult({ error: enoent }));
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.content[0].text).toContain("code: conftest_not_installed");
  });

  it("skips with conftest_failed when a non-zero exit evaluated nothing", async () => {
    filesExist(join(CWD, "policy"), join(CWD, "plan.json"));
    spawnSyncMock.mockReturnValue(
      spawnResult({ status: 1, stdout: "", stderr: "rego_parse_error: unexpected token" }),
    );
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.content[0].text).toContain("code: conftest_failed");
    expect(result.content[0].text).toContain("rego_parse_error");
  });

  it("reports an unknown error when conftest fails without stderr", async () => {
    filesExist(join(CWD, "policy"), join(CWD, "plan.json"));
    spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: "", stderr: "   " }));
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.content[0].text).toContain("unknown error");
  });

  it("passes a clean evaluation and reports the resolved dir + target", async () => {
    filesExist(join(CWD, "policy"), join(CWD, "plan.json"));
    spawnSyncMock.mockReturnValue(
      spawnResult({ stdout: JSON.stringify([{ filename: "plan.json", successes: 4 }]) }),
    );
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    const text = result.content[0].text;
    expect(text).toContain("ok: true");
    expect(text).toContain("passed: true");
    expect(text).toContain("tested: 4");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "conftest",
      ["test", "--output", "json", "-p", join(CWD, "policy"), join(CWD, "plan.json")],
      expect.objectContaining({ cwd: CWD }),
    );
  });

  it("flows a genuine denial (non-zero exit WITH failures) through to passed: false", async () => {
    filesExist(join(CWD, "policy"), join(CWD, "plan.json"));
    spawnSyncMock.mockReturnValue(
      spawnResult({
        status: 1,
        stdout: JSON.stringify([
          { filename: "plan.json", failures: [{ msg: "bucket must be encrypted" }] },
        ]),
      }),
    );
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    const text = result.content[0].text;
    expect(text).toContain("ok: true");
    expect(text).toContain("passed: false");
    expect(text).toContain("failure_count: 1");
    expect(text).toContain("bucket must be encrypted");
  });

  it("falls back through the default policy dirs in order", async () => {
    filesExist(join(CWD, ".conftest"), join(CWD, "tfplan.json"));
    spawnSyncMock.mockReturnValue(spawnResult({ stdout: "[]" }));
    const result = await runTool(PolicyCheckTool(makeCtx()), {});

    expect(result.content[0].text).toContain("ok: true");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "conftest",
      expect.arrayContaining([join(CWD, ".conftest"), join(CWD, "tfplan.json")]),
      expect.anything(),
    );
  });

  it("accepts absolute policy_dir and target paths and a default cwd", async () => {
    const absPolicy = join(path("abs"), "rego");
    const absTarget = join(path("abs"), "plan.json");
    expect(isAbsolute(absPolicy)).toBe(true);
    filesExist(absPolicy, absTarget);
    spawnSyncMock.mockReturnValue(spawnResult({ stdout: "[]" }));
    const noCwdCtx = { payload: {} } as unknown as ToolContext;
    const result = await runTool(PolicyCheckTool(noCwdCtx), {
      policy_dir: absPolicy,
      target: absTarget,
    });

    expect(result.content[0].text).toContain("ok: true");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "conftest",
      ["test", "--output", "json", "-p", absPolicy, absTarget],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});
