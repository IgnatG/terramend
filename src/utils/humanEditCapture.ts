/**
 * §6.20 Human-edit capture — the data flywheel.
 *
 * When a human edits or rejects a Terramend remediation PR, the delta between
 * what Terramend originally committed and what was actually merged is the single
 * most valuable training/eval signal we can collect: it tells us exactly where a
 * fix was wrong, over-reaching, or stylistically off. This module computes that
 * delta as a structured record AND persists it (when a backend is configured).
 *
 * SCOPE / SEAM: the pure record-building (`computeHumanEditDelta`,
 * `deriveRemediationOutcome`) lives here and is unit-tested. PERSISTENCE
 * (`persistHumanEditRecord`) mirrors the `learnings` seam: it POSTs the record
 * to the open-core backend ONLY when `API_URL` is set — a standalone BYOK run
 * has nowhere to persist, so it no-ops cleanly instead of POSTing into the
 * marketing host. The remaining external dependency is the `pull_request`
 * `closed`/`merged` EVENT that triggers a capture run; that event wiring is the
 * hosted product's (it dispatches the action on PR-close). `captureRemediationOutcome`
 * is the single entry point an event handler calls: build → persist.
 */
import { apiFetch } from "#app/utils/apiFetch";
import { isBackendConfigured } from "#app/utils/apiUrl";
import { log } from "#app/utils/cli";

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
    (o.outcome === "merged_with_edits" &&
      (humanAddedLines.length > 0 || removedFromOriginal.length > 0));

  return {
    concernIds: o.concernIds,
    outcome: o.outcome,
    humanIntervened,
    humanAddedLines,
    removedFromOriginal,
  };
}

/**
 * Derive the PR outcome from the raw close event: an unmerged close is
 * `rejected`; a merge whose final added-lines differ from Terramend's original
 * is `merged_with_edits`; an identical merge is `merged_clean`. Pure — the same
 * added-line comparison `computeHumanEditDelta` uses, lifted so a caller can
 * classify the event before (or without) building the full delta.
 */
export function deriveRemediationOutcome(
  merged: boolean,
  originalFixDiff: string,
  mergedDiff: string,
): RemediationOutcome["outcome"] {
  if (!merged) return "rejected";
  const original = addedLines(originalFixDiff);
  const mergedSet = new Set(addedLines(mergedDiff));
  const originalSet = new Set(original);
  const addedByHuman = addedLines(mergedDiff).some((l) => !originalSet.has(l));
  const removedTerramend = original.some((l) => !mergedSet.has(l));
  return addedByHuman || removedTerramend ? "merged_with_edits" : "merged_clean";
}

/** the input an event handler hands to `captureRemediationOutcome`: the closed
 * remediation PR plus the two diffs needed to compute the human-edit delta. */
export interface RemediationPrClose {
  prNumber: number;
  /** whether the PR was merged (vs closed unmerged → rejected). */
  merged: boolean;
  /** the concern id(s) the original Terramend PR targeted. */
  concernIds: string[];
  /** Terramend's original committed patch (unified diff of its first commit). */
  originalFixDiff: string;
  /** the patch that was actually merged (HEAD of the PR at merge). */
  mergedDiff: string;
}

/**
 * Persist a built human-edit record to the open-core backend. Best-effort and
 * dormant by default: with no `API_URL` (standalone BYOK) there's nowhere to
 * persist, so it no-ops and reports `{ persisted: false, reason }` rather than
 * POSTing into the marketing host. Mirrors `persistLearnings`. Any network
 * failure is logged, never thrown — capture must never fail a run.
 */
export async function persistHumanEditRecord(params: {
  repo: { owner: string; name: string };
  apiToken: string;
  prNumber: number;
  record: HumanEditRecord;
}): Promise<{ persisted: boolean; reason?: string }> {
  if (!isBackendConfigured()) {
    log.debug("no backend configured (API_URL unset) — skipping human-edit capture persist");
    return { persisted: false, reason: "no_backend" };
  }
  try {
    const response = await apiFetch({
      path: `/api/repo/${params.repo.owner}/${params.repo.name}/remediation-outcomes`,
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ pr_number: params.prNumber, ...params.record }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "(no body)");
      log.warning(`human-edit capture persist failed (${response.status}): ${error}`);
      return { persisted: false, reason: `http_${response.status}` };
    }
    log.info(`» human-edit record captured for PR #${params.prNumber} (${params.record.outcome})`);
    return { persisted: true };
  } catch (err) {
    log.warning(
      `human-edit capture persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { persisted: false, reason: "error" };
  }
}

/**
 * The single entry point for §6.20 capture: classify the close event, build the
 * structured delta, and persist it (no-op without a backend). Returns the record
 * and whether it was persisted, so the caller can log/surface it. Pure parts are
 * separately testable (`deriveRemediationOutcome` / `computeHumanEditDelta`);
 * this just composes them with the dormant persistence seam.
 */
export async function captureRemediationOutcome(params: {
  repo: { owner: string; name: string };
  apiToken: string;
  event: RemediationPrClose;
}): Promise<{ record: HumanEditRecord; persisted: boolean; reason?: string }> {
  const outcome = deriveRemediationOutcome(
    params.event.merged,
    params.event.originalFixDiff,
    params.event.mergedDiff,
  );
  const record = computeHumanEditDelta({
    concernIds: params.event.concernIds,
    originalFixDiff: params.event.originalFixDiff,
    mergedDiff: params.event.mergedDiff,
    outcome,
  });
  const result = await persistHumanEditRecord({
    repo: params.repo,
    apiToken: params.apiToken,
    prNumber: params.event.prNumber,
    record,
  });
  return { record, ...result };
}
