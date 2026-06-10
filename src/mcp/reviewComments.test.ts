import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Unwrap the ToolResult envelope so the *Tool tests can assert on the raw
// object each tool returns. The pure formatters above are unaffected.
vi.mock("#app/mcp/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/mcp/shared")>();
  return {
    ...actual,
    execute: <T, R>(fn: (params: T) => Promise<R>): ((params: T) => Promise<R>) => fn,
  };
});

import {
  buildThreadBlocks,
  countLines,
  type FormatReviewDataInput,
  formatReviewData,
  formatReviewThreads,
  GetReviewCommentsTool,
  ListPullRequestReviewsTool,
  type ParsedHunk,
  parseFilePatches,
  ResolveReviewThreadTool,
  type ReviewThread,
  type ReviewThreadComment,
} from "#app/mcp/reviewComments";
import type { ToolContext } from "#app/mcp/server";

// fixtures captured by action/scripts/refresh-test-fixtures.ts; re-run
// (with creds) when GitHub's review/threads/listFiles response shape
// changes, then review the snapshot diff.
type ReviewFixture = FormatReviewDataInput & {
  owner: string;
  name: string;
};

function loadFixture(file: string): ReviewFixture {
  return JSON.parse(
    readFileSync(resolve(import.meta.dirname, "__fixtures__", file), "utf-8"),
  ) as ReviewFixture;
}

describe("formatReviewData", () => {
  it("formats thread blocks with TOC and correct line numbers", () => {
    const fx = loadFixture("terramend-scratch-pr-49-review-3485940013.json");
    const result = formatReviewData(fx);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.formatted.toc).toMatchSnapshot("toc");
    expect(result.formatted.content).toMatchSnapshot("content");
  });

  it("formats body-only review", () => {
    const fx = loadFixture("terramend-scratch-pr-64-review-3531000326.json");
    const result = formatReviewData(fx);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.formatted.toc).toMatchSnapshot("toc");
    expect(result.formatted.content).toMatchSnapshot("content");
  });

  it("returns undefined when the review has no threads and no body", () => {
    expect(
      formatReviewData({
        review: { body: "", user: { login: "x" } },
        threads: [],
        prFiles: [],
        pullNumber: 1,
        reviewId: 2,
      }),
    ).toBeUndefined();
  });

  it("strips an existing terramend footer from the review body", () => {
    const result = formatReviewData({
      review: {
        body: "Real feedback.\n\n<!-- TERRAMEND_DIVIDER_DO_NOT_REMOVE_PLZ -->\n<sup>via Terramend</sup>",
        user: null,
      },
      threads: [],
      prFiles: [],
      pullNumber: 1,
      reviewId: 2,
    });
    expect(result).toBeDefined();
    expect(result?.reviewer).toBe("unknown");
    expect(result?.formatted.content).toContain("Real feedback.");
    expect(result?.formatted.content).not.toContain("via Terramend");
  });
});

describe("countLines", () => {
  it("counts newline-separated lines (1 for an empty string)", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\n")).toBe(2);
  });
});

describe("parseFilePatches", () => {
  it("splits a multi-hunk patch, defaulting omitted counts to 1", () => {
    const patch = ["@@ -1,3 +1,3 @@", " a", "-b", "+B", "@@ -10 +10 @@", "-x", "+X"].join("\n");
    const hunks = parseFilePatches(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 3 });
    expect(hunks[0]?.content).toEqual([" a", "-b", "+B"]);
    expect(hunks[1]).toMatchObject({ oldStart: 10, oldCount: 1, newStart: 10, newCount: 1 });
  });

  it("returns nothing for a patch with no hunk headers", () => {
    expect(parseFilePatches("just text\nno hunks")).toEqual([]);
  });
});

// --- buildThreadBlocks / formatReviewThreads (constructed threads) ----------

const TARGET_REVIEW_ID = 777;

function comment(over: Partial<ReviewThreadComment> = {}): ReviewThreadComment {
  return {
    fullDatabaseId: "12345",
    body: "please fix this",
    bodyHTML: "<p>please fix this</p>",
    createdAt: "2026-06-10T00:00:00Z",
    diffHunk: ["@@ -10,2 +10,3 @@", " ctx", "-old", "+new", "+new2"].join("\n"),
    line: 12,
    startLine: null,
    originalLine: 12,
    originalStartLine: null,
    author: { login: "reviewer" },
    pullRequestReview: { databaseId: TARGET_REVIEW_ID, author: { login: "reviewer" } },
    reactionGroups: null,
    ...over,
  };
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "T_1",
    path: "src/foo.ts",
    line: 12,
    startLine: null,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    comments: { nodes: [comment()] },
    ...over,
  };
}

