import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeLog, GetCheckSuiteLogsTool } from "#app/mcp/checkSuite";
import type { ToolContext } from "#app/mcp/server";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, default: actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

type WorkflowRun = { id: number; conclusion: string };
type Job = {
  id: number;
  name: string;
  conclusion: string;
  html_url?: string | null;
  steps?: { number: number; name: string; conclusion: string }[];
};

function makeCtx(runs: WorkflowRun[], jobs: Job[]) {
  const rest = {
    actions: {
      listWorkflowRunsForRepo: { endpoint: "runs" },
      listJobsForWorkflowRun: { endpoint: "jobs" },
      downloadJobLogsForWorkflowRun: vi.fn(async (_p: unknown) => ({
        url: "https://logs.example/job",
      })),
    },
  };
  const paginate = vi.fn(async (endpoint: unknown) => {
    if (endpoint === rest.actions.listWorkflowRunsForRepo) return runs;
    if (endpoint === rest.actions.listJobsForWorkflowRun) return jobs;
    throw new Error("unexpected paginate endpoint");
  });
  const octokit = { rest, paginate };
  const ctx = {
    octokit,
    repo: { owner: "octo", name: "repo" },
  } as unknown as ToolContext;
  return { ctx, octokit };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TERRAMEND_TEMP_DIR", join("/tmp", "terramend-test"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => "##[error] boom" })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("analyzeLog", () => {
  it("indexes error, warning, failure, and trace lines with 1-based line numbers", () => {
    const logs = [
      "setup ok",
      "##[error]Process completed with exit code 1.",
      "##[warning]node version is old",
      "Tests: 2 failed, 5 passed",
      "    at Object.<anonymous> (test.ts:1:1)",
    ].join("\n");
    const { index } = analyzeLog(logs);
    expect(index).toEqual([
      { line: 2, content: "##[error]Process completed with exit code 1.", type: "error" },
      { line: 3, content: "##[warning]node version is old", type: "warning" },
      { line: 4, content: "Tests: 2 failed, 5 passed", type: "failure" },
      { line: 5, content: "at Object.<anonymous> (test.ts:1:1)", type: "trace" },
    ]);
  });

  it("strips ANSI escape codes before matching", () => {
    const logs = "\x1b[31mError: red alert\x1b[0m";
    const { index } = analyzeLog(logs);
    expect(index).toEqual([{ line: 1, content: "Error: red alert", type: "error" }]);
  });

  it("skips apt/dpkg WARN noise but keeps real warnings", () => {
    const logs = ["WARN apt does not have a stable CLI", "WARN deprecated dependency"].join("\n");
    const { index } = analyzeLog(logs);
    expect(index).toEqual([{ line: 2, content: "WARN deprecated dependency", type: "warning" }]);
  });

  it("dedupes consecutive stack-trace lines", () => {
    const logs = [
      "Error: kaput",
      "    at first (a.ts:1:1)",
      "    at second (b.ts:2:2)",
      "FAIL src/x.test.ts",
      "    at third (c.ts:3:3)",
    ].join("\n");
    const { index } = analyzeLog(logs);
    const traces = index.filter((l) => l.type === "trace");
    expect(traces).toHaveLength(2);
    expect(traces[0]?.content).toContain("first");
    expect(traces[1]?.content).toContain("third");
  });

  it("truncates indexed lines longer than 120 characters", () => {
    const long = `Error: ${"x".repeat(150)}`;
    const { index } = analyzeLog(long);
    expect(index[0]?.content.length).toBeLessThanOrEqual(120);
    expect(index[0]?.content.endsWith("...")).toBe(true);
  });

  it("centers the excerpt on the LAST ##[error] line", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    lines[49] = "##[error]first failure";
    lines[149] = "##[error]second failure";
    const { excerpt } = analyzeLog(lines.join("\n"), 80);
    // last error at index 149 → start = 149 - 75 = 74 (line 75), end = 149 + 5 = 154
    expect(excerpt.startLine).toBe(75);
    expect(excerpt.endLine).toBe(154);
    expect(excerpt.content).toContain("##[error]second failure");
    expect(excerpt.content).not.toContain("##[error]first failure");
  });

  it("falls back to the tail window when no ##[error] exists", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const result = analyzeLog(lines.join("\n"), 10);
    expect(result.totalLines).toBe(100);
    expect(result.excerpt.startLine).toBe(91);
    expect(result.excerpt.endLine).toBe(100);
    expect(result.excerpt.content).toContain("line 100");
  });

  it("clamps the excerpt start for an error near the top of the log", () => {
    const logs = ["##[error]early", "after"].join("\n");
    const { excerpt } = analyzeLog(logs, 80);
    expect(excerpt.startLine).toBe(1);
  });
});

describe("GetCheckSuiteLogsTool", () => {
  it("returns a no-failures message when no workflow run failed", async () => {
    const { ctx, octokit } = makeCtx([{ id: 1, conclusion: "success" }], []);
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("no failed workflow runs found");
    expect(octokit.paginate).toHaveBeenCalledTimes(1);
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it("errors when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", "");
    const { ctx } = makeCtx([{ id: 1, conclusion: "failure" }], []);
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TERRAMEND_TEMP_DIR not set");
  });

  it("downloads, persists, and analyzes the logs of each failed job", async () => {
    const { ctx, octokit } = makeCtx(
      [
        { id: 1, conclusion: "failure" },
        { id: 2, conclusion: "success" },
      ],
      [
        {
          id: 11,
          name: "build",
          conclusion: "failure",
          html_url: "https://gh/job/11",
          steps: [
            { number: 1, name: "checkout", conclusion: "success" },
            { number: 2, name: "test", conclusion: "failure" },
          ],
        },
        { id: 12, name: "lint", conclusion: "success" },
      ],
    );
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBeUndefined();
    expect(octokit.rest.actions.downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(octokit.rest.actions.downloadJobLogsForWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "octo", repo: "repo", job_id: 11 }),
    );
    const logPath = join(join("/tmp", "terramend-test"), "ci-logs", "job-11.log");
    expect(mkdirSync).toHaveBeenCalledWith(join(join("/tmp", "terramend-test"), "ci-logs"), {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(logPath, "##[error] boom");
    const text = result.content[0].text;
    expect(text).toContain("build");
    expect(text).toContain("Step 2: test");
    expect(text).not.toContain("Step 1: checkout");
    expect(text).toContain("job-11.log");
    expect(text).toContain("##[error] boom");
  });

  it("defaults html_url and failed_steps when the job omits them", async () => {
    const { ctx } = makeCtx(
      [{ id: 1, conclusion: "failure" }],
      [{ id: 11, name: "build", conclusion: "failure", html_url: null }],
    );
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("failed_steps: []");
  });

  it("skips a job whose log fetch returns a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 410, statusText: "Gone", text: async () => "" })),
    );
    const { ctx } = makeCtx(
      [{ id: 1, conclusion: "failure" }],
      [{ id: 11, name: "build", conclusion: "failure" }],
    );
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("failed_jobs: []");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("skips a job whose log-URL request rejects", async () => {
    const { ctx, octokit } = makeCtx(
      [{ id: 1, conclusion: "failure" }],
      [{ id: 11, name: "build", conclusion: "failure" }],
    );
    octokit.rest.actions.downloadJobLogsForWorkflowRun.mockRejectedValueOnce(
      new Error("api exploded"),
    );
    const result = await runTool(GetCheckSuiteLogsTool(ctx), { check_suite_id: 77 });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("failed_jobs: []");
  });
});
