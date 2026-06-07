/**
 * §6.20 Human-edit capture — the data flywheel.
 *
 * When a human edits or rejects a Terramend remediation PR, the delta between
 * what Terramend originally committed and what was actually merged is the single
 * most valuable training/eval signal we can collect: it tells us exactly where a
 * fix was wrong, over-reaching, or stylistically off. This module computes that
 * delta as a structured record.
 *
 * SCOPE / SEAM: the pure record-building lives here and is unit-tested. The two
 * pieces it depends on are deliberately left to the (currently dormant) open-core
 * backend, because they need infrastructure a standalone BYOK run doesn't have:
 *   1. the `pull_request` `closed`/`merged` EVENT to trigger capture, and
 *   2. PERSISTENCE of the record into the eval dataset (`evals/`) via the
 *      `learnings` / `prSummary` seams (only active when `API_URL` is set).
 * A BYOK user opts in; the hosted product turns it on by default. Until the
 * backend is wired, this builds the record and the caller no-ops on persistence.
 */

export interface RemediationOutcome {
  /** the concern id(s) the original Terramend PR targeted. */
  concernIds: string[];
  /** Terramend's original committed patch (unified diff of its commit). */
  originalFixDiff: string;
  /** the patch that was actually merged (HEAD of the PR at merge), unified diff. */
  mergedDiff: string;
  /** how the PR ended. */
  outcome: "merged_clean" | "merged_with_edits" | "rejected";
}

export interface HumanEditRecord {
  concernIds: string[];
  outcome: RemediationOutcome["outcome"];
  /** true when the human changed Terramend's fix before merging (or rejected). */
  humanIntervened: boolean;
  /** the lines the human ADDED on top of / instead of Terramend's fix. */
  humanAddedLines: string[];
  /** the lines from Terramend's original fix the human REMOVED/replaced. */
  removedFromOriginal: string[];
}

/** added (`+`, not `+++`) content lines of a unified diff, sans the leading `+`. */
function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/**
 * Build the structured human-edit record from a finished remediation PR. Pure:
 * the caller supplies Terramend's original diff and the merged diff; this diffs
 * the two added-line sets to isolate what the human changed. `rejected` (PR
 * closed unmerged) is always an intervention; `merged_clean` never is; for a
 * merge, intervention is inferred from whether the merged added-lines differ
 * from Terramend's.
 */
export function computeHumanEditDelta(o: RemediationOutcome): HumanEditRecord {
  const original = addedLines(o.originalFixDiff);
  const merged = addedLines(o.mergedDiff);
  const originalSet = new Set(original);
  const mergedSet = new Set(merged);

  const humanAddedLines = merged.filter((l) => !originalSet.has(l));
  const removedFromOriginal = original.filter((l) => !mergedSet.has(l));

  const humanIntervened =
    o.outcome === "rejected" ||
    (o.outcome === "merged_with_edits" && (humanAddedLines.length > 0 || removedFromOriginal.length > 0));

  return {
    concernIds: o.concernIds,
    outcome: o.outcome,
    humanIntervened,
    humanAddedLines,
    removedFromOriginal,
  };
}
