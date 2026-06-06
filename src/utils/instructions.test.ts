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
    expect(full).toContain('pinned to **Remediate** mode');
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
