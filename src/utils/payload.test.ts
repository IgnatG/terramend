import { isAbsolute, resolve } from "node:path";
import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODE_NAMES } from "#app/modes";
import {
  Inputs,
  JsonPayload,
  parseAllowReplace,
  parseBaseBranch,
  parseMode,
  resolveOutputSchema,
  resolvePayload,
  resolvePromptInput,
} from "#app/utils/payload";
import type { RepoSettings } from "#app/utils/runContext";
import packageJson from "#package.json" with { type: "json" };

vi.mock("@actions/core");

/** drive core.getInput for resolvePromptInput / resolvePayload / resolveOutputSchema */
function setInputs(map: Record<string, string>): void {
  vi.mocked(core.getInput).mockImplementation((name: string) => map[name] ?? "");
}

function makeRepoSettings(overrides: Partial<RepoSettings> = {}): RepoSettings {
  return {
    model: null,
    modes: [],
    setupScript: null,
    postCheckoutScript: null,
    prepushScript: null,
    stopScript: null,
    push: "restricted",
    shell: "restricted",
    prApproveEnabled: false,
    modeInstructions: {},
    learnings: null,
    learningsHeadings: [],
    envAllowlist: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Inputs schema", () => {
  it("only prompt is required", () => {
    const result = Inputs.assert({ prompt: "test prompt" });
    expect(result).toEqual({ prompt: "test prompt" });
    expect(() => Inputs.assert({})).toThrow();
  });

  it.each([
    ["push", "enabled"],
    ["push", "disabled"],
    ["push", undefined],
    ["shell", "enabled"],
    ["shell", "restricted"],
    ["shell", "disabled"],
    ["shell", undefined],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["timeout", undefined],
  ] as const)("should accept %s for %s", (prop, value) => {
    const input = { prompt: "test", [prop]: value };
    expect(() => Inputs.assert(input)).not.toThrow();
  });

  it.each([["push"], ["shell"]] as const)("should reject invalid %s values", (prop) => {
    const input = { prompt: "test", [prop]: "invalid" as any };
    expect(() => Inputs.assert(input)).toThrow();
  });

  it("accepts a free-form mode string (validation happens in parseMode)", () => {
    expect(() => Inputs.assert({ prompt: "test", mode: "Remediate" })).not.toThrow();
    expect(() => Inputs.assert({ prompt: "test", mode: undefined })).not.toThrow();
  });
});

describe("parseMode", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseMode(undefined)).toBeUndefined();
    expect(parseMode("")).toBeUndefined();
    expect(parseMode("   ")).toBeUndefined();
  });

  it("canonicalizes a case-insensitive match to the built-in name", () => {
    expect(parseMode("remediate")).toBe("Remediate");
    expect(parseMode("  REMEDIATE  ")).toBe("Remediate");
    expect(parseMode("Build")).toBe("Build");
    expect(parseMode("generateterraform")).toBe("GenerateTerraform");
  });

  it("exposes the GenerateTerraform mode as a pinnable built-in", () => {
    expect(BUILTIN_MODE_NAMES).toContain("GenerateTerraform");
  });

  it("every built-in mode name round-trips through itself", () => {
    for (const name of BUILTIN_MODE_NAMES) {
      expect(parseMode(name)).toBe(name);
      expect(parseMode(name.toLowerCase())).toBe(name);
    }
  });

  it("falls back to undefined (agent auto-selects) for an unknown mode", () => {
    expect(parseMode("definitely-not-a-mode")).toBeUndefined();
  });
});

describe("parseBaseBranch", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseBaseBranch(undefined)).toBeUndefined();
    expect(parseBaseBranch("")).toBeUndefined();
    expect(parseBaseBranch("   ")).toBeUndefined();
  });

  it("trims and returns a plain branch name", () => {
    expect(parseBaseBranch("main")).toBe("main");
    expect(parseBaseBranch("  release/1.2  ")).toBe("release/1.2");
  });

  it("strips a leading refs/heads/", () => {
    expect(parseBaseBranch("refs/heads/main")).toBe("main");
    expect(parseBaseBranch("refs/heads/release/1.2")).toBe("release/1.2");
  });
});

describe("parseAllowReplace", () => {
  it("returns undefined for unset/empty input", () => {
    expect(parseAllowReplace(undefined)).toBeUndefined();
    expect(parseAllowReplace("")).toBeUndefined();
    expect(parseAllowReplace("  ,  ")).toBeUndefined();
  });

  it("splits, trims, and drops empties", () => {
    expect(parseAllowReplace("aws_db_instance.main, aws_s3_bucket.*")).toEqual([
      "aws_db_instance.main",
      "aws_s3_bucket.*",
    ]);
    expect(parseAllowReplace("*")).toEqual(["*"]);
  });
});

