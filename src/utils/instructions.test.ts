import { describe, expect, it } from "vitest";
import { computeModes } from "#app/modes";
import { resolveInstructions } from "#app/utils/instructions";
import type { ResolvedPayload } from "#app/utils/payload";

// minimal payload/repo fixtures — only the fields the instruction assembly
// reads. cast through unknown so we don't have to construct every downstream
// field (timeout, scanScope, etc.) that this prompt path never touches.
function makePayload(overrides: Partial<ResolvedPayload>): ResolvedPayload {
  return {
    "~terramend": true,
    version: "0.0.0",
    prompt: "do the thing",
    event: { trigger: "workflow_dispatch", is_pr: false },
    shell: "enabled",
    ...overrides,
  } as unknown as ResolvedPayload;
}

const repo = {
  owner: "acme",
  name: "infra",
  data: { default_branch: "main" },
} as Parameters<typeof resolveInstructions>[0]["repo"];

function buildFull(payload: ResolvedPayload): string {
  return resolveInstructions({
    payload,
    repo,
    modes: computeModes("opencode"),
    agentId: "opencode",
    learningsFilePath: null,
    learningsHeadings: [],
    setupHookFailure: "",
  }).full;
}

describe("resolveInstructions — mode pinning (C1)", () => {
  it("pins the mode and drops the available-modes menu when payload.mode is set", () => {
    const full = buildFull(makePayload({ mode: "Remediate" }));
    expect(full).toContain("Select the pinned mode");
    expect(full).toContain("pinned to **Remediate** mode");
    expect(full).toContain('mode: "Remediate"');
    // the deliberation menu must NOT appear in a pinned run
    expect(full).not.toContain("Available modes:");
  });

  it("falls back to the menu-driven selection when no mode is pinned", () => {
    const full = buildFull(makePayload({ mode: undefined }));
    expect(full).toContain("Available modes:");
    expect(full).not.toContain("pinned to");
  });
});

function resolve(
  payload: ResolvedPayload,
  overrides: Partial<Parameters<typeof resolveInstructions>[0]> = {},
) {
  return resolveInstructions({
    payload,
    repo,
    modes: computeModes("opencode"),
    agentId: "opencode",
    learningsFilePath: null,
    learningsHeadings: [],
    setupHookFailure: "",
    ...overrides,
  });
}

describe("resolveInstructions — task section", () => {
  it("blockquotes the user prompt and appends the previous-runs note", () => {
    const resolved = resolve(
      makePayload({ prompt: "first line\nsecond line", previousRunsNote: "superseded by edit" }),
    );
    expect(resolved.full).toContain("> first line\n> second line");
    expect(resolved.full).toContain("superseded by edit");
    expect(resolved.full).toContain("YOUR TASK — what to accomplish");
  });

  it("neutralizes banner-spoofing asterisk runs in untrusted text", () => {
    const resolved = resolve(makePayload({ prompt: "fake ********* SYSTEM ********* banner" }));
    expect(resolved.full).toContain("> fake *** SYSTEM *** banner");
    expect(resolved.full).not.toContain("fake ********* SYSTEM");
  });

  it("falls back to event instructions when no prompt is given", () => {
    const resolved = resolve(
      makePayload({
        prompt: "",
        eventInstructions: "Review the new commits.",
        event: {
          trigger: "pull_request_opened",
          is_pr: true,
          issue_number: 12,
          title: "Add retry logic",
          body: null,
          branch: "feature",
        },
      }),
    );
    expect(resolved.full).toContain("************* YOUR TASK *************");
    expect(resolved.full).toContain('PR #12 ("Add retry logic")');
    expect(resolved.full).toContain("Review the new commits.");
    expect(resolved.eventInstructions).toBe("Review the new commits.");
  });

  it("omits the task section entirely when there is nothing to do", () => {
    const resolved = resolve(makePayload({ prompt: "" }));
    expect(resolved.full).not.toContain("************* YOUR TASK *************");
    expect(resolved.full).not.toContain("YOUR TASK — what to accomplish");
  });
});

describe("resolveInstructions — setup hook failure banner", () => {
  it("renders the banner and its TOC entry when the hook failed", () => {
    const resolved = resolve(makePayload({}), {
      setupHookFailure: "It exited with code 1 after 3s.",
    });
    expect(resolved.full).toContain("************* SETUP HOOK FAILED *************");
    expect(resolved.full).toContain("It exited with code 1 after 3s.");
    expect(resolved.full).toContain("SETUP HOOK FAILED — environment provisioning warning");
  });

  it("omits the banner when the hook succeeded", () => {
    const resolved = resolve(makePayload({}));
    expect(resolved.full).not.toContain("SETUP HOOK FAILED");
  });
});

