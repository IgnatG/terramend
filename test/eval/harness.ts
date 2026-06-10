/**
 * Detection-quality eval harness (migration plan Phase 2 — see
 * CLAUDE-CODE-SECURITY-REVIEW-VS-TERRAMEND.md §8 at the workspace root).
 *
 * Answers one question deterministically: "did this change add or lose
 * findings against a known-defect target, compared to a committed baseline?"
 * Modeled on claude-code-security-review's evals/ (clone → run → record), with
 * the upgrade that target Concern ids are content hashes, so the baseline is
 * exact ground truth rather than a manually-judged findings count.
 *
 * Two deliberate robustness choices:
 *   - Findings are compared on `source|rule_id|file` (multiset), NOT on the
 *     full content id: the id hashes the line number, so an unrelated edit
 *     that shifts a defect by one line would otherwise read as one finding
 *     lost + one gained. Line and id still travel in the records for humans.
 *   - Scanners are compared only when they ran in BOTH the baseline capture
 *     and the current run. A scanner installed on one host but not the other
 *     (e.g. trivy on CI, absent on a dev box) is surfaced as `uncovered` /
 *     `skipped` instead of polluting the drift report — same degrade-green
 *     stance as the scanners themselves.
 */

import { runScanners } from "#app/mcp/terraform/scanners";
import { type Concern, dedupe, sortConcerns } from "#app/mcp/terraform/types";

/** One captured finding — a Concern minus remediation_hint, which is doc-link
 * noise in a baseline and churns with scanner versions. */
export interface EvalFinding {
  source: Concern["source"];
  rule_id: string;
  file: string;
  line: number | null;
  severity: Concern["severity"];
  /** scanner message at capture time. Recorded for readability, never compared. */
  evidence: string;
  /** full content id (sha1(source|rule_id|file|line), 12 chars). */
  id: string;
}

export interface EvalCapture {
  findings: EvalFinding[];
  /** scanner sources that actually ran. */
  ran: string[];
  /** scanners that did not run, with the reason (not installed, parse failure). */
  skipped: Array<{ source: string; reason: string }>;
  runtimeMs: number;
}

/** The committed ground-truth file for one target. */
export interface EvalBaseline {
  /** repo-relative target dir the baseline was captured from (informational). */
  target: string;
  /** scanner sources that ran at capture time — the comparison scope. */
  scanners: string[];
  findings: EvalFinding[];
}

export interface EvalReport {
  target: string;
  /** scanners compared (ran in both baseline and current run). */
  compared: string[];
  /** ran now but absent from the baseline — their findings are NOT judged;
   * re-capture the baseline on a host with these installed to cover them. */
  uncovered: string[];
  /** in the baseline but skipped in this run — their baseline findings are
   * NOT judged as missing; install the scanner to restore coverage. */
  skipped: Array<{ source: string; reason: string }>;
  /** baseline findings re-detected this run (key-level match). */
  matched: EvalFinding[];
  /** baseline findings NOT detected this run — detection regressions. */
  missing: EvalFinding[];
  /** current findings absent from the baseline — new detections (an
   * improvement to fold into the baseline, or scanner-version drift). */
  unexpected: EvalFinding[];
  runtimeMs: number;
}

/** Run the full deterministic scanner toolchain over `cwd` and flatten to the
 * same deduped, sorted concern set `terraform_scan` reports. */
export function captureFindings(cwd: string): EvalCapture {
  const startedAt = Date.now();
  const outcomes = runScanners(cwd);
  const findings = sortConcerns(dedupe(outcomes.flatMap((o) => o.concerns))).map<EvalFinding>(
    (c) => ({
      source: c.source,
      rule_id: c.rule_id,
      file: c.location.file,
      line: c.location.line,
      severity: c.severity,
      evidence: c.evidence,
      id: c.id,
    }),
  );
  return {
    findings,
    ran: outcomes.filter((o) => o.ran).map((o) => o.source),
    skipped: outcomes
      .filter((o) => !o.ran)
      .map((o) => ({ source: o.source, reason: o.skipped_reason ?? "unknown" })),
    runtimeMs: Date.now() - startedAt,
  };
}

/** Line-insensitive comparison key — see the module note on why line/id are
 * excluded from matching. */
export function findingKey(f: EvalFinding): string {
  return `${f.source}|${f.rule_id}|${f.file}`;
}

/** Pure diff of a capture against the committed baseline. Multiset semantics
 * per key: a rule firing twice in one file at capture time must fire twice now
 * to fully match — the surplus side is reported as missing/unexpected. */
export function diffFindings(baseline: EvalBaseline, current: EvalCapture): EvalReport {
  const comparable = new Set(baseline.scanners.filter((s) => current.ran.includes(s)));
  const uncovered = current.ran.filter((s) => !baseline.scanners.includes(s));

  const byKey = (findings: EvalFinding[]): Map<string, EvalFinding[]> => {
    const map = new Map<string, EvalFinding[]>();
    for (const f of findings) {
      if (!comparable.has(f.source)) continue;
      const key = findingKey(f);
      const bucket = map.get(key);
      if (bucket) bucket.push(f);
      else map.set(key, [f]);
    }
    return map;
  };

  const baselineByKey = byKey(baseline.findings);
  const currentByKey = byKey(current.findings);

  const matched: EvalFinding[] = [];
  const missing: EvalFinding[] = [];
  const unexpected: EvalFinding[] = [];

  for (const [key, expected] of baselineByKey) {
    const got = currentByKey.get(key) ?? [];
    matched.push(...expected.slice(0, got.length));
    missing.push(...expected.slice(got.length));
    unexpected.push(...got.slice(expected.length));
  }
  for (const [key, got] of currentByKey) {
    if (!baselineByKey.has(key)) unexpected.push(...got);
  }

  return {
    target: baseline.target,
    compared: [...comparable].sort(),
    uncovered: uncovered.sort(),
    skipped: current.skipped,
    matched,
    missing,
    unexpected,
    runtimeMs: current.runtimeMs,
  };
}