describe("JsonPayload schema", () => {
  it("requires ~terramend and version and prompt", () => {
    const result = JsonPayload.assert({
      "~terramend": true,
      version: "1.2.3",
      prompt: "test prompt",
    });
    expect(result).toMatchObject({ "~terramend": true, version: "1.2.3", prompt: "test prompt" });
    expect(() => JsonPayload.assert({})).toThrow();
    expect(() => JsonPayload.assert({ "~terramend": true })).toThrow();
    expect(() => JsonPayload.assert({ version: "1.2.3" })).toThrow();
  });

  it.each([
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["model", "anthropic/claude-opus"],
    ["event", { trigger: "unknown" }],
  ] as const)("should accept optional %s with value %s", (prop, value) => {
    const input = { "~terramend": true, version: "1.2.3", prompt: "test prompt", [prop]: value };
    expect(() => JsonPayload.assert(input)).not.toThrow();
  });
});

describe("resolvePromptInput", () => {
  it("returns a plain-text prompt verbatim", () => {
    setInputs({ prompt: "fix the lint errors" });
    expect(resolvePromptInput()).toBe("fix the lint errors");
  });

  it("returns invalid JSON as the plain-text prompt", () => {
    setInputs({ prompt: "{not json" });
    expect(resolvePromptInput()).toBe("{not json");
  });

  it("returns JSON without the ~terramend marker as the plain-text prompt", () => {
    setInputs({ prompt: '{"version":"1.0.0","prompt":"x"}' });
    expect(resolvePromptInput()).toBe('{"version":"1.0.0","prompt":"x"}');
  });

  it("returns non-object JSON (null / number) as the plain-text prompt", () => {
    setInputs({ prompt: "null" });
    expect(resolvePromptInput()).toBe("null");
    setInputs({ prompt: "123" });
    expect(resolvePromptInput()).toBe("123");
  });

  it("parses a compatible terramend JSON payload", () => {
    setInputs({
      prompt: JSON.stringify({
        "~terramend": true,
        version: packageJson.version,
        prompt: "dispatched prompt",
      }),
    });
    expect(resolvePromptInput()).toMatchObject({
      "~terramend": true,
      version: packageJson.version,
      prompt: "dispatched prompt",
    });
  });

  it("throws on a terramend payload that fails schema validation", () => {
    setInputs({ prompt: JSON.stringify({ "~terramend": true, version: packageJson.version }) });
    expect(() => resolvePromptInput()).toThrow();
  });

  it("throws on an incompatible payload version", () => {
    setInputs({
      prompt: JSON.stringify({ "~terramend": true, version: "0.0.1", prompt: "old dispatch" }),
    });
    expect(() => resolvePromptInput()).toThrow(/incompatible/);
  });
});

describe("resolvePayload — string prompt defaults", () => {
  it("applies fallbacks when no inputs / repo settings are configured", () => {
    setInputs({});
    vi.stubEnv("GITHUB_ACTOR", "alice");
    vi.stubEnv("GITHUB_WORKSPACE", undefined);

    const payload = resolvePayload("hello world", makeRepoSettings());

    expect(payload).toMatchObject({
      "~terramend": true,
      version: packageJson.version,
      model: undefined,
      mode: undefined,
      prompt: "hello world",
      triggerer: "alice",
      event: { trigger: "unknown" },
      push: "restricted",
      shell: "restricted",
      gitleaks: false,
      terratest: false,
      remediationCommand: null,
    });
    expect(payload.cwd).toBeUndefined();
    expect(payload.scanScope).toBeUndefined();
    expect(payload.maxPrs).toBeUndefined();
    expect(payload.allowedPaths).toBeUndefined();
    expect(payload.baseBranch).toBeUndefined();
    expect(payload.allowReplace).toBeUndefined();
  });

  it.each([
    "terramend[bot]",
    "terramenddev",
  ])("suppresses the triggerer when GITHUB_ACTOR is %s", (actor) => {
    setInputs({});
    vi.stubEnv("GITHUB_ACTOR", actor);

    const payload = resolvePayload("hello", makeRepoSettings());
    expect(payload.triggerer).toBeUndefined();
  });

  it("rejects an invalid enum input (push) at schema-assert time", () => {
    setInputs({ push: "bogus" });
    expect(() => resolvePayload("hello", makeRepoSettings())).toThrow();
  });
});