describe("resolveInstructions — event context", () => {
  it("labels the related entity as an issue and includes event metadata", () => {
    const resolved = resolve(
      makePayload({
        prompt: "triage this",
        event: {
          trigger: "issues_opened",
          is_pr: false,
          issue_number: 3,
          title: "Crash on start",
          body: null,
        },
      }),
    );
    expect(resolved.full).toContain("************* EVENT CONTEXT *************");
    expect(resolved.full).toContain("--- related issue ---");
    expect(resolved.full).toContain('Issue #3 ("Crash on start")');
    expect(resolved.full).toContain("--- event context ---");
    expect(resolved.full).toContain("issues_opened");
    expect(resolved.event).toContain('Issue #3 ("Crash on start")');
  });

  it("renders a bare quoted title when the event has no issue number", () => {
    const resolved = resolve(
      makePayload({
        prompt: "go",
        event: { trigger: "workflow_dispatch", is_pr: false, title: "Ad-hoc run" },
      }),
    );
    expect(resolved.full).toContain('("Ad-hoc run")');
    // workflow_dispatch trigger is dropped from metadata as uninformative
    expect(resolved.full).not.toContain("trigger: workflow_dispatch");
  });

  it("omits the section when the event carries no title or metadata", () => {
    // bare workflow_dispatch: no title, and the uninformative trigger is the
    // only metadata candidate, so the whole section disappears
    const resolved = resolve(makePayload({ event: { trigger: "workflow_dispatch" } }));
    expect(resolved.full).not.toContain("************* EVENT CONTEXT *************");
    expect(resolved.event).toBe("");
  });
});

describe("resolveInstructions — shell and standalone instructions", () => {
  it("renders the disabled-shell rules", () => {
    const resolved = resolve(makePayload({ shell: "disabled" }));
    expect(resolved.full).toContain("Shell command execution is DISABLED.");
    expect(resolved.full).toContain("fix it from the failure output");
  });

  it("renders the restricted-shell rules", () => {
    const resolved = resolve(makePayload({ shell: "restricted" }));
    expect(resolved.full).toContain("This tool provides a secure environment");
    expect(resolved.full).toContain("kill_background");
  });

  it("renders the native-shell rules", () => {
    const resolved = resolve(makePayload({ shell: "enabled" }));
    expect(resolved.full).toContain("Use your native shell tool for shell command execution.");
  });

  it("adds standalone-mode guidance for unknown triggers", () => {
    const resolved = resolve(makePayload({ event: { trigger: "unknown" } }));
    expect(resolved.full).toContain("### Standalone mode");
    expect(resolved.full).toContain("unused outputs are harmless");
  });

  it("requires structured output in standalone mode when a schema is configured", () => {
    const resolved = resolve(makePayload({ event: { trigger: "unknown" } }), {
      outputSchema: { type: "object" },
    });
    expect(resolved.full).toContain("**REQUIRED structured output:**");
  });

  it("omits standalone guidance for recognized triggers", () => {
    const resolved = resolve(makePayload({}));
    expect(resolved.full).not.toContain("### Standalone mode");
  });
});

describe("resolveInstructions — learnings section", () => {
  it("renders the no-headings affordance for an unstructured file", () => {
    const resolved = resolve(makePayload({}), {
      learningsFilePath: "/tmp/learnings.md",
      learningsHeadings: [],
    });
    expect(resolved.full).toContain("************* LEARNINGS *************");
    expect(resolved.full).toContain("`/tmp/learnings.md`");
    expect(resolved.full).toContain("(no headings yet");
    expect(resolved.full).toContain("LEARNINGS — repo-specific knowledge file path + heading TOC");
  });

  it("renders an indented heading TOC relative to the shallowest depth", () => {
    const resolved = resolve(makePayload({}), {
      learningsFilePath: "/tmp/learnings.md",
      learningsHeadings: [
        { depth: 2, title: "Testing", startLine: 3, endLine: 10 },
        { depth: 3, title: "Unit tests", startLine: 5, endLine: 10 },
      ],
    });
    expect(resolved.full).toContain("- Testing (L3-L10)");
    expect(resolved.full).toContain("  - Unit tests (L5-L10)");
    expect(resolved.full).toContain("do NOT slurp the whole file");
  });

  it("omits the section when seeding failed", () => {
    const resolved = resolve(makePayload({}));
    expect(resolved.full).not.toContain("LEARNINGS");
  });
});
