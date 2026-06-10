/**
 * LLM review-quality eval (migration plan Phase 2b). Runs a full Review-mode
 * agent run against a PR in a sandbox repo (default `terramend/test-repo`),
 * then pulls the submitted review back from GitHub and records quality
 * metrics, so the effect of a prompt/precedent change is measurable across
 * runs instead of eyeballed:
 *
 *   pnpm eval:review -- --pr 7                       # review test-repo PR #7
 *   pnpm eval:review -- --pr 7 --repo owner/repo     # another sandbox repo
 *   pnpm eval:review -- --pr 7 --model anthropic/claude-sonnet-4-6
 *
 * Metrics captured per run (JSON in test/eval/results/): inline comment
 * count, severity-emoji counts (🚨/⚠️/ℹ️) across body + comments, suppressed
 * findings count (the Phase 1 audit-trail block), review state, runtime.
 * There is deliberately NO pass/fail baseline — LLM output is nondeterministic,
 * so the value is the metric trend across runs of the same PR, not an exact
 * match. Compare result files by hand or in a notebook.
 *
 * Requirements (this SPENDS LLM tokens and POSTS a review to the target PR —
 * only point it at a sandbox repo you own):
 *   - GITHUB_TOKEN / GH_TOKEN with write access to the target repo (or
 *     `gh auth login` — dev-run resolves the gh CLI token).
 *   - a model provider key in the environment / .env, or none to ride the
 *     free-model fallback.
 *
 * Exit codes: 0 = run completed and a terramend review was found,
 * 1 = agent run failed or no review landed, 2 = configuration error.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log } from "#app/utils/cli";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({
  options: {
    pr: { type: "string" },
    repo: { type: "string", default: "terramend/test-repo" },
    model: { type: "string" },
    timeout: { type: "string", default: "20m" },
  },
});

const prNumber = Number.parseInt(values.pr ?? "", 10);
if (!Number.isInteger(prNumber) || prNumber <= 0) {
  log.error("--pr <number> is required (a PR in the sandbox repo)");
  process.exit(2);
}
if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
  log.error(`invalid --repo "${values.repo}" — expected owner/repo`);
  process.exit(2);
}

function githubToken(): string | null {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

const token = githubToken();
if (!token) {
  log.error("no GitHub token (set GITHUB_TOKEN/GH_TOKEN or `gh auth login`)");
  process.exit(2);
}

async function gh<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
  return (await response.json()) as T;
}

interface GhReview {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string;
  submitted_at?: string;
}

const isTerramendLogin = (login: string | undefined): boolean =>
  !!login && /^terramend(dev)?(\[bot\])?$/.test(login);

/** Run dev-run.ts with a pinned Review fixture, streaming its output. */
function runReviewAgent(): Promise<{ success: boolean; runtimeMs: number }> {
  const fixture = {
    prompt: `Review pull request #${prNumber}.`,
    mode: "Review",
    timeout: values.timeout,
    ...(values.model ? { model: values.model } : {}),
  };
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["dev-run.ts", "--raw", JSON.stringify(fixture)], {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_REPOSITORY: values.repo },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      log.error(`spawn failed: ${err.message}`);
      resolvePromise({ success: false, runtimeMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      resolvePromise({ success: code === 0, runtimeMs: Date.now() - startedAt });
    });
  });
}

const countMatches = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

log.info(`» reviewing ${values.repo}#${prNumber} (timeout ${values.timeout}) ...`);
const reviewsBefore = await gh<GhReview[]>(
  `/repos/${values.repo}/pulls/${prNumber}/reviews?per_page=100`,
);
const knownReviewIds = new Set(reviewsBefore.map((r) => r.id));

const run = await runReviewAgent();
if (!run.success) {
  log.error("agent run failed — see output above");
  process.exit(1);
}

const reviewsAfter = await gh<GhReview[]>(
  `/repos/${values.repo}/pulls/${prNumber}/reviews?per_page=100`,
);
const review = reviewsAfter
  .filter((r) => !knownReviewIds.has(r.id) && isTerramendLogin(r.user?.login))
  .at(-1);
if (!review) {
  log.error(
    "run completed but no new terramend review landed on the PR — Review mode must submit exactly one",
  );
  process.exit(1);
}

const comments = await gh<Array<{ body: string }>>(
  `/repos/${values.repo}/pulls/${prNumber}/reviews/${review.id}/comments?per_page=100`,
);

const allText = [review.body, ...comments.map((c) => c.body)].join("\n");
const suppressedMatch = /<summary>🗑️ Suppressed findings \((\d+)\)<\/summary>/.exec(review.body);

const metrics = {
  repo: values.repo,
  pr: prNumber,
  reviewId: review.id,
  reviewState: review.state,
  submittedAt: review.submitted_at ?? null,
  model: values.model ?? null,
  runtimeMs: run.runtimeMs,
  inlineComments: comments.length,
  bodyLength: review.body.length,
  severityCounts: {
    critical: countMatches(allText, /🚨/g),
    important: countMatches(allText, /⚠️/g),
    informational: countMatches(allText, /ℹ️/g),
  },
  suppressedFindings: suppressedMatch ? Number.parseInt(suppressedMatch[1] as string, 10) : 0,
  hasSuppressedBlock: suppressedMatch !== null,
};

const outDir = join(repoRoot, "test", "eval", "results");
mkdirSync(outDir, { recursive: true });
const outPath = join(
  outDir,
  `review-${values.repo.replace("/", "-")}-pr${prNumber}-${review.id}.json`,
);
writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`);

log.info(`» review ${review.id} (${review.state}): ${comments.length} inline comment(s)`);
log.info(
  `» severity marks: 🚨${metrics.severityCounts.critical} ⚠️${metrics.severityCounts.important} ℹ️${metrics.severityCounts.informational} · suppressed: ${metrics.suppressedFindings}`,
);
log.success(`metrics written: ${outPath}`);
process.exit(0);
