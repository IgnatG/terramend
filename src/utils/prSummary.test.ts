import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "#app/mcp/server";
import {
  fetchPreviousSnapshot,
  persistSummary,
  readSummaryFile,
  SUMMARY_FILE_NAME,
  SUMMARY_SCAFFOLD,
  seedSummaryFile,
  summaryFilePath,
} from "#app/utils/prSummary";

vi.mock("#app/utils/apiFetch", () => ({
  apiFetch: vi.fn(),
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

vi.mock("#app/utils/patchWorkflowRunFields", () => ({
  patchWorkflowRunFields: vi.fn(async () => undefined),
}));

import { apiFetch } from "#app/utils/apiFetch";
import { patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";

const apiFetchMock = vi.mocked(apiFetch);
const patchMock = vi.mocked(patchWorkflowRunFields);

const TEMP = mkdtempSync(join(tmpdir(), "terramend-pr-summary-"));

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

// long enough to clear the 60-char minimum snapshot length
const LONG_SNAPSHOT = `# PR summary\n\n${"meaningful cross-run context. ".repeat(4)}`.trim();

let dirCounter = 0;
function freshDir(): string {
  dirCounter += 1;
  return join(TEMP, `run-${dirCounter}`);
}

describe("summaryFilePath", () => {
  it("joins the tmpdir with the well-known file name", () => {
    expect(summaryFilePath("/tmp/run")).toBe(join("/tmp/run", SUMMARY_FILE_NAME));
  });
});

describe("seedSummaryFile", () => {
  it("seeds with the scaffold on first runs (no previous snapshot)", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: null });
    expect(path).toBe(summaryFilePath(dir));
    await expect(readFile(path, "utf8")).resolves.toBe(SUMMARY_SCAFFOLD);
  });

  it("seeds with the previous snapshot when it is substantive", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: LONG_SNAPSHOT });
    await expect(readFile(path, "utf8")).resolves.toBe(LONG_SNAPSHOT);
  });

  it("falls back to the scaffold when the previous snapshot is too short", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: "tiny" });
    await expect(readFile(path, "utf8")).resolves.toBe(SUMMARY_SCAFFOLD);
  });
});

describe("readSummaryFile", () => {
  it("returns null when the file does not exist", async () => {
    await expect(readSummaryFile(join(TEMP, "missing.md"))).resolves.toBeNull();
  });

  it("returns null when the content is below the sanity minimum", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: null });
    // the scaffold itself is above the minimum; overwrite with something tiny
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "  short  ", "utf8");
    await expect(readSummaryFile(path)).resolves.toBeNull();
  });

  it("returns the trimmed content for valid snapshots", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: `${LONG_SNAPSHOT}\n\n` });
    await expect(readSummaryFile(path)).resolves.toBe(LONG_SNAPSHOT);
  });

  it("caps oversized snapshots at the maximum length", async () => {
    const dir = freshDir();
    const huge = "x".repeat(40_000);
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: huge });
    const read = await readSummaryFile(path);
    expect(read).toHaveLength(32_768);
    expect(huge.startsWith(read ?? "")).toBe(true);
  });
});

describe("fetchPreviousSnapshot", () => {
  function ctxWith(token: string | undefined): ToolContext {
    return {
      githubInstallationToken: token,
      repo: { owner: "acme", name: "infra" },
    } as unknown as ToolContext;
  }

  it("returns null without an installation token", async () => {
    await expect(fetchPreviousSnapshot(ctxWith(undefined), 7)).resolves.toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("returns null on non-ok responses", async () => {
    apiFetchMock.mockResolvedValueOnce({ ok: false } as Response);
    await expect(fetchPreviousSnapshot(ctxWith("tok"), 7)).resolves.toBeNull();
  });

  it("returns the snapshot from the API response", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot: "previous summary" }),
    } as Response);

    await expect(fetchPreviousSnapshot(ctxWith("tok"), 7)).resolves.toBe("previous summary");
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/repo/acme/infra/pr/7/summary-comment",
        method: "GET",
        headers: { authorization: "Bearer tok" },
      }),
    );
  });

  it("returns null for empty or missing snapshots", async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot: "" }),
    } as Response);
    await expect(fetchPreviousSnapshot(ctxWith("tok"), 7)).resolves.toBeNull();

    apiFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    await expect(fetchPreviousSnapshot(ctxWith("tok"), 7)).resolves.toBeNull();
  });

  it("returns null when the API call throws", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchPreviousSnapshot(ctxWith("tok"), 7)).resolves.toBeNull();
  });
});

describe("persistSummary", () => {
  function ctxWith(toolState: Record<string, unknown>): ToolContext {
    return { toolState } as unknown as ToolContext;
  }

  it("does nothing when no summary file was seeded", async () => {
    await persistSummary(ctxWith({}));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("does nothing when persistence was already attempted", async () => {
    await persistSummary(ctxWith({ summaryFilePath: "/tmp/x.md", summaryPersistAttempted: true }));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("skips the PATCH when the file is missing or invalid", async () => {
    const toolState: Record<string, unknown> = {
      summaryFilePath: join(TEMP, "never-written.md"),
    };
    await persistSummary(ctxWith(toolState));
    expect(toolState.summaryPersistAttempted).toBe(true);
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("skips the PATCH when the agent never edited the seed", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: LONG_SNAPSHOT });
    await persistSummary(ctxWith({ summaryFilePath: path, summarySeed: `${LONG_SNAPSHOT}\n` }));
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("persists the snapshot when the agent edited the file", async () => {
    const dir = freshDir();
    const edited = `${LONG_SNAPSHOT}\n\n## What changed\n\n- reviewed the auth flow end to end`;
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: edited });
    const ctx = ctxWith({ summaryFilePath: path, summarySeed: SUMMARY_SCAFFOLD });

    await persistSummary(ctx);

    expect(patchMock).toHaveBeenCalledWith(ctx, { summarySnapshot: edited });
  });

  it("persists even without a recorded seed", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: LONG_SNAPSHOT });
    await persistSummary(ctxWith({ summaryFilePath: path }));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows PATCH failures (best-effort)", async () => {
    const dir = freshDir();
    const path = await seedSummaryFile({ tmpdir: dir, previousSnapshot: LONG_SNAPSHOT });
    patchMock.mockRejectedValueOnce(new Error("api down"));

    await expect(persistSummary(ctxWith({ summaryFilePath: path }))).resolves.toBeUndefined();
  });
});
