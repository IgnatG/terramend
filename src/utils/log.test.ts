import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "#app/agents/shared";
import {
  formatIndentedField,
  formatJsonValue,
  formatUsageSummary,
  log,
  withLogPrefix,
  writeSummary,
} from "#app/utils/log";

const coreMock = vi.hoisted(() => {
  const summary = {
    addRaw: vi.fn(),
    write: vi.fn(),
  };
  summary.addRaw.mockReturnValue(summary);
  summary.write.mockResolvedValue(summary);
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    notice: vi.fn(),
    isDebug: vi.fn(() => false),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    summary,
  };
});

vi.mock("@actions/core", () => coreMock);

const globalsState = vi.hoisted(() => ({ isGitHubActions: false, isInsideDocker: false }));

vi.mock("#app/utils/globals", () => ({
  get isGitHubActions() {
    return globalsState.isGitHubActions;
  },
  get isInsideDocker() {
    return globalsState.isInsideDocker;
  },
}));

function lastInfoMessage(): string {
  const call = vi.mocked(core.info).mock.calls.at(-1);
  if (!call) throw new Error("expected core.info to have been called");
  return call[0];
}

afterEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps mockReturnValue overrides — restore the default
  coreMock.isDebug.mockReturnValue(false);
  vi.unstubAllEnvs();
  globalsState.isGitHubActions = false;
  globalsState.isInsideDocker = false;
});

describe("log.info / warning / error / success", () => {
  it("joins string, object, and Error arguments into one line", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    const error = new Error("kaboom");
    log.info("hello", { a: 1 }, error);

    const message = lastInfoMessage();
    expect(message).toContain("hello");
    expect(message).toContain('{"a":1}');
    expect(message).toContain("kaboom");
    expect(message).toContain(`${error.stack}`);
  });

  it("routes warnings and errors to the matching core methods", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.warning("careful");
    log.error("broken");
    expect(core.warning).toHaveBeenCalledWith("careful");
    expect(core.error).toHaveBeenCalledWith("broken");
  });

  it("prefixes success messages with a chevron", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.success("done");
    expect(lastInfoMessage()).toBe("» done");
  });

  it("adds an ISO timestamp when debug mode is enabled", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    log.info("timed");
    expect(lastInfoMessage()).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*\] timed$/);
  });
});

describe("withLogPrefix", () => {
  it("prefixes every line of a multi-line message in magenta", async () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    await withLogPrefix("[task]", async () => {
      log.info("line one\nline two");
    });

    const message = lastInfoMessage();
    const lines = message.split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain("\x1b[35m[task]\x1b[0m ");
    }
  });

  it("does not prefix messages logged outside the context", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.info("plain");
    expect(lastInfoMessage()).toBe("plain");
  });
});

describe("log.debug", () => {
  it("uses core.debug when the runner debug flag is on", () => {
    vi.mocked(core.isDebug).mockReturnValue(true);
    log.debug("runner-debug");
    expect(core.debug).toHaveBeenCalledWith("runner-debug");
    expect(core.info).not.toHaveBeenCalled();
  });

  it("falls back to core.info with a [DEBUG] marker when LOG_LEVEL=debug", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    log.debug("local-debug");
    expect(core.debug).not.toHaveBeenCalled();
    expect(lastInfoMessage()).toMatch(/\[DEBUG\] local-debug$/);
  });

  it("also honors ACTIONS_STEP_DEBUG=true for local debug", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "true");
    log.debug("step-debug");
    expect(lastInfoMessage()).toMatch(/\[DEBUG\] step-debug$/);
  });

  it("is silent when no debug mode is enabled", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.debug("quiet");
    expect(core.debug).not.toHaveBeenCalled();
    expect(core.info).not.toHaveBeenCalled();
  });
});

