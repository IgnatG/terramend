import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliModel } from "#app/models";
import {
  buildUnavailableModelError,
  FREE_FALLBACK_SLUG,
  hasProviderKeyForModel,
  selectFallbackModelIfNeeded,
} from "#app/utils/byokFallback";

describe("FREE_FALLBACK_SLUG", () => {
  it("resolves in the curated catalog", () => {
    expect(resolveCliModel(FREE_FALLBACK_SLUG)).toBe("opencode/big-pickle");
  });

  it("is opencode/big-pickle", () => {
    expect(FREE_FALLBACK_SLUG).toBe("opencode/big-pickle");
  });
});

describe("selectFallbackModelIfNeeded", () => {
  const empty = new Set<string>();

  it("falls back to free when the model is unauthorized AND no provider key is present", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      authorized: empty,
      providerKeyPresent: false,
    });
    expect(result).toEqual({
      kind: "fallback",
      from: "anthropic/claude-opus-4-7",
      to: FREE_FALLBACK_SLUG,
    });
  });

  it("reports unavailable (does NOT downgrade) when a provider key IS present but the model is unauthorized", () => {
    // PR #2 scenario: Google key set, but the configured Google model id isn't
    // one OpenCode can route → fail loudly instead of silently serving free.
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "google/gemini-3.5-flash-lite",
      authorized: new Set(["google/gemini-3.5-flash", "google/gemini-3.1-pro"]),
      providerKeyPresent: true,
    });
    expect(result).toEqual({ kind: "unavailable", model: "google/gemini-3.5-flash-lite" });
  });

  it("uses the resolved model when it IS authorized (regardless of key presence)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      authorized: new Set(["anthropic/claude-opus-4-7"]),
      providerKeyPresent: true,
    });
    expect(result).toEqual({ kind: "use-resolved" });
  });

  it("uses the resolved model when none is resolved (auto-select path)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: undefined,
      authorized: empty,
      providerKeyPresent: false,
    });
    expect(result).toEqual({ kind: "use-resolved" });
  });

  it("uses the resolved model when it is itself the free fallback", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: FREE_FALLBACK_SLUG,
      authorized: empty,
      providerKeyPresent: false,
    });
    expect(result).toEqual({ kind: "use-resolved" });
  });

  it("uses the resolved model for Bedrock routing (raw model ID has no slash)", () => {
    // resolveModel({slug:"bedrock/byok"}) returns the raw BEDROCK_MODEL_ID
    // value (e.g. "eu.anthropic.claude-opus-4-7"), which has no `/`. the
    // routing validator (validateBedrockSetup) owns auth + region + model-id
    // checking for this path, not the BYOK fallback gate.
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "eu.anthropic.claude-opus-4-7",
      authorized: empty,
      providerKeyPresent: true,
    });
    expect(result).toEqual({ kind: "use-resolved" });
  });

  it("uses the resolved model when stored minimax-m2.5-free resolves to big-pickle", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: resolveCliModel("opencode/minimax-m2.5-free"),
      authorized: empty,
      providerKeyPresent: false,
    });
    expect(result).toEqual({ kind: "use-resolved" });
  });
});

describe("hasProviderKeyForModel", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true when a Google key is present for a resolved Google model", () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "xxx");
    expect(hasProviderKeyForModel("google/gemini-3.5-flash-lite")).toBe(true);
  });

  it("is true for the alternate Google key env var", () => {
    vi.stubEnv("GEMINI_API_KEY", "xxx");
    expect(hasProviderKeyForModel("google/gemini-3.1-pro-preview")).toBe(true);
  });

  it("is false when no key for that provider is present", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    expect(hasProviderKeyForModel("google/gemini-3.5-flash-lite")).toBe(false);
  });

  it("detects the Anthropic OAuth token shape as a present key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok");
    expect(hasProviderKeyForModel("anthropic/claude-opus-4-8")).toBe(true);
  });

  it("is false for an unknown provider (no catalog env vars)", () => {
    expect(hasProviderKeyForModel("madeup/model")).toBe(false);
  });
});

describe("buildUnavailableModelError", () => {
  it("lists same-provider authorized models and names the provider", () => {
    const msg = buildUnavailableModelError({
      model: "google/gemini-3.5-flash-lite",
      authorized: new Set([
        "google/gemini-3.5-flash",
        "google/gemini-3.1-pro",
        "anthropic/claude-opus-4-8",
      ]),
    });
    expect(msg).toContain(
      'model "google/gemini-3.5-flash-lite" is not available to your Google key',
    );
    expect(msg).toContain("  - google/gemini-3.5-flash");
    expect(msg).toContain("  - google/gemini-3.1-pro");
    // unrelated provider is filtered out when same-provider matches exist
    expect(msg).not.toContain("anthropic/claude-opus-4-8");
  });

  it("falls back to the full authorized list when no same-provider model is authorized", () => {
    const msg = buildUnavailableModelError({
      model: "google/gemini-3.5-flash-lite",
      authorized: new Set(["anthropic/claude-opus-4-8"]),
    });
    expect(msg).toContain("  - anthropic/claude-opus-4-8");
  });

  it("handles an empty authorized set without throwing", () => {
    const msg = buildUnavailableModelError({
      model: "google/gemini-3.5-flash-lite",
      authorized: new Set(),
    });
    expect(msg).toContain("does not authorize any model");
  });
});
