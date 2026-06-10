import { describe, expect, it } from "vitest";
import {
  FINDING_VERIFICATION_PASS,
  FP_PRECEDENTS_ADDENDUM_HEADING,
  mergeReviewModeInstructions,
} from "#app/reviewQuality";

describe("mergeReviewModeInstructions", () => {
  it("returns the base untouched when neither input is set", () => {
    const base = { Review: "backend rules", Build: "build rules" };
    expect(mergeReviewModeInstructions(base, {})).toBe(base);
    expect(mergeReviewModeInstructions(base, { reviewInstructions: "  " })).toBe(base);
  });

  it("appends review instructions after backend-provided ones", () => {
    const merged = mergeReviewModeInstructions(
      { Review: "backend rules" },
      { reviewInstructions: "org policy" },
    );
    expect(merged.Review).toBe("backend rules\n\norg policy");
  });

  it("wraps FP instructions under the addendum heading the verification pass names", () => {
    const merged = mergeReviewModeInstructions(
      {},
      { fpFilteringInstructions: "TLS terminates at the ALB" },
    );
    expect(merged.Review).toContain(FP_PRECEDENTS_ADDENDUM_HEADING);
    expect(merged.Review).toContain("TLS terminates at the ALB");
    expect(merged.Review).toContain("verbatim in every verification dispatch");
  });

  it("keeps order: backend, review policy, then the FP addendum last", () => {
    const merged = mergeReviewModeInstructions(
      { Review: "backend" },
      { reviewInstructions: "policy", fpFilteringInstructions: "fp" },
    );
    const text = merged.Review ?? "";
    expect(text.indexOf("backend")).toBeLessThan(text.indexOf("policy"));
    expect(text.indexOf("policy")).toBeLessThan(text.indexOf(FP_PRECEDENTS_ADDENDUM_HEADING));
  });

  it("does not touch other modes", () => {
    const merged = mergeReviewModeInstructions(
      { Build: "build rules" },
      { reviewInstructions: "org policy" },
    );
    expect(merged.Build).toBe("build rules");
    expect(merged.Review).toBe("org policy");
  });
});

describe("addendum heading contract", () => {
  it("the verification pass names the exact heading the merge produces", () => {
    // FINDING_VERIFICATION_PASS instructs the orchestrator to include any
    // "Finding precedents — org addendum" section verbatim in dispatches; the
    // heading the merge emits must match that pointer or org FP rules never
    // reach the verification subagents.
    expect(FINDING_VERIFICATION_PASS).toContain(
      FP_PRECEDENTS_ADDENDUM_HEADING.replace(/^### /, ""),
    );
  });
});
