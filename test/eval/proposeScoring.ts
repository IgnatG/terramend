/**
 * §26 "propose, then let me steer" eval — the deterministic scoring core (pure).
 *
 * §26 is model-behavioural: when a concern has 2–3 genuinely distinct, defensible
 * fixes that differ in *trade-offs* (not correctness), Remediate should NOT
 * silently pick — it posts an A/B/C proposal and waits for the reviewer to choose
 * (`@terramend fix #<id> with strategy <A|B|C>`). When a concern has one obvious
 * correct fix, it should just fix it and open the PR. There's no single right
 * answer to grade against per token (LLM output is nondeterministic), so the eval
 * measures *how often the model proposes-when-it-should and fixes-when-it-should*
 * across a fixed scenario suite — the same trend-not-pass/fail stance as the
 * review eval.
 *
 * This module is the pure half: given the GitHub-observable signals from one
 * Remediate run, classify what the agent DID and score it against the scenario's
 * expectation. The runner ([propose.ts]) drives the agent + gathers the signals;
 * keeping the classification here makes it unit-testable without spending tokens.
 */

import { STRATEGY_REPLY_HINT } from "#app/utils/remediationCommand";

/** what §26 says the agent SHOULD do for a given concern shape. */
export type ProposeExpectation = "propose" | "fix";

/** what the agent was observed to do this run. */
export type ProposeBehavior = "proposed" | "fixed" | "both" | "neither";

/** the stable, prompt-independent substring that marks a §26 proposal asking the
 * reviewer to choose — taken from STRATEGY_REPLY_HINT (the single source of truth
 * for the reply syntax), so a change to the hint is caught by the unit test. */
export const PROPOSAL_MARKER = "with strategy";

/** GitHub-observable signals from one Remediate run (gathered by the runner). */
export interface ProposeSignals {
  /** a new comment OR issue offered labelled strategies and asked the human to
   * pick (its body contains the strategy-reply marker). */
  proposalComment: boolean;
  /** distinct strategy options (A/B/C…) the proposal offered. */
  strategiesOffered: number;
  /** a new `remediate/*` PR was opened this run. */
  prOpened: boolean;
}

/** one eval scenario: a sandbox state + the §26 behaviour it should elicit. */
export interface ProposeScenario {
  name: string;
  /** the sandbox branch whose HIGHEST-severity concern has the intended shape. */
  ref: string;
  /** what §26 says the agent should do for this concern. */
  expected: ProposeExpectation;
  /** why this concern is a genuine fork (or obviously a single fix). */
  note: string;
}

export interface ProposeResult {
  scenario: string;
  expected: ProposeExpectation;
  observed: ProposeBehavior;
  correct: boolean;
  signals: ProposeSignals;
}

/** Count distinct A–D option labels in a proposal body. Matches list-style
 * lead-ins only — `A)` / `A.` / `A:` / `**A**` at a line start (optionally after
 * a `-`/`*` bullet) — so prose that merely starts a sentence with "A " is not
 * miscounted as an option. */
export function countStrategyOptions(body: string): number {
  const seen = new Set<string>();
  const re = /(?:^|\n)[ \t]*(?:[-*]+[ \t]*)?(?:\*\*([A-D])\*\*|([A-D])[).:])/g;
  for (const match of body.matchAll(re)) {
    const letter = match[1] ?? match[2];
    if (letter) seen.add(letter.toUpperCase());
  }
  return seen.size;
}

/** Build the signals from the raw new GitHub artifacts of one run. Pure. A
 * proposal is a new comment/issue whose body carries the strategy-reply marker;
 * a fix is a new `remediate/*` PR head ref. */
export function detectProposalSignals(opts: {
  newCommentBodies: string[];
  newIssueBodies: string[];
  newPrHeadRefs: string[];
}): ProposeSignals {
  const proposals = [...opts.newCommentBodies, ...opts.newIssueBodies].filter((b) =>
    b.toLowerCase().includes(PROPOSAL_MARKER),
  );
  const strategiesOffered = proposals.reduce(
    (max, body) => Math.max(max, countStrategyOptions(body)),
    0,
  );
  return {
    proposalComment: proposals.length > 0,
    strategiesOffered,
    prOpened: opts.newPrHeadRefs.some((ref) => ref.startsWith("remediate/")),
  };
}

