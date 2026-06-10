import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countLines,
  countLinesInRanges,
  createDiffCoverageState,
  getDiffCoverageBreakdown,
  parseDiffTocEntries,
  recordDiffReadFromToolUse,
  renderDiffCoverageBreakdown,
} from "#app/utils/diffCoverage";

const diffPath = "/tmp/pr-1.diff";
const toc = `## Files (2)
- src/a.ts → lines 5-10
- yarn.lock → lines 12-20

---
`;

describe("diff coverage line checker", () => {
  it("treats Read offsets as zero based", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      toc,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        filePath: diffPath,
        offset: 0,
        limit: 3,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it("treats ReadFile offsets as one based", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      toc,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "ReadFile",
      input: {
        path: diffPath,
        offset: 1,
        limit: 2,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it("supports negative offsets from file end", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      toc,
    });

    const tracked = recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        offset: -2,
        limit: 2,
      },
      cwd: "/",
    });

    expect(tracked).toBe(true);
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveredRanges).toEqual([{ startLine: 29, endLine: 30 }]);
  });

  it("parses TOC lines that include the ` · diff-<sha256>` anchor emitted by checkout_pr", () => {
    const productionToc = `## Files (2)
- src/format.ts → lines 9-32 · diff-41c7b3ac268a3a1ae5c7be92f1230f600013b7170e44a693570ccbdb183ea36b
- test/math.test.ts → lines 81-93 · diff-44b3f515a5c787743d239052db11d740d691e8bef711c2427bb2b9752a4103a9

---
`;
    const entries = parseDiffTocEntries({ toc: productionToc });
    expect(entries).toEqual([
      { filename: "src/format.ts", startLine: 9, endLine: 32 },
      { filename: "test/math.test.ts", startLine: 81, endLine: 93 },
    ]);
  });

  it("carries forward coveragePreflightRan from a previous state across checkout refreshes", () => {
    const previous = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    previous.coveragePreflightRan = true;
    previous.coveredRanges = [{ startLine: 5, endLine: 10 }];

    const next = createDiffCoverageState({ diffPath, totalLines: 50, toc, previous });

    expect(next.coveragePreflightRan).toBe(true);
    // coveredRanges are tied to the previous diff content and must not leak forward
    expect(next.coveredRanges).toEqual([]);
    expect(next.totalLines).toBe(50);
  });

  it("defaults coveragePreflightRan to false when no previous state is provided", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    expect(state.coveragePreflightRan).toBe(false);
  });

  it("computes per-file unread ranges from tracked reads", () => {
    const state = createDiffCoverageState({
      diffPath,
      totalLines: 30,
      toc,
    });

    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        start_line: 5,
        end_line: 6,
      },
      cwd: "/",
    });

    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: {
        path: diffPath,
        start_line: 12,
        end_line: 14,
      },
      cwd: "/",
    });

    const breakdown = getDiffCoverageBreakdown({ state });
    const [firstFile, secondFile] = breakdown.files;

    expect(firstFile?.filename).toBe("src/a.ts");
    expect(firstFile?.coveredRanges).toEqual([{ startLine: 5, endLine: 6 }]);
    expect(firstFile?.unreadRanges).toEqual([{ startLine: 7, endLine: 10 }]);

    expect(secondFile?.filename).toBe("yarn.lock");
    expect(secondFile?.coveredRanges).toEqual([{ startLine: 12, endLine: 14 }]);
    expect(secondFile?.unreadRanges).toEqual([{ startLine: 15, endLine: 20 }]);
  });

  it("counts lines including a trailing empty segment, and zero for empty content", () => {
    expect(countLines({ content: "" })).toBe(0);
    expect(countLines({ content: "one" })).toBe(1);
    expect(countLines({ content: "one\ntwo\n" })).toBe(3);
  });

  it("sums lines across ranges", () => {
    expect(countLinesInRanges({ ranges: [] })).toBe(0);
    expect(
      countLinesInRanges({
        ranges: [
          { startLine: 1, endLine: 3 },
          { startLine: 10, endLine: 10 },
        ],
      }),
    ).toBe(4);
  });

  it("ignores tool uses when no state exists or the tool is not a read", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    const input = { path: diffPath };

    expect(recordDiffReadFromToolUse({ state: undefined, toolName: "Read", input, cwd: "/" })).toBe(
      false,
    );
    expect(recordDiffReadFromToolUse({ state, toolName: "Grep", input, cwd: "/" })).toBe(false);
    expect(recordDiffReadFromToolUse({ state, toolName: "Readme", input, cwd: "/" })).toBe(false);
    expect(state.coveredRanges).toEqual([]);
  });

  it("accepts namespaced read tool names", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "mcp.fs.Read",
        input: { path: diffPath },
        cwd: "/",
      }),
    ).toBe(true);
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "fs.ReadFile",
        input: { path: diffPath },
        cwd: "/",
      }),
    ).toBe(true);
  });

  it("ignores reads of other files and malformed inputs", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });

    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { path: "/tmp/other.diff" },
        cwd: "/",
      }),
    ).toBe(false);
    expect(recordDiffReadFromToolUse({ state, toolName: "Read", input: null, cwd: "/" })).toBe(
      false,
    );
    expect(recordDiffReadFromToolUse({ state, toolName: "Read", input: ["array"], cwd: "/" })).toBe(
      false,
    );
    expect(
      recordDiffReadFromToolUse({ state, toolName: "Read", input: { limit: 3 }, cwd: "/" }),
    ).toBe(false);
    expect(
      recordDiffReadFromToolUse({ state, toolName: "Read", input: { path: 42 }, cwd: "/" }),
    ).toBe(false);
    // nested wrapper present but carrying no path
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { args: { offset: 1 } },
        cwd: "/",
      }),
    ).toBe(false);
  });

  it("resolves relative read paths against cwd", () => {
    // anchor on the real cwd so the drive-letter resolution on Windows
    // matches what `resolve` produces for the relative path
    const cwd = process.cwd();
    const state = createDiffCoverageState({
      diffPath: join(cwd, "pr-1.diff"),
      totalLines: 10,
      toc: "",
    });
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { file_path: "pr-1.diff" },
        cwd,
      }),
    ).toBe(true);
    expect(state.coveredRanges).toEqual([{ startLine: 1, endLine: 10 }]);
  });

  it("extracts read targets from nested args/params/input wrappers", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });

    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { args: { filepath: diffPath, offset: "4", limit: "2" } },
        cwd: "/",
      }),
    ).toBe(true);
    expect(state.coveredRanges).toEqual([{ startLine: 5, endLine: 6 }]);

    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { params: { target_file: diffPath, line_start: 20, line_end: 21 } },
        cwd: "/",
      }),
    ).toBe(true);
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { input: { file: diffPath, startLine: 25, endLine: 26 } },
        cwd: "/",
      }),
    ).toBe(true);
    expect(state.coveredRanges).toEqual([
      { startLine: 5, endLine: 6 },
      { startLine: 20, endLine: 21 },
      { startLine: 25, endLine: 26 },
    ]);
  });

  it("rejects unusable ranges: zero-line files, non-positive limits, inverted bounds", () => {
    const empty = createDiffCoverageState({ diffPath, totalLines: 0, toc: "" });
    expect(
      recordDiffReadFromToolUse({
        state: empty,
        toolName: "Read",
        input: { path: diffPath },
        cwd: "/",
      }),
    ).toBe(false);

    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { path: diffPath, limit: 0 },
        cwd: "/",
      }),
    ).toBe(false);
    expect(
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { path: diffPath, start_line: 9, end_line: 4 },
        cwd: "/",
      }),
    ).toBe(false);
    expect(state.coveredRanges).toEqual([]);
  });

  it("clamps start/end lines and offsets to the file bounds", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: { path: diffPath, start_line: -5, end_line: 99 },
      cwd: "/",
    });
    expect(state.coveredRanges).toEqual([{ startLine: 1, endLine: 30 }]);

    const offsetState = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    recordDiffReadFromToolUse({
      state: offsetState,
      toolName: "Read",
      input: { path: diffPath, offset: 28, limit: 50 },
      cwd: "/",
    });
    expect(offsetState.coveredRanges).toEqual([{ startLine: 29, endLine: 30 }]);
  });

  it("defaults missing start/end bounds and ignores unparseable numeric strings", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    // only end_line: start defaults to 1
    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: { path: diffPath, end_line: 3 },
      cwd: "/",
    });
    expect(state.coveredRanges).toEqual([{ startLine: 1, endLine: 3 }]);

    // only start_line: end defaults to the last line
    const tail = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    recordDiffReadFromToolUse({
      state: tail,
      toolName: "Read",
      input: { path: diffPath, start_line: 28 },
      cwd: "/",
    });
    expect(tail.coveredRanges).toEqual([{ startLine: 28, endLine: 30 }]);

    // a non-numeric offset string is dropped → whole-file read
    const garbage = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    recordDiffReadFromToolUse({
      state: garbage,
      toolName: "Read",
      input: { path: diffPath, offset: "not-a-number" },
      cwd: "/",
    });
    expect(garbage.coveredRanges).toEqual([{ startLine: 1, endLine: 30 }]);
  });

  it("treats a zero ReadFile offset as line one", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    recordDiffReadFromToolUse({
      state,
      toolName: "ReadFile",
      input: { path: diffPath, offset: 0, limit: 2 },
      cwd: "/",
    });
    expect(state.coveredRanges).toEqual([{ startLine: 1, endLine: 2 }]);
  });

  it("merges adjacent and overlapping covered ranges", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    for (const [start, end] of [
      [5, 8],
      [9, 12],
      [7, 10],
      [20, 22],
    ]) {
      recordDiffReadFromToolUse({
        state,
        toolName: "Read",
        input: { path: diffPath, start_line: start, end_line: end },
        cwd: "/",
      });
    }
    expect(state.coveredRanges).toEqual([
      { startLine: 5, endLine: 12 },
      { startLine: 20, endLine: 22 },
    ]);
  });

  it("reports 100% coverage for an empty diff", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 0, toc: "" });
    const breakdown = getDiffCoverageBreakdown({ state });
    expect(breakdown.coveragePercent).toBe(100);
    expect(breakdown.unreadRanges).toEqual([]);
    expect(breakdown.coveredLines).toBe(0);
  });

  it("skips TOC lines that do not match the entry shape", () => {
    expect(parseDiffTocEntries({ toc: "## Files\nrandom\n- broken → lines x-y\n" })).toEqual([]);
  });

  it("renders the human-readable breakdown including none-markers and per-file percents", () => {
    const state = createDiffCoverageState({ diffPath, totalLines: 30, toc });
    const unread = renderDiffCoverageBreakdown({
      diffPath,
      breakdown: getDiffCoverageBreakdown({ state }),
    });
    expect(unread).toContain(`diff coverage report for \`${diffPath}\``);
    expect(unread).toContain("overall: 0/30 lines read (0%), unread: 30");
    expect(unread).toContain("covered ranges: none");
    expect(unread).toContain("unread ranges: 1-30");
    expect(unread).toContain("- src/a.ts (toc lines 5-10): 0/6 lines read (0%)");

    recordDiffReadFromToolUse({
      state,
      toolName: "Read",
      input: { path: diffPath, start_line: 5, end_line: 10 },
      cwd: "/",
    });
    const partial = renderDiffCoverageBreakdown({
      diffPath,
      breakdown: getDiffCoverageBreakdown({ state }),
    });
    expect(partial).toContain("overall: 6/30 lines read (20%), unread: 24");
    expect(partial).toContain("- src/a.ts (toc lines 5-10): 6/6 lines read (100%)");
    expect(partial).toContain("  read: 5-10");
    expect(partial).toContain("  unread: none");
  });

  it("renders 100% for zero-length TOC file entries", () => {
    const zeroToc = "- empty.ts → lines 5-4\n";
    const state = createDiffCoverageState({ diffPath, totalLines: 10, toc: zeroToc });
    const rendered = renderDiffCoverageBreakdown({
      diffPath,
      breakdown: getDiffCoverageBreakdown({ state }),
    });
    expect(rendered).toContain("- empty.ts (toc lines 5-4): 0/0 lines read (100%)");
  });
});