describe("buildThreadBlocks", () => {
  const emptyPatches = new Map<string, ParsedHunk[]>();

  it("renders a thread header, the conversation, and the diff context", () => {
    const patches = new Map([["src/foo.ts", parseFilePatches(comment().diffHunk)]]);
    const blocks = buildThreadBlocks([thread()], patches, TARGET_REVIEW_ID);
    expect(blocks).toHaveLength(1);
    const content = blocks[0]?.content.join("\n") ?? "";
    expect(blocks[0]).toMatchObject({ path: "src/foo.ts", lineRange: "12" });
    expect(content).toContain("## src/foo.ts:12");
    // the * marker tags comments belonging to the target review.
    expect(content).toMatch(/comment author=reviewer id=12345 review=777 thread=T_1 \*/);
    expect(content).toContain("please fix this");
    expect(content).toContain("```diff file=src/foo.ts lines=12 side=RIGHT");
    expect(content).toContain("+new2");
  });

  it("marks resolved and outdated threads in the header", () => {
    const resolved = buildThreadBlocks([thread({ isResolved: true })], emptyPatches, 1);
    expect(resolved[0]?.content[0]).toContain("[RESOLVED]");
    const outdated = buildThreadBlocks([thread({ isOutdated: true })], emptyPatches, 1);
    expect(outdated[0]?.content[0]).toContain("[OUTDATED]");
  });

  it("skips threads with no comments and sorts by path then line", () => {
    const blocks = buildThreadBlocks(
      [
        thread({ id: "T_b", path: "b.ts", line: 3 }),
        thread({ id: "T_empty", comments: { nodes: [] } }),
        thread({ id: "T_a2", path: "a.ts", line: 9 }),
        thread({ id: "T_a1", path: "a.ts", line: 2 }),
      ],
      emptyPatches,
      1,
    );
    expect(blocks.map((b) => [b.path, b.lineRange])).toEqual([
      ["a.ts", "2"],
      ["a.ts", "9"],
      ["b.ts", "3"],
    ]);
  });

  it("falls back to the comment's diffHunk when the file is not in the PR patches", () => {
    const blocks = buildThreadBlocks([thread()], emptyPatches, 1);
    const content = blocks[0]?.content.join("\n") ?? "";
    expect(content).toContain("+new");
    expect(content).not.toContain("no diff context available");
  });

  it("notes missing diff context when neither patches nor a diffHunk exist", () => {
    const t = thread({ comments: { nodes: [comment({ diffHunk: "" })] } });
    const blocks = buildThreadBlocks([t], emptyPatches, 1);
    expect(blocks[0]?.content.join("\n")).toContain(
      "(no diff context available - comment on unchanged lines)",
    );
  });

  it("renders a multi-line range and a multi-hunk overlap with a gap indicator", () => {
    const filePatch = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+B",
      " c",
      "@@ -10,3 +10,3 @@",
      " x",
      "-y",
      "+Y",
      " z",
    ].join("\n");
    const patches = new Map([["src/foo.ts", parseFilePatches(filePatch)]]);
    const t = thread({ startLine: 2, line: 11 });
    const blocks = buildThreadBlocks([t], patches, 1);
    expect(blocks[0]?.lineRange).toBe("2-11");
    const content = blocks[0]?.content.join("\n") ?? "";
    expect(content).toContain("@@ -1,3 +1,3 @@");
    expect(content).toContain("@@ -10,3 +10,3 @@");
    expect(content).toContain("... (6 unchanged lines) ...");
  });

  it("falls back to the first comment's anchors when the thread carries none", () => {
    const t = thread({
      line: null,
      startLine: null,
      comments: { nodes: [comment({ line: null, originalLine: 7 })] },
    });
    const blocks = buildThreadBlocks([t], new Map(), 1);
    expect(blocks[0]?.lineRange).toBe("7");
  });

  it("labels a missing author and comment body", () => {
    const t = thread({
      comments: { nodes: [comment({ author: null, body: "", fullDatabaseId: null })] },
    });
    const content = buildThreadBlocks([t], new Map(), 1)[0]?.content.join("\n") ?? "";
    expect(content).toContain("author=unknown");
    expect(content).toContain("id=unknown");
    expect(content).toContain("(no comment body)");
  });
});