describe("resolvePayload — JSON payload precedence", () => {
  const jsonInput = JsonPayload.assert({
    "~terramend": true,
    version: "9.9.9",
    model: "anthropic/payload-model",
    prompt: "from payload",
    triggerer: "bob",
    eventInstructions: "follow the dispatch notes",
    previousRunsNote: "ran twice before",
    event: { trigger: "unknown", authorPermission: "write" },
    timeout: "5m",
    progressComment: { id: "42", type: "issue" },
    generateSummary: true,
  });

  it("prefers payload fields over inputs and the actor env", () => {
    setInputs({ model: "anthropic/input-model" });
    vi.stubEnv("GITHUB_ACTOR", "alice");

    const payload = resolvePayload(jsonInput, makeRepoSettings({ model: "repo-model" }));

    expect(payload.version).toBe("9.9.9");
    expect(payload.model).toBe("anthropic/payload-model");
    expect(payload.prompt).toBe("from payload");
    expect(payload.triggerer).toBe("bob");
    expect(payload.eventInstructions).toBe("follow the dispatch notes");
    expect(payload.previousRunsNote).toBe("ran twice before");
    expect(payload.event).toEqual({ trigger: "unknown", authorPermission: "write" });
    expect(payload.timeout).toBe("5m");
    expect(payload.progressComment).toEqual({ id: "42", type: "issue" });
    expect(payload.generateSummary).toBe(true);
  });

  it("lets the timeout input override the payload timeout", () => {
    setInputs({ timeout: "30m" });
    const payload = resolvePayload(jsonInput, makeRepoSettings());
    expect(payload.timeout).toBe("30m");
  });

  it("falls back model: input over repo settings when the payload has none", () => {
    const noModel = JsonPayload.assert({
      "~terramend": true,
      version: "9.9.9",
      prompt: "p",
    });

    setInputs({ model: "anthropic/input-model" });
    expect(resolvePayload(noModel, makeRepoSettings({ model: "repo-model" })).model).toBe(
      "anthropic/input-model",
    );

    setInputs({});
    expect(resolvePayload(noModel, makeRepoSettings({ model: "repo-model" })).model).toBe(
      "repo-model",
    );
  });
});

describe("resolvePayload — shell permission resolution", () => {
  const collaboratorEvent = JsonPayload.assert({
    "~terramend": true,
    version: "1.0.0",
    prompt: "p",
    event: { trigger: "unknown", authorPermission: "write" },
  });

  it("keeps repo-enabled shell for a collaborator with no input", () => {
    setInputs({});
    const payload = resolvePayload(collaboratorEvent, makeRepoSettings({ shell: "enabled" }));
    expect(payload.shell).toBe("enabled");
  });

  it("downgrades enabled to restricted for non-collaborators", () => {
    setInputs({});
    const payload = resolvePayload("plain prompt", makeRepoSettings({ shell: "enabled" }));
    expect(payload.shell).toBe("restricted");
  });

  it("lets the input disable the shell outright", () => {
    setInputs({ shell: "disabled" });
    const payload = resolvePayload(collaboratorEvent, makeRepoSettings({ shell: "enabled" }));
    expect(payload.shell).toBe("disabled");
  });

  it("lets a restricted input tighten an enabled repo setting", () => {
    setInputs({ shell: "restricted" });
    const payload = resolvePayload(collaboratorEvent, makeRepoSettings({ shell: "enabled" }));
    expect(payload.shell).toBe("restricted");
  });

  it("never loosens: restricted input cannot upgrade a disabled repo setting", () => {
    setInputs({ shell: "restricted" });
    const payload = resolvePayload(collaboratorEvent, makeRepoSettings({ shell: "disabled" }));
    expect(payload.shell).toBe("disabled");
  });

  it("prefers the push input over the repo setting", () => {
    setInputs({ push: "enabled" });
    const payload = resolvePayload("p", makeRepoSettings({ push: "disabled" }));
    expect(payload.push).toBe("enabled");
  });
});

describe("resolvePayload — cwd resolution", () => {
  it("keeps an absolute cwd input as-is", () => {
    const absolute = resolve("infra");
    expect(isAbsolute(absolute)).toBe(true);
    setInputs({ cwd: absolute });
    expect(resolvePayload("p", makeRepoSettings()).cwd).toBe(absolute);
  });

  it("resolves a relative cwd against GITHUB_WORKSPACE", () => {
    const workspace = resolve("workspace-root");
    vi.stubEnv("GITHUB_WORKSPACE", workspace);
    setInputs({ cwd: "modules/network" });
    expect(resolvePayload("p", makeRepoSettings()).cwd).toBe(resolve(workspace, "modules/network"));
  });

  it("returns the relative cwd untouched when no workspace is set", () => {
    vi.stubEnv("GITHUB_WORKSPACE", undefined);
    setInputs({ cwd: "modules/network" });
    expect(resolvePayload("p", makeRepoSettings()).cwd).toBe("modules/network");
  });

  it("falls back to GITHUB_WORKSPACE when cwd is unset", () => {
    const workspace = resolve("workspace-root");
    vi.stubEnv("GITHUB_WORKSPACE", workspace);
    setInputs({});
    expect(resolvePayload("p", makeRepoSettings()).cwd).toBe(workspace);
  });
});