/** Classify what the agent did. A proposal only counts as one when it offered a
 * real fork (≥2 options) — a single "option" is just a fix narrated as a choice. */
export function classifyProposeBehavior(s: ProposeSignals): ProposeBehavior {
  const proposed = s.proposalComment && s.strategiesOffered >= 2;
  if (proposed && s.prOpened) return "both";
  if (proposed) return "proposed";
  if (s.prOpened) return "fixed";
  return "neither";
}

/** Score one scenario. `propose` is satisfied ONLY by "proposed" (offering the
 * fork AND not pre-empting it with a PR); `fix` ONLY by "fixed" (a PR, no
 * proposal stall). "both"/"neither" are always wrong. */
export function scoreScenario(scenario: ProposeScenario, signals: ProposeSignals): ProposeResult {
  const observed = classifyProposeBehavior(signals);
  const correct =
    (scenario.expected === "propose" && observed === "proposed") ||
    (scenario.expected === "fix" && observed === "fixed");
  return { scenario: scenario.name, expected: scenario.expected, observed, correct, signals };
}

export interface ProposeRunSummary {
  total: number;
  correct: number;
  /** fraction in [0, 1]; 1 when there are no results (vacuously). */
  accuracy: number;
  proposeExpected: number;
  proposeCorrect: number;
  fixExpected: number;
  fixCorrect: number;
}

/** Aggregate per-scenario results into the headline metrics the runner records. */
export function summarizeProposeRun(results: ProposeResult[]): ProposeRunSummary {
  const correct = results.filter((r) => r.correct).length;
  const propose = results.filter((r) => r.expected === "propose");
  const fix = results.filter((r) => r.expected === "fix");
  return {
    total: results.length,
    correct,
    accuracy: results.length === 0 ? 1 : correct / results.length,
    proposeExpected: propose.length,
    proposeCorrect: propose.filter((r) => r.correct).length,
    fixExpected: fix.length,
    fixCorrect: fix.filter((r) => r.correct).length,
  };
}

/**
 * The default scenario suite. The sandbox repo must carry a branch per `ref`
 * whose HIGHEST-severity concern has the shape described in `note` — that's the
 * concern Remediate acts on first. These are the seeds; extend as new genuine
 * fix-forks are identified. (Kept here, beside the scorer, so the suite is part
 * of the tested, reviewable surface rather than buried in the runner.)
 */
export const PROPOSE_SCENARIOS: readonly ProposeScenario[] = [
  {
    name: "s3-encryption-key-choice",
    ref: "eval/propose-s3-kms",
    expected: "propose",
    note: "Unencrypted S3 bucket — AWS-managed SSE-S3 vs a customer-managed KMS key is a genuine cost/control fork, not a correctness question. §26: offer A/B and wait.",
  },
  {
    name: "sg-open-ingress",
    ref: "eval/propose-sg-ingress",
    expected: "propose",
    note: "0.0.0.0/0 ingress — a narrow CIDR vs a prefix list vs a VPC endpoint are distinct defensible fixes. §26: propose, don't guess a CIDR (also a §29 refusal risk if guessed).",
  },
  {
    name: "missing-tags",
    ref: "eval/fix-missing-tags",
    expected: "fix",
    note: "Resources missing required tags — one obvious fix (add the tags). No fork: just fix and open the PR.",
  },
  {
    name: "unpinned-provider",
    ref: "eval/fix-unpinned-provider",
    expected: "fix",
    note: "Unpinned provider / missing required_version — pin to a current supported constraint. One correct answer: just fix.",
  },
] as const;

// Compile-time-ish guarantee that the marker really is part of the reply hint.
// (Also asserted at runtime in proposeScoring.test.ts so a drift fails CI.)
export const _hintContainsMarker = STRATEGY_REPLY_HINT.includes(PROPOSAL_MARKER);
