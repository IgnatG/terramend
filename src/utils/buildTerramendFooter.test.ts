import { describe, expect, it } from "vitest";
import { buildTerramendFooter } from "#app/utils/buildTerramendFooter";

describe("buildTerramendFooter — fallbackFrom annotation", () => {
  it("renders the provider display name when fallbackFrom is set", () => {
    const footer = buildTerramendFooter({
      model: "opencode/big-pickle",
      fallbackFrom: "anthropic/claude-opus",
    });
    expect(footer).toContain(
      "Using `Big Pickle` (free) (credentials for Anthropic not configured)"
    );
  });

  it("works for OpenAI's display name too", () => {
    const footer = buildTerramendFooter({
      model: "opencode/big-pickle",
      fallbackFrom: "openai/gpt",
    });
    expect(footer).toContain("(credentials for OpenAI not configured)");
  });

  it("falls back to the raw provider key when the slug provider is unknown to the catalog", () => {
    const footer = buildTerramendFooter({
      model: "opencode/big-pickle",
      fallbackFrom: "some-unknown/model",
    });
    expect(footer).toContain("(credentials for some-unknown not configured)");
  });

  it("omits the annotation when fallbackFrom is not set", () => {
    const footer = buildTerramendFooter({
      model: "anthropic/claude-opus",
    });
    expect(footer).toContain("Using `Claude Opus`");
    expect(footer).not.toContain("not configured");
  });
});