describe("groups", () => {
  it("uses core groups in GitHub Actions, with the plain prefix", async () => {
    globalsState.isGitHubActions = true;
    await withLogPrefix("[task]", async () => {
      log.startGroup("setup");
    });
    log.endGroup();
    expect(core.startGroup).toHaveBeenCalledWith("[task] setup");
    expect(core.endGroup).toHaveBeenCalled();
  });

  it("uses console groups locally", () => {
    const groupSpy = vi.spyOn(console, "group").mockImplementation(() => {});
    const groupEndSpy = vi.spyOn(console, "groupEnd").mockImplementation(() => {});

    log.startGroup("local");
    log.endGroup();

    expect(groupSpy).toHaveBeenCalledWith("local");
    expect(groupEndSpy).toHaveBeenCalled();
    groupSpy.mockRestore();
    groupEndSpy.mockRestore();
  });

  it("log.group runs the callback between start and end", () => {
    globalsState.isGitHubActions = true;
    const fn = vi.fn(() => {
      expect(core.startGroup).toHaveBeenCalled();
      expect(core.endGroup).not.toHaveBeenCalled();
    });
    log.group("wrapped", fn);
    expect(fn).toHaveBeenCalled();
    expect(core.endGroup).toHaveBeenCalled();
  });
});

describe("log.box", () => {
  it("draws a box with a title line", () => {
    log.box("hello", { title: "Greeting" });
    const message = lastInfoMessage();
    expect(message).toContain("┌ Greeting ");
    expect(message).toContain("│ hello");
    expect(message).toContain("└");
  });

  it("draws a box without a title", () => {
    log.box("hello");
    const message = lastInfoMessage();
    expect(message).toMatch(/┌─+┐/);
    expect(message).toContain("│ hello │");
  });

  it("wraps long lines at maxWidth", () => {
    log.box("alpha beta gamma delta", { maxWidth: 14 });
    const message = lastInfoMessage();
    const contentLines = message.split("\n").filter((line) => line.startsWith("│"));
    expect(contentLines.length).toBeGreaterThan(1);
    for (const line of contentLines) {
      expect(line.length).toBeLessThanOrEqual(14 + 2);
    }
  });

  it("breaks words longer than the box width into chunks", () => {
    log.box("abcdefghijklmnopqrstuvwxyz", { maxWidth: 12 });
    const message = lastInfoMessage();
    expect(message).toContain("abcdefghij");
    expect(message).toContain("klmnopqrst");
    expect(message).toContain("uvwxyz");
  });

  it("handles a word that splits into exact chunks with no remainder", () => {
    // 20 chars with maxWidth 12 (padding 1) → two exact 10-char chunks
    log.box("abcdefghijklmnopqrst", { maxWidth: 12 });
    const message = lastInfoMessage();
    const contentLines = message.split("\n").filter((line) => line.startsWith("│"));
    expect(contentLines).toHaveLength(2);
    expect(message).toContain("abcdefghij");
    expect(message).toContain("klmnopqrst");
  });

  it("drops a trailing empty word left over after wrapping", () => {
    // the inner line ends with a space: the final empty word forces a wrap
    // that leaves nothing to flush after the loop
    log.box("abcdefghij \nnext", { maxWidth: 12 });
    const message = lastInfoMessage();
    const contentLines = message.split("\n").filter((line) => line.startsWith("│"));
    expect(contentLines).toHaveLength(2);
    expect(message).toContain("abcdefghij");
    expect(message).toContain("next");
  });
});

