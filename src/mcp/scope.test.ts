import { describe, expect, it } from "vitest";
import { assertTargetInScope, isTargetInScope, recordCreatedTarget } from "#app/mcp/scope";
import type { ToolContext } from "#app/mcp/server";

function makeCtx(opts: { issueNumber?: number; created?: number[] } = {}): ToolContext {
  const event =
    opts.issueNumber === undefined
      ? { trigger: "unknown" }
      : { trigger: "pull_request_opened", issue_number: opts.issueNumber, is_pr: true };
  return {
    payload: { event },
    toolState: { createdTargets: new Set<number>(opts.created ?? []) },
  } as unknown as ToolContext;
}

describe("scope guard", () => {
  it("allows any target on standalone runs (no triggering issue/PR)", () => {
    const ctx = makeCtx({});
    expect(isTargetInScope(ctx, 999)).toBe(true);
    expect(() => assertTargetInScope(ctx, 999, "comment on")).not.toThrow();
  });

  it("allows the run's triggering issue/PR", () => {
    expect(isTargetInScope(makeCtx({ issueNumber: 5 }), 5)).toBe(true);
  });

  it("blocks a different issue/PR in the same repo", () => {
    const ctx = makeCtx({ issueNumber: 5 });
    expect(isTargetInScope(ctx, 6)).toBe(false);
    expect(() => assertTargetInScope(ctx, 6, "comment on")).toThrow(
      /scoped to #5; refusing to comment on #6/,
    );
  });

  it("allows a PR/issue the run created", () => {
    expect(isTargetInScope(makeCtx({ issueNumber: 5, created: [50] }), 50)).toBe(true);
  });

  it("recordCreatedTarget widens scope to the new target", () => {
    const ctx = makeCtx({ issueNumber: 5 });
    expect(isTargetInScope(ctx, 77)).toBe(false);
    recordCreatedTarget(ctx, 77);
    expect(isTargetInScope(ctx, 77)).toBe(true);
  });

  it("recordCreatedTarget initializes the set when absent", () => {
    const ctx = {
      payload: { event: { trigger: "issues_opened", issue_number: 1 } },
      toolState: {},
    } as unknown as ToolContext;
    recordCreatedTarget(ctx, 42);
    expect(isTargetInScope(ctx, 42)).toBe(true);
  });

  it("degrades to a no-op when payload/event is missing (defensive)", () => {
    const ctx = { toolState: {} } as unknown as ToolContext;
    expect(isTargetInScope(ctx, 123)).toBe(true);
  });
});