describe("resolvePayload — Terraform remediation inputs", () => {
  it("parses every remediation input through its dedicated parser", () => {
    setInputs({
      scan_scope: " DIFF ",
      severity_threshold: " HIGH ",
      max_prs: "3",
      allowed_paths: " modules/**, envs/prod/** ,",
      protected_paths: "iam/**",
      autonomy_threshold: "low",
      gitleaks: "Yes",
      cost_increase_block_usd: "12.5",
      module_catalogue: "raw catalogue text",
      terratest: "on",
      base_branch: "refs/heads/release/1.2",
      allow_replace: "aws_db_instance.main, aws_s3_bucket.* ,",
      tools_enabled: "all, -trivy",
      module_fetch_token: "ghp_moduletoken",
    });

    const payload = resolvePayload("p", makeRepoSettings());

    expect(payload.scanScope).toBe("diff");
    expect(payload.severityThreshold).toBe("high");
    expect(payload.maxPrs).toBe(3);
    expect(payload.allowedPaths).toEqual(["modules/**", "envs/prod/**"]);
    expect(payload.protectedPaths).toEqual(["iam/**"]);
    expect(payload.autonomyThreshold).toBe("low");
    expect(payload.gitleaks).toBe(true);
    expect(payload.costIncreaseBlockUsd).toBe(12.5);
    expect(payload.moduleCatalogue).toBe("raw catalogue text");
    expect(payload.terratest).toBe(true);
    expect(payload.baseBranch).toBe("release/1.2");
    expect(payload.allowReplace).toEqual(["aws_db_instance.main", "aws_s3_bucket.*"]);
    // §1.5 — the unified tool-selection list parses into a directive…
    expect(payload.toolsEnabled?.base).toBe("all");
    expect(payload.toolsEnabled?.explicit.get("trivy")).toBe(false);
    // …and the scoped module-fetch token is carried verbatim.
    expect(payload.moduleFetchToken).toBe("ghp_moduletoken");
  });

  it("degrades invalid remediation inputs to undefined / false", () => {
    setInputs({
      scan_scope: "everything",
      severity_threshold: "catastrophic",
      max_prs: "0",
      allowed_paths: " , ",
      autonomy_threshold: "",
      gitleaks: "nope",
      cost_increase_block_usd: "-3",
      terratest: "off",
    });

    const payload = resolvePayload("p", makeRepoSettings());

    expect(payload.scanScope).toBeUndefined();
    expect(payload.severityThreshold).toBeUndefined();
    expect(payload.maxPrs).toBeUndefined();
    expect(payload.allowedPaths).toBeUndefined();
    expect(payload.autonomyThreshold).toBeUndefined();
    expect(payload.gitleaks).toBe(false);
    expect(payload.costIncreaseBlockUsd).toBeUndefined();
    expect(payload.terratest).toBe(false);
  });

  it("treats non-numeric max_prs and cost inputs as unset", () => {
    setInputs({ max_prs: "many", cost_increase_block_usd: "free" });
    const payload = resolvePayload("p", makeRepoSettings());
    expect(payload.maxPrs).toBeUndefined();
    expect(payload.costIncreaseBlockUsd).toBeUndefined();
  });

  it("pins a built-in mode from the mode input (case-insensitive)", () => {
    setInputs({ mode: "remediate" });
    expect(resolvePayload("p", makeRepoSettings()).mode).toBe("Remediate");
  });
});

describe("resolveOutputSchema", () => {
  it("returns undefined when the input is unset", () => {
    setInputs({});
    expect(resolveOutputSchema()).toBeUndefined();
  });

  it("throws on invalid JSON", () => {
    setInputs({ output_schema: "{nope" });
    expect(() => resolveOutputSchema()).toThrow(/not valid JSON/);
  });

  it("throws on a JSON array", () => {
    setInputs({ output_schema: "[1,2]" });
    expect(() => resolveOutputSchema()).toThrow(/must be a JSON object/);
  });

  it("throws on JSON null", () => {
    setInputs({ output_schema: "null" });
    expect(() => resolveOutputSchema()).toThrow(/must be a JSON object/);
  });

  it("returns the parsed schema object", () => {
    setInputs({ output_schema: '{"type":"object","required":["result"]}' });
    expect(resolveOutputSchema()).toEqual({ type: "object", required: ["result"] });
  });
});