describe("log.table", () => {
  it("renders header objects and plain string cells", () => {
    log.table([
      [{ data: "Name", header: true }, "Value"],
      ["tokens", "42"],
    ]);
    const message = lastInfoMessage();
    expect(message).toContain("Name");
    expect(message).toContain("tokens");
    expect(message).toContain("42");
  });

  it("prints the title before the table when provided", () => {
    log.table([["only"]], { title: "Usage" });
    const calls = vi.mocked(core.info).mock.calls.map((call) => call[0]);
    expect(calls.some((message) => message.includes("Usage"))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("log.separator", () => {
  it("prints 50 dashes by default", () => {
    log.separator();
    expect(lastInfoMessage()).toBe("─".repeat(50));
  });

  it("honors a custom length", () => {
    log.separator(3);
    expect(lastInfoMessage()).toBe("───");
  });
});

describe("log.toolCall", () => {
  it("renders empty input as a bare call", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.toolCall({ toolName: "Read", input: {} });
    expect(lastInfoMessage()).toBe("» Read()");
  });

  it("renders compact JSON input inline", () => {
    vi.stubEnv("LOG_LEVEL", "");
    vi.stubEnv("ACTIONS_STEP_DEBUG", "");
    log.toolCall({ toolName: "Read", input: { file: "a.ts" } });
    expect(lastInfoMessage()).toBe('» Read({"file":"a.ts"})');
  });
});

describe("writeSummary", () => {
  it("does nothing outside GitHub Actions", async () => {
    await writeSummary("text");
    expect(coreMock.summary.addRaw).not.toHaveBeenCalled();
  });

  it("does nothing inside Docker even in GitHub Actions", async () => {
    globalsState.isGitHubActions = true;
    globalsState.isInsideDocker = true;
    await writeSummary("text");
    expect(coreMock.summary.addRaw).not.toHaveBeenCalled();
  });

  it("does nothing when GITHUB_STEP_SUMMARY is unset", async () => {
    globalsState.isGitHubActions = true;
    vi.stubEnv("GITHUB_STEP_SUMMARY", "");
    await writeSummary("text");
    expect(coreMock.summary.addRaw).not.toHaveBeenCalled();
  });

  it("overwrites the job summary when fully configured", async () => {
    globalsState.isGitHubActions = true;
    vi.stubEnv("GITHUB_STEP_SUMMARY", "/tmp/summary.md");
    await writeSummary("# report");
    expect(coreMock.summary.addRaw).toHaveBeenCalledWith("# report");
    expect(coreMock.summary.write).toHaveBeenCalledWith({ overwrite: true });
  });
});

describe("formatJsonValue", () => {
  it("uses compact JSON for short values", () => {
    expect(formatJsonValue({ a: 1 })).toBe('{"a":1}');
  });

  it("pretty-prints values whose compact form exceeds 80 chars", () => {
    const value = { key: "x".repeat(100) };
    expect(formatJsonValue(value)).toBe(JSON.stringify(value, null, 2));
  });
});

describe("formatIndentedField", () => {
  it("renders single-line content inline", () => {
    expect(formatIndentedField("label", "value")).toBe("  label: value\n");
  });

  it("indents continuation lines by four spaces", () => {
    expect(formatIndentedField("label", "first\nsecond\nthird")).toBe(
      "  label: first\n    second\n    third\n",
    );
  });
});

describe("formatUsageSummary", () => {
  it("returns an empty string for no entries", () => {
    expect(formatUsageSummary([])).toBe("");
  });

  it("renders a single row without a totals row, recovering non-cached input", () => {
    const entries: AgentUsage[] = [
      {
        agent: "claude",
        inputTokens: 1500,
        outputTokens: 200,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
        costUsd: 0.5,
      },
    ];
    const summary = formatUsageSummary(entries);
    expect(summary).toContain("| claude | 1,000 | 400 | 100 | 200 | 1,700 | 0.5000 |");
    expect(summary).not.toContain("**Total**");
    expect(summary).toContain("<details>");
  });

  it("shows an em dash for missing or zero cost and clamps negative non-cached input", () => {
    const entries: AgentUsage[] = [
      // cache fields exceed inputTokens — non-cached input must clamp to 0
      { agent: "weird", inputTokens: 100, outputTokens: 10, cacheReadTokens: 300 },
    ];
    const summary = formatUsageSummary(entries);
    expect(summary).toContain("| weird | 0 | 300 | 0 | 10 | 310 | — |");
  });

  it("adds a bold totals row when there are multiple entries", () => {
    const entries: AgentUsage[] = [
      { agent: "a", inputTokens: 1000, outputTokens: 100, costUsd: 0.25 },
      {
        agent: "b",
        inputTokens: 2000,
        outputTokens: 200,
        cacheReadTokens: 500,
        cacheWriteTokens: 250,
        costUsd: 0.75,
      },
    ];
    const summary = formatUsageSummary(entries);
    expect(summary).toContain(
      "| **Total** | **2,250** | **500** | **250** | **300** | **3,300** | **1.0000** |",
    );
  });

  it("shows an em dash in the totals row when no entry has a cost", () => {
    const entries: AgentUsage[] = [
      { agent: "a", inputTokens: 10, outputTokens: 1 },
      { agent: "b", inputTokens: 20, outputTokens: 2 },
    ];
    const summary = formatUsageSummary(entries);
    expect(summary).toContain("| **Total** | **30** | **0** | **0** | **3** | **33** | — |");
  });
});