// --- the MCP tools (fake octokit, no network) --------------------------------

type RawResult = Record<string, unknown>;
function runTool(
  toolDef: { execute: unknown },
  params: Record<string, unknown>,
): Promise<RawResult> {
  const fn = toolDef.execute as (p: Record<string, unknown>) => Promise<RawResult>;
  return fn(params);
}

function makeCtx(over: Record<string, unknown> = {}): ToolContext {
  return {
    repo: { owner: "octo", name: "repo" },
    payload: { event: { trigger: "manual" } },
    octokit: {},
    tmpdir: "",
    githubInstallationToken: "tok",
    toolState: {},
    ...over,
  } as unknown as ToolContext;
}

describe("GetReviewCommentsTool", () => {
  const savedTempDir = process.env.TERRAMEND_TEMP_DIR;
  const scratchDirs: string[] = [];

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "terramend-review-"));
    scratchDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    if (savedTempDir === undefined) delete process.env.TERRAMEND_TEMP_DIR;
    else process.env.TERRAMEND_TEMP_DIR = savedTempDir;
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const graphqlResponse = (threads: ReviewThread[]) => ({
    repository: { pullRequest: { reviewThreads: { nodes: threads } } },
  });

  const octokitFor = (threads: ReviewThread[], reviewBody = "Overall summary.") => ({
    graphql: vi.fn().mockResolvedValue(graphqlResponse(threads)),
    paginate: vi.fn().mockResolvedValue([{ filename: "src/foo.ts", patch: comment().diffHunk }]),
    rest: {
      pulls: {
        getReview: vi.fn().mockResolvedValue({
          data: { body: reviewBody, user: { login: "reviewer" } },
        }),
        listFiles: vi.fn(),
      },
    },
  });

  it("writes the formatted threads to TERRAMEND_TEMP_DIR and returns the TOC", async () => {
    process.env.TERRAMEND_TEMP_DIR = scratch();
    const ctx = makeCtx({ octokit: octokitFor([thread()]) });

    const result = await runTool(GetReviewCommentsTool(ctx), {
      pull_number: 5,
      review_id: TARGET_REVIEW_ID,
    });

    expect(result).toMatchObject({
      review_id: TARGET_REVIEW_ID,
      pull_number: 5,
      reviewer: "reviewer",
      threadCount: 1,
    });
    const commentsPath = String(result.commentsPath);
    expect(commentsPath).toBe(
      join(process.env.TERRAMEND_TEMP_DIR ?? "", `review-${TARGET_REVIEW_ID}-threads.md`),
    );
    const written = readFileSync(commentsPath, "utf8");
    expect(written).toContain("## src/foo.ts:12");
    expect(written).toContain("## Review Body");
    expect(result.toc).toContain("src/foo.ts:12");
  });

  it("drops threads that belong to a different review", async () => {
    process.env.TERRAMEND_TEMP_DIR = scratch();
    const foreign = thread({
      comments: {
        nodes: [comment({ pullRequestReview: { databaseId: 1, author: { login: "x" } } })],
      },
    });
    const ctx = makeCtx({ octokit: octokitFor([foreign], "") });

    const result = await runTool(GetReviewCommentsTool(ctx), {
      pull_number: 5,
      review_id: TARGET_REVIEW_ID,
    });

    expect(result).toMatchObject({ threadCount: 0, commentsPath: null, toc: null });
    expect(result.instructions).toMatch(/no threads found/);
  });

  it("keeps only 👍-approved threads on a fix_review run with approved_only", async () => {
    process.env.TERRAMEND_TEMP_DIR = scratch();
    const approved = thread({
      id: "T_approved",
      path: "approved.ts",
      comments: {
        nodes: [
          comment({
            reactionGroups: [
              { content: "THUMBS_UP", reactors: { nodes: [{ login: "Alice" }] } },
              { content: "ROCKET", reactors: { nodes: [{ login: "bob" }] } },
            ],
          }),
        ],
      },
    });
    const unapproved = thread({
      id: "T_plain",
      path: "plain.ts",
      comments: {
        nodes: [
          comment({
            reactionGroups: [{ content: "THUMBS_UP", reactors: { nodes: [{ login: "bob" }] } }],
          }),
        ],
      },
    });
    const ctx = makeCtx({
      payload: { event: { trigger: "fix_review", approved_only: true }, triggerer: "alice" },
      octokit: octokitFor([approved, unapproved]),
    });

    const result = await runTool(GetReviewCommentsTool(ctx), {
      pull_number: 5,
      review_id: TARGET_REVIEW_ID,
    });

    expect(result.threadCount).toBe(1);
    expect(result.toc).toContain("approved.ts");
    expect(result.toc).not.toContain("plain.ts");
  });

  it("reports the 👍 filter when nothing matches", async () => {
    process.env.TERRAMEND_TEMP_DIR = scratch();
    const ctx = makeCtx({
      payload: { event: { trigger: "fix_review", approved_only: true }, triggerer: "alice" },
      octokit: octokitFor([thread()], ""),
    });

    const result = await runTool(GetReviewCommentsTool(ctx), {
      pull_number: 5,
      review_id: TARGET_REVIEW_ID,
    });

    expect(result.threadCount).toBe(0);
    expect(result.instructions).toMatch(/no threads with 👍 from alice/);
  });
});

