import { describe, expect, it } from "vitest";
import { TERRAMEND_DIVIDER } from "#app/utils/buildTerramendFooter";
import {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "#app/utils/leapingComment";

describe("isLeapingIntoActionCommentBody", () => {
  it("matches the bare prefix", () => {
    expect(isLeapingIntoActionCommentBody("Leaping into action")).toBe(true);
  });

  it("matches the prefix with trailing ellipsis", () => {
    expect(isLeapingIntoActionCommentBody("Leaping into action...")).toBe(true);
  });

  it("matches when preceded by other words on the first line", () => {
    expect(isLeapingIntoActionCommentBody("🦎 Leaping into action...")).toBe(true);
  });

  it("ignores the terramend footer when matching", () => {
    const body = `Leaping into action...\n\n${TERRAMEND_DIVIDER}\n<sup>via Terramend</sup>`;
    expect(isLeapingIntoActionCommentBody(body)).toBe(true);
  });

  it("ignores leading whitespace and trailing spaces on the first line", () => {
    expect(isLeapingIntoActionCommentBody("\n  Leaping into action  \nmore")).toBe(true);
  });

  it("rejects bodies whose first line continues past the prefix", () => {
    expect(isLeapingIntoActionCommentBody("Leaping into action on PR #4")).toBe(false);
  });

  it("rejects bodies where the prefix appears mid-word", () => {
    expect(isLeapingIntoActionCommentBody("notLeaping into action")).toBe(false);
  });

  it("rejects real progress content", () => {
    expect(isLeapingIntoActionCommentBody("Reviewed 4 files; found 2 issues")).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(isLeapingIntoActionCommentBody("")).toBe(false);
  });

  it("only inspects the first content line", () => {
    expect(isLeapingIntoActionCommentBody(`real update\n${LEAPING_INTO_ACTION_PREFIX}`)).toBe(
      false,
    );
  });
});
