/**
 * §26 "propose, then let me steer" eval runner (the model-behavioural piece the
 * roadmap left open). Drives a full Remediate-mode agent run against a sandbox
 * repo for each scenario in the suite, then inspects GitHub for what the agent
 * did — posted an A/B/C proposal and waited, or just opened a fix PR — and scores
 * it against the scenario's expectation. Like the review eval there is NO hard
 * pass/fail baseline (LLM output is nondeterministic); the value is the accuracy
 * trend across runs of the same suite as the prompt evolves.
 *
 *   pnpm eval:propose                                   # run the whole suite
 *   pnpm eval:propose -- --scenario missing-tags        # one scenario
 *   pnpm eval:propose -- --repo owner/sandbox --model anthropic/claude-sonnet-4-6
 *
 * Sandbox requirement: the target repo must carry one branch per scenario `ref`
 * (see PROPOSE_SCENARIOS in proposeScoring.ts) whose HIGHEST-severity Terraform
 * concern has the shape described in that scenario's `note`. Remediate acts on the
 * top concern, so the branch's top concern is what decides propose-vs-fix.
 *
 * Requirements (SPENDS LLM tokens and WRITES to the sandbox repo — point it only
 * at a sandbox you own):
 *   - GITHUB_TOKEN / GH_TOKEN with write access (or `gh auth login`).
 *   - a model provider key in the env / .env, or none to ride the free fallback.
 *
 * Exit codes: 0 = the suite ran (see the accuracy in the output / results file),
 * 1 = an agent run failed, 2 = configuration error.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { log } from "#app/utils/cli";
import {
  detectProposalSignals,
  PROPOSE_SCENARIOS,
  type ProposeResult,
  type ProposeScenario,
  scoreScenario,
  summarizeProposeRun,
} from "./proposeScoring.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: "terramend/test-repo" },
    model: { type: "string" },
    timeout: { type: "string", default: "20m" },
    scenario: { type: "string" },
  },
});

if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
  log.error(`invalid --repo "${values.repo}" — expected owner/repo`);
  process.exit(2);
}

const scenarios: ProposeScenario[] = values.scenario
  ? PROPOSE_SCENARIOS.filter((s) => s.name === values.scenario)
  : [...PROPOSE_SCENARIOS];
if (scenarios.length === 0) {
  log.error(
    `no scenario named "${values.scenario}" (have: ${PROPOSE_SCENARIOS.map((s) => s.name).join(", ")})`,
  );
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

interface GhComment {
  id: number;
  body: string;
}
interface GhIssue {
  number: number;
  body: string | null;
  pull_request?: unknown;
}
interface GhPull {
  number: number;
  head: { ref: string };
}

/** A point-in-time view of the writable artifacts a Remediate run could create. */
interface Snapshot {
  commentIds: Set<number>;
  commentBodies: Map<number, string>;
  issueNumbers: Set<number>;
  issueBodies: Map<number, string>;
  prNumbers: Set<number>;
  prHeadRefs: Map<number, string>;
}

async function snapshot(): Promise<Snapshot> {
  const [comments, issues, pulls] = await Promise.all([
    gh<GhComment[]>(
      `/repos/${values.repo}/issues/comments?per_page=100&sort=created&direction=desc`,
    ),
    gh<GhIssue[]>(`/repos/${values.repo}/issues?state=all&per_page=100`),
    gh<GhPull[]>(`/repos/${values.repo}/pulls?state=all&per_page=100`),
  ]);
  // the issues endpoint returns PRs too — exclude them; PRs are tracked separately.
  const realIssues = issues.filter((i) => i.pull_request === undefined);
  return {
    commentIds: new Set(comments.map((c) => c.id)),
    commentBodies: new Map(comments.map((c) => [c.id, c.body ?? ""])),
    issueNumbers: new Set(realIssues.map((i) => i.number)),
    issueBodies: new Map(realIssues.map((i) => [i.number, i.body ?? ""])),
    prNumbers: new Set(pulls.map((p) => p.number)),
    prHeadRefs: new Map(pulls.map((p) => [p.number, p.head.ref])),
  };
}

/** Run dev-run.ts with a Remediate fixture pinned to one scenario branch. */
function runRemediateAgent(
  scenario: ProposeScenario,
): Promise<{ success: boolean; runtimeMs: number }> {
  const fixture = {
    prompt: "Remediate the Terraform on this branch — open one scoped PR for the top concern.",
    mode: "Remediate",
    timeout: values.timeout,
    ...(values.model ? { model: values.model } : {}),
  };
  const startedAt = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["dev-run.ts", "--raw", JSON.stringify(fixture)], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: values.repo,
        // pin the checkout to the scenario branch (the sandbox carries one per ref).
        GITHUB_REF: `refs/heads/${scenario.ref}`,
        GITHUB_REF_NAME: scenario.ref,
      },
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

/** Diff two snapshots into the bodies/refs created between them. */
function newArtifacts(before: Snapshot, after: Snapshot) {
  const newCommentBodies = [...after.commentBodies]
    .filter(([id]) => !before.commentIds.has(id))
    .map(([, body]) => body);
  const newIssueBodies = [...after.issueBodies]
    .filter(([n]) => !before.issueNumbers.has(n))
    .map(([, body]) => body);
  const newPrHeadRefs = [...after.prHeadRefs]
    .filter(([n]) => !before.prNumbers.has(n))
    .map(([, ref]) => ref);
  return { newCommentBodies, newIssueBodies, newPrHeadRefs };
}

const results: ProposeResult[] = [];
let runtimeMs = 0;

for (const scenario of scenarios) {
  log.info(
    `» [${scenario.name}] expecting "${scenario.expected}" on ${values.repo}@${scenario.ref}`,
  );
  const before = await snapshot();
  const run = await runRemediateAgent(scenario);
  runtimeMs += run.runtimeMs;
  if (!run.success) {
    log.error(`[${scenario.name}] agent run failed — see output above`);
    process.exit(1);
  }
  const after = await snapshot();
  const signals = detectProposalSignals(newArtifacts(before, after));
  const result = scoreScenario(scenario, signals);
  results.push(result);
  log.info(
    `» [${scenario.name}] observed "${result.observed}" → ${result.correct ? "✅ correct" : "❌ wrong"} ` +
      `(proposal=${signals.proposalComment} options=${signals.strategiesOffered} pr=${signals.prOpened})`,
  );
}

const summary = summarizeProposeRun(results);
const metrics = {
  repo: values.repo,
  model: values.model ?? null,
  timeout: values.timeout,
  runtimeMs,
  summary,
  results,
};

const outDir = join(repoRoot, "test", "eval", "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `propose-${values.repo.replace("/", "-")}-${stamp}.json`);
writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`);

log.info(
  `» accuracy ${summary.correct}/${summary.total} (${Math.round(summary.accuracy * 100)}%) — ` +
    `propose ${summary.proposeCorrect}/${summary.proposeExpected}, fix ${summary.fixCorrect}/${summary.fixExpected}`,
);
log.success(`metrics written: ${outPath}`);
process.exit(0);
