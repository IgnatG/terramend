import { describe, expect, it } from "vitest";
import { deriveSubagentModels } from "./subagentModels.ts";

describe("deriveSubagentModels", () => {
  it("returns no override when orchestrator is undefined", () => {
    expect(deriveSubagentModels(undefined)).toEqual({ reviewer: undefined });
  });

  it("returns no override when orchestrator slug isn't registered", () => {
    expect(deriveSubagentModels("nonexistent/model")).toEqual({ reviewer: undefined });
  });

  describe("anthropic family — opus → sonnet", () => {
    it("direct anthropic opus", () => {
      expect(deriveSubagentModels("anthropic/claude-opus-4-8")).toEqual({
        reviewer: "anthropic/claude-sonnet-4-6",
      });
    });
    it("opencode-vendored opus stays on opencode prefix", () => {
      expect(deriveSubagentModels("opencode/claude-opus-4-8")).toEqual({
        reviewer: "opencode/claude-sonnet-4-6",
      });
    });
    it("openrouter-anthropic-opus-via-anthropic-direct hits anthropic alias's openRouterResolve", () => {
      // both the anthropic alias and the opencode alias have the same
      // openRouterResolve. first-match-wins by alias declaration order
      // (anthropic declared first in providers).
      expect(deriveSubagentModels("openrouter/anthropic/claude-opus-4.8")).toEqual({
        reviewer: "openrouter/anthropic/claude-sonnet-4.6",
      });
    });
    it("sonnet has no further downshift", () => {
      expect(deriveSubagentModels("anthropic/claude-sonnet-4-6")).toEqual({ reviewer: undefined });
      expect(deriveSubagentModels("opencode/claude-sonnet-4-6")).toEqual({ reviewer: undefined });
    });
    it("haiku has no downshift", () => {
      expect(deriveSubagentModels("anthropic/claude-haiku-4-5")).toEqual({ reviewer: undefined });
    });
  });

  describe("openai family", () => {
    it("gpt-pro → gpt (direct)", () => {
      expect(deriveSubagentModels("openai/gpt-5.5-pro")).toEqual({ reviewer: "openai/gpt-5.5" });
    });
    it("gpt → gpt-5.4 (direct)", () => {
      expect(deriveSubagentModels("openai/gpt-5.5")).toEqual({ reviewer: "openai/gpt-5.4" });
    });
    it("gpt → gpt-5.4 (opencode-vendored)", () => {
      expect(deriveSubagentModels("opencode/gpt-5.5")).toEqual({ reviewer: "opencode/gpt-5.4" });
    });
    it("gpt-pro → gpt (openrouter)", () => {
      expect(deriveSubagentModels("openrouter/openai/gpt-5.5-pro")).toEqual({
        reviewer: "openrouter/openai/gpt-5.5",
      });
    });
    it("gpt → gpt-5.4 (openrouter)", () => {
      expect(deriveSubagentModels("openrouter/openai/gpt-5.5")).toEqual({
        reviewer: "openrouter/openai/gpt-5.4",
      });
    });
    it("gpt-5.4 itself (the hidden subagent target) has no further downshift", () => {
      expect(deriveSubagentModels("openai/gpt-5.4")).toEqual({ reviewer: undefined });
    });
    it("gpt-mini has no downshift", () => {
      expect(deriveSubagentModels("openai/gpt-5.4-mini")).toEqual({ reviewer: undefined });
    });
  });

  describe("google (gemini) — inherit (Pro for both orchestrator and lenses)", () => {
    // pro → flash was a meaningful capability cliff (Flash missed catastrophic
    // cross-file bugs the v4 e2e test surfaced); Pro is cost-effective enough
    // to keep on for lenses too. Google has no in-between tier.
    it("direct google pro inherits", () => {
      expect(deriveSubagentModels("google/gemini-3.1-pro-preview")).toEqual({
        reviewer: undefined,
      });
    });
    it("opencode-vendored gemini-pro inherits", () => {
      expect(deriveSubagentModels("opencode/gemini-3.1-pro")).toEqual({
        reviewer: undefined,
      });
    });
    it("openrouter gemini-pro inherits", () => {
      expect(deriveSubagentModels("openrouter/google/gemini-3.1-pro-preview")).toEqual({
        reviewer: undefined,
      });
    });
    it("flash has no downshift", () => {
      expect(deriveSubagentModels("google/gemini-3-flash-preview")).toEqual({
        reviewer: undefined,
      });
    });
  });

  describe("providers / models without a subagentModel — inherit", () => {
    it("xai grok (already cheap flagship)", () => {
      expect(deriveSubagentModels("xai/grok-4.3")).toEqual({ reviewer: undefined });
    });
    it("deepseek", () => {
      expect(deriveSubagentModels("deepseek/deepseek-v4-pro")).toEqual({ reviewer: undefined });
    });
    it("moonshot kimi", () => {
      expect(deriveSubagentModels("moonshotai/kimi-k2.6")).toEqual({ reviewer: undefined });
    });
    it("opencode big-pickle", () => {
      expect(deriveSubagentModels("opencode/big-pickle")).toEqual({ reviewer: undefined });
    });
    it("legacy fallback aliases (gpt-codex, deepseek-reasoner)", () => {
      expect(deriveSubagentModels("openai/gpt-5.3-codex")).toEqual({ reviewer: undefined });
      expect(deriveSubagentModels("deepseek/deepseek-reasoner")).toEqual({ reviewer: undefined });
    });
  });
});
