/**
 * CLI for the detection-quality eval (migration plan Phase 2). Runs the full
 * deterministic scanner toolchain over a known-defect target and diffs the
 * findings against a committed baseline, so "did this change add or lose
 * findings?" is one command instead of a judgment call.
 *
 *   pnpm eval:scan                                  # fixtures/terraform-bad vs its baseline
 *   pnpm eval:scan -- --target path/to/dir          # any dir (e.g. a PR worktree)
 *   pnpm eval:scan -- --pr owner/repo#123           # fetch a real PR's head and scan it
 *   pnpm eval:scan -- --write-baseline              # capture/refresh the baseline
 *
 * Exit codes: 0 = no drift, 1 = drift (missing or unexpected findings),
 * 2 = configuration error (bad target, no baseline). Reports are written to
 * test/eval/results/<target>.json (gitignored); baselines live in
 * test/eval/baselines/ and are committed — they ARE the ground truth.
 *
 * Scanner availability is part of the contract: findings are only judged for
 * scanners that ran in BOTH the baseline capture and this run. Capture
 * baselines on a host with the full toolchain (terraform, tflint, trivy,
 * checkov) for full coverage; a partial host still evaluates the scanners it
 * has and reports the rest as uncovered/skipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log } from "#app/utils/cli";
import { captureFindings, diffFindings, type EvalBaseline, type EvalFinding } from "./harness.ts";
import { fetchPrHead, parsePrRef } from "./prFetch.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "fixtures/terraform-bad" },
    pr: { type: "string" },
    baseline: { type: "string" },
    "write-baseline": { type: "boolean", default: false },
    out: { type: "string", default: "test/eval/results" },
  },
});

// --pr takes precedence over --target: fetch the PR head into a worktree and
// scan that. The baseline/report name keys on repo + PR number.
let targetRel: string;
let targetAbs: string;
if (values.pr) {
  const ref = parsePrRef(values.pr);
  if (!ref) {
    log.error(`invalid --pr "${values.pr}" — expected owner/repo#123`);
    process.exit(2);
  }
  const evalTempDir = join(repoRoot, ".temp", "eval");
  mkdirSync(evalTempDir, { recursive: true });
  log.info(`» fetching ${ref.owner}/${ref.repo}#${ref.number} head ...`);
  targetAbs = fetchPrHead(ref, evalTempDir);
  targetRel = `${ref.repo}-pr${ref.number}`;
} else {
  targetRel = values.target.replace(/\\/g, "/").replace(/\/+$/, "");
  targetAbs = resolve(repoRoot, targetRel);
}
const baselinePath = values.baseline
  ? resolve(repoRoot, values.baseline)
  : join(repoRoot, "test", "eval", "baselines", `${basename(targetRel)}.json`);

if (!existsSync(targetAbs)) {
  log.error(`target does not exist: ${targetAbs}`);
  process.exit(2);
}

log.info(`» scanning ${targetRel} ...`);
const capture = captureFindings(targetAbs);
log.info(
  `» ${capture.findings.length} finding(s) from [${capture.ran.join(", ")}] in ${capture.runtimeMs}ms`,
);
for (const s of capture.skipped) {
  log.info(`» scanner skipped: ${s.source} — ${s.reason}`);
}

if (values["write-baseline"]) {
  const baseline: EvalBaseline = {
    target: targetRel,
    scanners: capture.ran,
    findings: capture.findings,
  };
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  log.success(`baseline written: ${baselinePath} (${capture.findings.length} findings)`);
  if (capture.skipped.length > 0) {
    log.info(
      `» NOTE: baseline covers [${capture.ran.join(", ")}] only — re-capture on a host with ` +
        `[${capture.skipped.map((s) => s.source).join(", ")}] installed for full coverage.`,
    );
  }
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  log.error(
    `no baseline at ${baselinePath} — run with --write-baseline first to capture ground truth.`,
  );
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as EvalBaseline;
const report = diffFindings(baseline, capture);

const reportPath = join(repoRoot, values.out, `${basename(targetRel)}.json`);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const fmt = (f: EvalFinding): string =>
  `[${f.severity}] ${f.rule_id} @ ${f.file}${f.line === null ? "" : `:${f.line}`}`;

log.info(`» compared scanners: [${report.compared.join(", ")}]`);
if (report.uncovered.length > 0) {
  log.info(
    `» uncovered (ran now, absent from baseline — re-capture to cover): [${report.uncovered.join(", ")}]`,
  );
}
log.info(`» matched ${report.matched.length}/${report.matched.length + report.missing.length}`);
for (const f of report.missing) {
  log.error(`MISSING (detection regression): ${fmt(f)}`);
}
for (const f of report.unexpected) {
  log.info(`» UNEXPECTED (new detection or scanner drift): ${fmt(f)}`);
}
log.info(`» report: ${reportPath}`);

if (report.missing.length > 0 || report.unexpected.length > 0) {
  log.error(
    `drift: ${report.missing.length} missing, ${report.unexpected.length} unexpected — ` +
      `if intentional (e.g. a new rule now fires), refresh with --write-baseline and commit.`,
  );
  process.exit(1);
}
log.success("no drift — detection surface matches the baseline.");
process.exit(0);
