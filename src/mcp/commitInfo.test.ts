import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitInfoTool } from "#app/mcp/commitInfo";
import type { ToolContext } from "#app/mcp/server";

type ToolResultShape = { content: [{ type: "text"; text: string }]; isError?: boolean };

async function runTool(t: { execute?: unknown }, params: unknown): Promise<ToolResultShape> {
  const exec = t.execute as (p: unknown, c: unknown) => Promise<ToolResultShape>;
  return exec(params, {});
}

const fullCommit = {
  sha: "abc1234def5678",
  html_url: "https://gh/commit/abc1234",
  commit: {
    message: "fix: tighten bucket policy",
    author: { date: "2026-01-01T00:00:00Z" },
    committer: { date: "2026-01-02T00:00:00Z" },
  },
  author: { login: "alice" },
  committer: null,
  parents: [{ sha: "p1" }, { sha: "p2" }],
  stats: { additions: 3, deletions: 1, total: 4 },
  files: [
    {
      filename: "main.tf",
      patch: "@@ -1,2 +1,3 @@\n resource\n+  versioning = true\n }",
    },
  ],
};

function makeCtx(commitData: Record<string, unknown>) {
  const getCommit = vi.fn(async (_p: unknown) => ({ data: commitData }));
  const ctx = {
    octokit: { rest: { repos: { getCommit } } },
    repo: { owner: "octo", name: "repo" },
  } as unknown as ToolContext;
  return { ctx, getCommit };
}

describe("CommitInfoTool", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "terramend-commitinfo-"));
    vi.stubEnv("TERRAMEND_TEMP_DIR", tempDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns commit metadata and writes the formatted diff to disk", async () => {
    const { ctx, getCommit } = makeCtx(fullCommit);
    const result = await runTool(CommitInfoTool(ctx), { sha: "abc1234def5678" });

    expect(result.isError).toBeUndefined();
    expect(getCommit).toHaveBeenCalledWith({ owner: "octo", repo: "repo", ref: "abc1234def5678" });

    const text = result.content[0].text;
    expect(text).toContain("fix: tighten bucket policy");
    expect(text).toContain("alice");
    expect(text).toContain("2026-01-01T00:00:00Z");
    expect(text).toContain("fileCount: 1");
    expect(text).toContain("commit-abc1234.diff");

    const diff = readFileSync(join(tempDir, "commit-abc1234.diff"), "utf-8");
    expect(diff).toContain("main.tf");
    expect(diff).toContain("versioning = true");
  });

  it("falls back to committer date and zeroed stats when fields are missing", async () => {
    const { ctx } = makeCtx({
      ...fullCommit,
      author: undefined,
      committer: { login: "bot" },
      commit: { message: "chore", committer: { date: "2026-02-02T00:00:00Z" } },
      stats: undefined,
      files: undefined,
      parents: [],
    });
    const result = await runTool(CommitInfoTool(ctx), { sha: "abc1234def5678" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("author: null");
    expect(text).toContain("bot");
    expect(text).toContain("2026-02-02T00:00:00Z");
    expect(text).toContain("fileCount: 0");
    expect(text).toContain("additions: 0");
  });

  it("renders an empty date when neither author nor committer dates exist", async () => {
    const { ctx } = makeCtx({
      ...fullCommit,
      commit: { message: "chore" },
      files: [{ filename: "image.png" }],
    });
    const result = await runTool(CommitInfoTool(ctx), { sha: "abc1234def5678" });

    expect(result.isError).toBeUndefined();
    const diff = readFileSync(join(tempDir, "commit-abc1234.diff"), "utf-8");
    expect(diff).toContain("(binary file or no changes)");
  });

  it("errors when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", "");
    const { ctx } = makeCtx(fullCommit);
    const result = await runTool(CommitInfoTool(ctx), { sha: "abc1234def5678" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TERRAMEND_TEMP_DIR not set");
  });

  it("surfaces API failures as tool errors", async () => {
    const { ctx, getCommit } = makeCtx(fullCommit);
    getCommit.mockRejectedValueOnce(new Error("No commit found"));
    const result = await runTool(CommitInfoTool(ctx), { sha: "deadbeef" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No commit found");
  });
});
