import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureRemediationOutcome,
  computeHumanEditDelta,
  deriveRemediationOutcome,
} from "#app/utils/humanEditCapture";

describe("computeHumanEditDelta (§6.20)", () => {
  const diff = (...added: string[]) =>
    ["+++ b/main.tf", "@@ -0,0 +1 @@", ...added.map((l) => `+${l}`)].join("\n");

  it("flags no intervention when the merged diff matches Terramend's fix", () => {
    const r = computeHumanEditDelta({
      concernIds: ["a"],
      originalFixDiff: diff("  encrypted = true"),
      mergedDiff: diff("  encrypted = true"),
      outcome: "merged_clean",
    });
    expect(r.humanIntervened).toBe(false);
    expect(r.humanAddedLines).toEqual([]);
    expect(r.removedFromOriginal).toEqual([]);
  });

  it("captures lines the human added and removed when merged with edits", () => {
    const r = computeHumanEditDelta({
      concernIds: ["a"],
      originalFixDiff: diff("  encrypted = true"),
      mergedDiff: diff("  encrypted   = true", "  kms_key_id = aws_kms_key.this.arn"),
      outcome: "merged_with_edits",
    });
    expect(r.humanIntervened).toBe(true);
    expect(r.humanAddedLines).toContain("  kms_key_id = aws_kms_key.this.arn");
    expect(r.removedFromOriginal).toContain("  encrypted = true");
  });

  it("always treats a rejected PR as an intervention", () => {
    const r = computeHumanEditDelta({
      concernIds: ["a"],
      originalFixDiff: diff("  encrypted = true"),
      mergedDiff: "",
      outcome: "rejected",
    });
    expect(r.humanIntervened).toBe(true);
  });
});

describe("deriveRemediationOutcome (§6.20)", () => {
  const diff = (...added: string[]) => added.map((l) => `+${l}`).join("\n");

  it("classifies an unmerged close as rejected", () => {
    expect(deriveRemediationOutcome(false, diff("x = 1"), "")).toBe("rejected");
  });

  it("classifies an identical merge as merged_clean", () => {
    expect(deriveRemediationOutcome(true, diff("x = 1"), diff("x = 1"))).toBe("merged_clean");
  });

  it("classifies a merge with added lines as merged_with_edits", () => {
    expect(deriveRemediationOutcome(true, diff("x = 1"), diff("x = 1", "y = 2"))).toBe("merged_with_edits");
  });

  it("classifies a merge that dropped a Terramend line as merged_with_edits", () => {
    expect(deriveRemediationOutcome(true, diff("x = 1", "y = 2"), diff("x = 1"))).toBe("merged_with_edits");
  });
});

describe("captureRemediationOutcome (§6.20 persistence seam)", () => {
  const prevApiUrl = process.env.API_URL;
  beforeEach(() => {
    delete process.env.API_URL;
  });
  afterEach(() => {
    if (prevApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = prevApiUrl;
  });

  it("builds the record and no-ops persistence when no backend is configured", async () => {
    const result = await captureRemediationOutcome({
      repo: { owner: "acme", name: "infra" },
      apiToken: "t",
      event: {
        prNumber: 42,
        merged: true,
        concernIds: ["c1"],
        originalFixDiff: "+x = 1",
        mergedDiff: "+x = 1\n+y = 2",
      },
    });
    expect(result.persisted).toBe(false);
    expect(result.reason).toBe("no_backend");
    // the record is still built (the pure part runs regardless of persistence).
    expect(result.record.outcome).toBe("merged_with_edits");
    expect(result.record.humanIntervened).toBe(true);
    expect(result.record.concernIds).toEqual(["c1"]);
  });
});
