import { describe, expect, it } from "vitest";
import { parsePrRef } from "./prFetch.ts";

describe("parsePrRef", () => {
  it("parses owner/repo#number", () => {
    expect(parsePrRef("terramend/test-repo#7")).toEqual({
      owner: "terramend",
      repo: "test-repo",
      number: 7,
    });
    expect(parsePrRef("  hashicorp/terraform-provider-aws#12345 ")).toEqual({
      owner: "hashicorp",
      repo: "terraform-provider-aws",
      number: 12345,
    });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["", "repo#7", "owner/repo", "owner/repo#0", "owner/repo#abc", "a/b#7#8"]) {
      expect(parsePrRef(bad), bad).toBeNull();
    }
  });
});