describe("ListPullRequestReviewsTool", () => {
  it("lists reviews with their resolved bodies and metadata", async () => {
    const ctx = makeCtx({
      octokit: {
        paginate: vi.fn().mockResolvedValue([
          {
            id: 1,
            node_id: "N1",
            body: "Looks good.",
            state: "APPROVED",
            user: { login: "alice" },
            submitted_at: "2026-06-10T00:00:00Z",
            commit_id: "abc",
            html_url: "https://github.test/r/1",
          },
        ]),
        rest: { pulls: { listReviews: vi.fn() } },
      },
      tmpdir: "/tmp",
    });

    const result = await runTool(ListPullRequestReviewsTool(ctx), { pull_number: 9 });

    expect(result).toMatchObject({ pull_number: 9, count: 1 });
    expect(result.reviews).toEqual([
      expect.objectContaining({ id: 1, node_id: "N1", body: "Looks good.", state: "APPROVED" }),
    ]);
  });
});

describe("ResolveReviewThreadTool", () => {
  it("resolves a thread via the GraphQL mutation", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue({ resolveReviewThread: { thread: { id: "T_1", isResolved: true } } });
    const ctx = makeCtx({ octokit: { graphql } });

    const result = await runTool(ResolveReviewThreadTool(ctx), { thread_id: "T_1" });

    expect(result).toMatchObject({ success: true, thread_id: "T_1", is_resolved: true });
  });

  it("treats an already-resolved thread as success", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Thread is already resolved"));
    const ctx = makeCtx({ octokit: { graphql } });

    const result = await runTool(ResolveReviewThreadTool(ctx), { thread_id: "T_1" });

    expect(result).toMatchObject({ success: true, is_resolved: true });
    expect(result.message).toMatch(/already resolved/);
  });

  it("reports a failure without throwing for other errors", async () => {
    const graphql = vi.fn().mockRejectedValue(new Error("Resource not accessible"));
    const ctx = makeCtx({ octokit: { graphql } });

    const result = await runTool(ResolveReviewThreadTool(ctx), { thread_id: "T_9" });

    expect(result).toMatchObject({ success: false, is_resolved: false });
    expect(result.message).toMatch(/failed to resolve thread T_9/);
  });
});

describe("formatReviewThreads", () => {
  it("omits the TOC for a body-only review and includes the review body", () => {
    const { toc, content } = formatReviewThreads([], {
      pullNumber: 9,
      reviewId: 11,
      reviewer: "alice",
      reviewBody: "Overall LGTM with nits.",
    });
    expect(toc).toBe("");
    expect(content).toContain("# Review Threads (0) for PR #9 - Review 11 by alice");
    expect(content).not.toContain("## TOC");
    expect(content).toContain("## Review Body");
    expect(content).toContain("Overall LGTM with nits.");
  });

  it("computes TOC line numbers that point at each block's actual position", () => {
    const blocks = [
      { path: "a.ts", lineRange: "1", content: ["## a.ts:1", "", "body a"] },
      { path: "b.ts", lineRange: "2", content: ["## b.ts:2", "", "body b", ""] },
    ];
    const { toc, content } = formatReviewThreads(blocks, {
      pullNumber: 1,
      reviewId: 2,
      reviewer: "r",
    });
    const lines = content.split("\n");
    const entries = toc.split("\n");
    expect(entries).toEqual(["- a.ts:1 → lines 10-12", "- b.ts:2 → lines 13-16"]);
    // line numbers are 1-based: lines[9] is line 10.
    expect(lines[9]).toBe("## a.ts:1");
    expect(lines[12]).toBe("## b.ts:2");
  });
});
