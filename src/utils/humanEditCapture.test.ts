import { describe, expect, it } from "vitest";
import { computeHumanEditDelta } from "#app/utils/humanEditCapture";

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
