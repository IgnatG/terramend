import { describe, expect, it } from "vitest";
import { type AgentDiagnostic, formatAgentHangBody } from "#app/utils/agentHangReport";

function makeDiagnostic(overrides: Partial<AgentDiagnostic> = {}): AgentDiagnostic {
  return {
    label: "Terramend",
    recentStderr: [],
    lastProviderError: undefined,
    eventCount: 0,
    ...overrides,
  };
}

describe("formatAgentHangBody", () => {
  it("returns null when no diagnostic is available", () => {
    const body = formatAgentHangBody({
      diagnostic: undefined,
      isHang: true,
      errorMessage: "activity timeout: no output for 301s",
    });
    expect(body).toBeNull();
  });

  it("renders a hang headline with parsed idle seconds", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ eventCount: 12 }),
      isHang: true,
      errorMessage: "activity timeout: no output for 301s",
    });
    expect(body).toContain("**Terramend stalled**");
    expect(body).toContain("stopped emitting events for 301s");
    expect(body).toContain("12 events were processed before the failure.");
  });

  it("falls back to a generic hang explanation when idle seconds cannot be parsed", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ eventCount: 3 }),
      isHang: true,
      errorMessage: "watchdog fired",
    });
    expect(body).toContain(
      "The agent stopped emitting events and was killed by the activity-timeout watchdog.",
    );
  });

  it("renders a failure headline with the raw error for non-hang exits", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ eventCount: 1 }),
      isHang: false,
      errorMessage: "spawn exited with code 7",
    });
    expect(body).toContain("**Terramend failed**");
    expect(body).toContain("The agent exited unexpectedly: spawn exited with code 7");
  });

  it("includes the provider-error label as a likely cause in the headline", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ lastProviderError: "provider auth error" }),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).toContain("— likely cause: `provider auth error`");
    // labeled cause suppresses the reachability nudge for zero-event runs
    expect(body).toContain("No events were emitted before the failure.");
    expect(body).not.toContain("check whether the model provider is reachable");
  });

  it("nudges about provider reachability when zero events and no provider label", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic(),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).toContain(
      "No events were emitted — check whether the model provider is reachable.",
    );
  });

  it("omits the stderr details block when no stderr was captured", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic(),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).not.toContain("<details>");
  });

  it("renders captured stderr inside a fenced details block", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ recentStderr: ["line one", "line two"] }),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).toContain("<details><summary>Recent agent stderr</summary>");
    expect(body).toContain("line one\nline two");
    expect(body).toContain("```");
  });

  it("escalates the fence beyond the longest backtick run in stderr", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ recentStderr: ["payload with ````` five backticks"] }),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).toContain("``````\npayload with ````` five backticks\n``````");
  });

  it("truncates stderr tails beyond the byte cap and marks the truncation", () => {
    const longLine = "x".repeat(1000);
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ recentStderr: [longLine, longLine, longLine, longLine] }),
      isHang: true,
      errorMessage: "no output for 60s",
    });
    expect(body).toContain("... (older lines truncated)");
    // the rendered tail is bounded: cap + truncation banner + surrounding markdown
    expect(body).toBeTypeOf("string");
    if (body) expect(body.length).toBeLessThan(3600);
  });
});

describe("formatAgentHangBody billing-exhausted branch", () => {
  it("replaces the generic headline with a billing CTA when the label matches", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({ lastProviderError: "provider billing exhausted" }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain("**Terramend stopped**");
    expect(body).toContain("billing-exhausted response");
    expect(body).toContain("Top up your model-provider balance");
    expect(body).not.toContain("stalled");
  });

  it("links the provider billing url when stderr embeds a known billing host", () => {
    const url = "https://opencode.ai/settings/billing?from=zen";
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({
        lastProviderError: "provider billing exhausted",
        recentStderr: ["some noise", `error: out of credits, visit ${url} to top up`],
      }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain(`[${url}](${url})`);
  });

  it("prefers the most recent billing url in the stderr buffer", () => {
    const older = "https://console.anthropic.com/settings/old";
    const newer = "https://console.anthropic.com/settings/billing";
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({
        lastProviderError: "provider billing exhausted",
        recentStderr: [`see ${older}`, `see ${newer}`],
      }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain(`[${newer}](${newer})`);
    // the older url still shows in the stderr tail, but must not be the CTA link
    expect(body).not.toContain(`[${older}]`);
  });

  it("ignores urls on non-billing hosts so a stray link cannot pose as the remedy", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({
        lastProviderError: "provider billing exhausted",
        recentStderr: ["see https://evil.example.com/billing for details"],
      }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain("Top up your model-provider balance");
    // the stray url still shows in the stderr tail, but must not become a CTA link
    expect(body).not.toContain("[https://evil.example.com");
  });

  it("matches a google cloud billing console url", () => {
    const url = "https://console.cloud.google.com/billing/12345";
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({
        lastProviderError: "provider billing exhausted",
        recentStderr: [`visit ${url}`],
      }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain(`[${url}](${url})`);
  });

  it("includes the stderr details block in the billing body too", () => {
    const body = formatAgentHangBody({
      diagnostic: makeDiagnostic({
        lastProviderError: "provider billing exhausted",
        recentStderr: ["insufficient balance"],
      }),
      isHang: true,
      errorMessage: "no output for 300s",
    });
    expect(body).toContain("<details><summary>Recent agent stderr</summary>");
    expect(body).toContain("insufficient balance");
  });
});
