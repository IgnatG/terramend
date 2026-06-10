import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingTimer, Timer } from "#app/utils/timer";

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { log } from "#app/utils/cli";

const debugMock = vi.mocked(log.debug);
const infoMock = vi.mocked(log.info);

let nowSpy: ReturnType<typeof vi.spyOn>;
let now = 0;

function setNow(value: number): void {
  now = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  now = 0;
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe("Timer", () => {
  it("measures the first checkpoint from construction", () => {
    setNow(100);
    const timer = new Timer();
    setNow(350);
    timer.checkpoint("startup");
    expect(debugMock).toHaveBeenCalledWith("» startup: 250ms");
  });

  it("measures subsequent checkpoints from the previous one", () => {
    setNow(0);
    const timer = new Timer();
    setNow(50);
    timer.checkpoint("first");
    setNow(80);
    timer.checkpoint("second");
    expect(debugMock).toHaveBeenLastCalledWith("» second: 30ms");
  });
});

describe("ThinkingTimer", () => {
  it("does nothing on a tool call without a prior tool result", () => {
    const timer = new ThinkingTimer();
    setNow(10_000);
    timer.markToolCall();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("stays silent below the thinking threshold", () => {
    const timer = new ThinkingTimer();
    setNow(0);
    timer.markToolResult();
    setNow(2999);
    timer.markToolCall();
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("logs the thinking duration once the threshold is crossed", () => {
    const timer = new ThinkingTimer();
    setNow(0);
    timer.markToolResult();
    setNow(4500);
    timer.markToolCall();
    expect(infoMock).toHaveBeenCalledWith("» thought for 4.5 seconds");
  });

  it("prefixes output with the caller-provided line formatter", () => {
    const timer = new ThinkingTimer((line) => `[subagent] ${line}`);
    setNow(0);
    timer.markToolResult();
    setNow(10_000);
    timer.markToolCall();
    expect(infoMock).toHaveBeenCalledWith("[subagent] » thought for 10 seconds");
  });
});
