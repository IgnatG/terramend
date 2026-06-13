import { describe, expect, it } from "vitest";
import { STRATEGY_REPLY_HINT } from "#app/utils/remediationCommand";
import {
  classifyProposeBehavior,
  countStrategyOptions,
  detectProposalSignals,
  PROPOSAL_MARKER,
  PROPOSE_SCENARIOS,
  type ProposeScenario,
  type ProposeSignals,
  scoreScenario,
  summarizeProposeRun,
} from "./proposeScoring.ts";

describe("PROPOSAL_MARKER", () => {
  it("is a substring of the canonical reply hint (drift guard)", () => {
    // if STRATEGY_REPLY_HINT ever changes, this fails loudly so the detector
    // stays tied to the single source of truth for the §26 reply syntax.
    expect(STRATEGY_REPLY_HINT.toLowerCase()).toContain(PROPOSAL_MARKER);
  });
});

describe("countStrategyOptions", () => {
  it("counts list-style A/B/C lead-ins", () => {
    const body = [
      "Pick one:",
      "A) AWS-managed key",
      "B) customer-managed KMS key",
      "C) no encryption",
    ].join("\n");
    expect(countStrategyOptions(body)).toBe(3);
  });

  it("counts bold and dotted/colon variants", () => {
    expect(countStrategyOptions("**A** — narrow CIDR\n**B** — prefix list")).toBe(2);
    expect(countStrategyOptions("- A. one\n- B: two")).toBe(2);
  });

  it("does not miscount prose that merely starts with a capital letter", () => {
    expect(
      countStrategyOptions("A bucket policy is missing.\nBecause of that, access is open."),
    ).toBe(0);
  });

  it("de-duplicates a letter mentioned twice", () => {
    expect(countStrategyOptions("A) first\nA) repeated")).toBe(1);
  });
});

describe("detectProposalSignals", () => {
  const hint = STRATEGY_REPLY_HINT;

  it("flags a proposal from a new comment carrying the reply hint", () => {
    const s = detectProposalSignals({
      newCommentBodies: [`Two options:\nA) SSE-S3\nB) KMS\nReply ${hint}`],
      newIssueBodies: [],
      newPrHeadRefs: [],
    });
    expect(s).toEqual<ProposeSignals>({
      proposalComment: true,
      strategiesOffered: 2,
      prOpened: false,
    });
  });

  it("flags a fix from a new remediate/* PR head ref", () => {
    const s = detectProposalSignals({
      newCommentBodies: [],
      newIssueBodies: [],
      newPrHeadRefs: ["remediate/main-tf", "some-other-branch"],
    });
    expect(s).toEqual<ProposeSignals>({
      proposalComment: false,
      strategiesOffered: 0,
      prOpened: true,
    });
  });

  it("ignores a comment without the strategy marker", () => {
    const s = detectProposalSignals({
      newCommentBodies: ["Just an FYI comment, no choice asked."],
      newIssueBodies: [],
      newPrHeadRefs: [],
    });
    expect(s.proposalComment).toBe(false);
  });
});

describe("classifyProposeBehavior", () => {
  it("'proposed' needs a real fork (>=2 options) and no PR", () => {
    expect(
      classifyProposeBehavior({ proposalComment: true, strategiesOffered: 2, prOpened: false }),
    ).toBe("proposed");
  });

  it("a one-option 'proposal' is not a fork — falls through to neither", () => {
    expect(
      classifyProposeBehavior({ proposalComment: true, strategiesOffered: 1, prOpened: false }),
    ).toBe("neither");
  });

  it("'fixed' is a PR with no fork proposal", () => {
    expect(
      classifyProposeBehavior({ proposalComment: false, strategiesOffered: 0, prOpened: true }),
    ).toBe("fixed");
  });

  it("proposing AND opening a PR is 'both' (defeats the point of asking)", () => {
    expect(
      classifyProposeBehavior({ proposalComment: true, strategiesOffered: 3, prOpened: true }),
    ).toBe("both");
  });

  it("doing nothing is 'neither'", () => {
    expect(
      classifyProposeBehavior({ proposalComment: false, strategiesOffered: 0, prOpened: false }),
    ).toBe("neither");
  });
});

describe("scoreScenario", () => {
  const propose: ProposeScenario = { name: "p", ref: "r", expected: "propose", note: "" };
  const fix: ProposeScenario = { name: "f", ref: "r", expected: "fix", note: "" };

  it("propose→proposed is correct; propose→fixed is wrong", () => {
    expect(
      scoreScenario(propose, { proposalComment: true, strategiesOffered: 2, prOpened: false })
        .correct,
    ).toBe(true);
    expect(
      scoreScenario(propose, { proposalComment: false, strategiesOffered: 0, prOpened: true })
        .correct,
    ).toBe(false);
  });

  it("fix→fixed is correct; fix→proposed (a stall) is wrong", () => {
    expect(
      scoreScenario(fix, { proposalComment: false, strategiesOffered: 0, prOpened: true }).correct,
    ).toBe(true);
    expect(
      scoreScenario(fix, { proposalComment: true, strategiesOffered: 3, prOpened: false }).correct,
    ).toBe(false);
  });

  it("'both' is wrong for a propose scenario (premature PR)", () => {
    const r = scoreScenario(propose, {
      proposalComment: true,
      strategiesOffered: 2,
      prOpened: true,
    });
    expect(r.observed).toBe("both");
    expect(r.correct).toBe(false);
  });
});

describe("summarizeProposeRun", () => {
  it("aggregates accuracy and per-expectation recall", () => {
    const summary = summarizeProposeRun([
      scoreScenario(
        { name: "a", ref: "r", expected: "propose", note: "" },
        { proposalComment: true, strategiesOffered: 2, prOpened: false },
      ),
      scoreScenario(
        { name: "b", ref: "r", expected: "fix", note: "" },
        { proposalComment: false, strategiesOffered: 0, prOpened: true },
      ),
      scoreScenario(
        { name: "c", ref: "r", expected: "fix", note: "" },
        { proposalComment: true, strategiesOffered: 2, prOpened: false }, // stalled — wrong
      ),
    ]);
    expect(summary).toEqual({
      total: 3,
      correct: 2,
      accuracy: 2 / 3,
      proposeExpected: 1,
      proposeCorrect: 1,
      fixExpected: 2,
      fixCorrect: 1,
    });
  });

  it("is vacuously 100% on an empty run", () => {
    expect(summarizeProposeRun([]).accuracy).toBe(1);
  });
});

describe("PROPOSE_SCENARIOS suite", () => {
  it("covers both expectations with unique names + refs", () => {
    expect(PROPOSE_SCENARIOS.some((s) => s.expected === "propose")).toBe(true);
    expect(PROPOSE_SCENARIOS.some((s) => s.expected === "fix")).toBe(true);
    expect(new Set(PROPOSE_SCENARIOS.map((s) => s.name)).size).toBe(PROPOSE_SCENARIOS.length);
    expect(new Set(PROPOSE_SCENARIOS.map((s) => s.ref)).size).toBe(PROPOSE_SCENARIOS.length);
  });
});
