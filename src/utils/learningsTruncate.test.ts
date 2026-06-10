import { describe, expect, it } from "vitest";
import { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "#app/utils/learningsTruncate";

describe("truncateAtLineBoundary", () => {
  it("returns the body unchanged when within the cap", () => {
    expect(truncateAtLineBoundary("short body", 100)).toBe("short body");
    expect(truncateAtLineBoundary("exact", 5)).toBe("exact");
  });

  it("truncates at the last newline before the cap", () => {
    const body = "line one\nline two\nline three tail beyond";
    const result = truncateAtLineBoundary(body, 25);
    expect(result).toBe("line one\nline two");
  });

  it("hard-slices when the head contains no newline", () => {
    const body = "x".repeat(50);
    expect(truncateAtLineBoundary(body, 10)).toBe("x".repeat(10));
  });

  it("hard-slices when the head starts with a newline (lastNewline at 0)", () => {
    const body = `\n${"y".repeat(50)}`;
    expect(truncateAtLineBoundary(body, 10)).toBe(`\n${"y".repeat(9)}`);
  });

  it("hard-slices instead of discarding a giant trailing line", () => {
    // one short line, then a single line far longer than the 4096 tolerance
    const body = `header\n${"z".repeat(10_000)}`;
    const cap = 6000;
    const result = truncateAtLineBoundary(body, cap);
    // keeping only "header" would discard ~6KB; the hard slice is preferred
    expect(result).toHaveLength(cap);
    expect(result.startsWith("header\n")).toBe(true);
  });

  it("exports a six-figure cap for the learnings body", () => {
    expect(MAX_LEARNINGS_LENGTH).toBe(100_000);
  });
});
