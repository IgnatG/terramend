import { describe, expect, it, vi } from "vitest";
import { initToolState } from "#app/toolState";
import { log } from "#app/utils/cli";

vi.mock("#app/utils/cli", () => ({
  log: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("initToolState", () => {
  it("returns the literal base state without a progress comment", () => {
    const state = initToolState({ progressComment: undefined });

    expect(state.progressComment).toBeUndefined();
    expect(state.hadProgressComment).toBe(false);
    expect(state.prepushFailureCount).toBe(0);
    expect(state.backgroundProcesses).toEqual(new Map());
    expect(state.usageEntries).toEqual([]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it("parses a pre-created progress comment and logs it", () => {
    const state = initToolState({ progressComment: { id: "123", type: "issue" } });

    expect(state.progressComment).toEqual({ id: 123, type: "issue" });
    expect(state.hadProgressComment).toBe(true);
    expect(log.info).toHaveBeenCalledWith("» using pre-created progress comment: 123 (issue)");
  });

  it("treats an unparseable progress comment id as absent", () => {
    expect(initToolState({ progressComment: { id: "abc", type: "issue" } })).toMatchObject({
      progressComment: undefined,
      hadProgressComment: false,
    });
    expect(initToolState({ progressComment: { id: "0", type: "review" } })).toMatchObject({
      progressComment: undefined,
      hadProgressComment: false,
    });
  });

  it("preserves the review comment type", () => {
    const state = initToolState({ progressComment: { id: "77", type: "review" } });

    expect(state.progressComment).toEqual({ id: 77, type: "review" });
  });
});
