import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTodoTracker } from "#app/utils/todoTracking";

vi.mock("#app/utils/log", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const DEBOUNCE_MS = 2000;

function todos(...items: { content: string; status?: string; id?: string }[]): unknown {
  return { todos: items };
}

describe("createTodoTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes rendered markdown after the debounce window", async () => {
    const onUpdate = vi.fn(async (_body: string) => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update(
      todos(
        { content: "done item", status: "completed" },
        { content: "dropped item", status: "cancelled" },
        { content: "active item", status: "in_progress" },
        { content: "queued item", status: "pending" },
      ),
    );

    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await tracker.settled();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const body = onUpdate.mock.calls[0]?.[0];
    expect(body).toContain("- [x] done item");
    expect(body).toContain("- ~~dropped item~~");
    expect(body).toContain("active item");
    expect(body).toContain("- [ ] queued item");
    expect(tracker.hasPublished).toBe(true);
  });

  it("ignores inputs that are not valid todowrite payloads", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update(undefined);
    tracker.update("nope");
    tracker.update({ noTodos: true });
    tracker.update({ todos: "not-an-array" });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await tracker.settled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(tracker.hasPublished).toBe(false);
  });

  it("skips malformed entries and defaults id/status", async () => {
    const onUpdate = vi.fn(async (_body: string) => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update({
      todos: [
        null,
        "string entry",
        { noContent: true },
        { content: "no status entry" },
        { content: "bad status entry", status: "exploded" },
        { content: "with id", id: "custom", status: "completed" },
      ],
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await tracker.settled();

    const body = onUpdate.mock.calls[0]?.[0];
    expect(body).toBe("- [ ] no status entry\n- [ ] bad status entry\n- [x] with id");
  });

  it("replaces state by default and merges when merge=true", () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update({ todos: [{ content: "first", id: "a" }] });
    tracker.update({ todos: [{ content: "second", id: "b" }] });
    expect(tracker.renderCollapsible()).toContain("second");
    expect(tracker.renderCollapsible()).not.toContain("first");

    tracker.update({
      todos: [{ content: "merged", id: "a", status: "completed" }],
      merge: true,
    });
    const rendered = tracker.renderCollapsible();
    expect(rendered).toContain("merged");
    expect(rendered).toContain("second");
  });

  it("does not publish when the debounce fires with an empty state", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update({ todos: [] });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await tracker.settled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("flush publishes immediately and clears the pending debounce", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update(todos({ content: "task" }));
    await tracker.flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await tracker.settled();
    // the pending debounce was cleared — no second publish
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("flush is a no-op when state is empty", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);
    await tracker.flush();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("swallows onUpdate failures on flush and stays unpublished", async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error("boom");
    });
    const tracker = createTodoTracker(onUpdate);

    tracker.update(todos({ content: "task" }));
    await tracker.flush();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(tracker.hasPublished).toBe(false);
  });

  it("swallows onUpdate failures from the debounced path", async () => {
    const onUpdate = vi.fn(async () => {
      throw new Error("boom");
    });
    const tracker = createTodoTracker(onUpdate);

    tracker.update(todos({ content: "task" }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await tracker.settled();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(tracker.hasPublished).toBe(false);
  });

  it("cancel disables the tracker and clears the pending debounce", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update(todos({ content: "task" }));
    expect(tracker.enabled).toBe(true);
    tracker.cancel();
    expect(tracker.enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    await tracker.settled();
    expect(onUpdate).not.toHaveBeenCalled();

    // updates and flushes after cancel are no-ops
    tracker.update(todos({ content: "late" }));
    await tracker.flush();
    expect(onUpdate).not.toHaveBeenCalled();

    // cancel again exercises the no-pending-timer path
    tracker.cancel();
  });

  it("completeInProgress flips in_progress items to completed in state", async () => {
    const onUpdate = vi.fn(async () => undefined);
    const tracker = createTodoTracker(onUpdate);

    tracker.update(
      todos({ content: "active", status: "in_progress" }, { content: "queued", status: "pending" }),
    );
    tracker.completeInProgress();

    const rendered = tracker.renderCollapsible();
    expect(rendered).toContain("- [x] active");
    expect(rendered).toContain("- [ ] queued");
  });

  it("renderCollapsible returns empty string with no state", () => {
    const tracker = createTodoTracker(vi.fn(async () => undefined));
    expect(tracker.renderCollapsible()).toBe("");
  });

  it("renderCollapsible can complete in-progress items without mutating state", () => {
    const tracker = createTodoTracker(vi.fn(async () => undefined));
    tracker.update(
      todos({ content: "active", status: "in_progress" }, { content: "done", status: "completed" }),
    );

    const completed = tracker.renderCollapsible({ completeInProgress: true });
    expect(completed).toContain("Task list (2/2 completed)");
    expect(completed).toContain("- [x] active");

    // state itself stays in_progress
    const plain = tracker.renderCollapsible();
    expect(plain).toContain("Task list (1/2 completed)");
  });
});
