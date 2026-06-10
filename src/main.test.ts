import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agents } from "#app/agents/index";
import type { Agent, AgentResult, AgentRunContext } from "#app/agents/shared";
import { main } from "#app/main";
import { reportProgress } from "#app/mcp/comment";
import { startInstallation } from "#app/mcp/dependencies";
import { startMcpHttpServer, type ToolContext } from "#app/mcp/server";
import type { ToolState } from "#app/toolState";
import { resolveAgent, resolveModel } from "#app/utils/agent";
import { validateAgentApiKey } from "#app/utils/apiKeys";
import { isBackendConfigured } from "#app/utils/apiUrl";
import { resolveBody } from "#app/utils/body";
import {
  buildUnavailableModelError,
  hasProviderKeyForModel,
  selectFallbackModelIfNeeded,
} from "#app/utils/byokFallback";
import { log } from "#app/utils/cli";
import { installCodexAuth, TERRAMEND_DATA_DIR } from "#app/utils/codexHome";
import { recordDiffReadFromToolUse } from "#app/utils/diffCoverage";
import { onExitSignal } from "#app/utils/exitHandler";
import { resolveGit } from "#app/utils/gitAuth";
import { writeGitHubUsageSummaryToFile } from "#app/utils/github";
import { persistLearnings, seedLearningsFile } from "#app/utils/learnings";
import { executeLifecycleHook } from "#app/utils/lifecycle";
import { normalizeEnv } from "#app/utils/normalizeEnv";
import { captureAuthorizedModels, captureBaselineModels } from "#app/utils/openCodeModels";
import { applyOverrides } from "#app/utils/overrides";
import { ensurePackageManager, resolvePackageManagerSpec } from "#app/utils/packageManager";
import { aggregateUsage, patchWorkflowRunFields } from "#app/utils/patchWorkflowRunFields";
import { type ResolvedPayload, resolveOutputSchema, resolvePayload } from "#app/utils/payload";
import { fetchPreviousSnapshot, persistSummary, seedSummaryFile } from "#app/utils/prSummary";
import { handleAgentResult } from "#app/utils/run";
import { type RunContextData, resolveRunContextData } from "#app/utils/runContextData";
import { renderRunError } from "#app/utils/runErrorRenderer";
import {
  finalizeSuccessRun,
  persistRunArtifacts,
  writeRunErrorOutputs,
} from "#app/utils/runLifecycle";
import { setEnvAllowlist } from "#app/utils/secrets";
import { setupGit, wipeRunnerLeakSurface } from "#app/utils/setup";
import { killTrackedChildren } from "#app/utils/subprocess";
import { createTodoTracker, type TodoTracker } from "#app/utils/todoTracking";
import {
  cleanupVertexCredentials,
  materializeVertexCredentials,
  type VertexCredentials,
} from "#app/utils/vertex";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false), readdirSync: vi.fn(() => []) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async () => "seed-bytes") };
});
vi.mock("#app/agents/index", () => ({
  agents: {
    claude: { name: "claude", install: vi.fn(async () => "/tmp/claude-cli"), run: vi.fn() },
    opencode: {
      name: "opencode",
      install: vi.fn(async () => "/tmp/opencode-cli"),
      run: vi.fn(),
    },
  },
}));
vi.mock("#app/mcp/comment", () => ({ reportProgress: vi.fn(async () => {}) }));
vi.mock("#app/mcp/dependencies", () => ({ startInstallation: vi.fn() }));
vi.mock("#app/mcp/server", () => ({
  startMcpHttpServer: vi.fn(async () => ({
    url: "http://127.0.0.1:7777/mcp",
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  })),
}));
vi.mock("#app/modes", () => ({ computeModes: vi.fn(() => []) }));
vi.mock("#app/utils/activity", () => ({
  AGENT_ACTIVITY_TIMEOUT_MS: 900_000,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS: 5_000,
  createProcessOutputActivityTimeout: vi.fn(() => ({
    promise: new Promise<never>(() => {}),
    stop: vi.fn(),
    forceReject: vi.fn(),
  })),
}));
vi.mock("#app/utils/agent", () => ({ resolveAgent: vi.fn(), resolveModel: vi.fn() }));
vi.mock("#app/utils/apiKeys", () => ({ validateAgentApiKey: vi.fn() }));
vi.mock("#app/utils/apiUrl", () => ({ isBackendConfigured: vi.fn(() => false) }));
vi.mock("#app/utils/body", () => ({ resolveBody: vi.fn(async () => null) }));
vi.mock("#app/utils/byokFallback", () => ({
  buildUnavailableModelError: vi.fn(() => "unavailable-error"),
  hasProviderKeyForModel: vi.fn(() => false),
  selectFallbackModelIfNeeded: vi.fn(() => ({ kind: "use-resolved" })),
}));
vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    box: vi.fn(),
    group: vi.fn((_title: string, fn?: () => void) => fn?.()),
  },
}));
vi.mock("#app/utils/codexHome", () => ({
  installCodexAuth: vi.fn(),
  TERRAMEND_DATA_DIR: "/var/lib/terramend",
}));
vi.mock("#app/utils/diffCoverage", () => ({ recordDiffReadFromToolUse: vi.fn(() => false) }));
vi.mock("#app/utils/exitHandler", () => ({ onExitSignal: vi.fn(() => () => {}) }));
vi.mock("#app/utils/gitAuth", () => ({ resolveGit: vi.fn(), setGitAuthServer: vi.fn() }));
vi.mock("#app/utils/gitAuthServer", () => ({
  startGitAuthServer: vi.fn(async () => ({
    port: 1,
    register: vi.fn(() => "code"),
    revoke: vi.fn(),
    writeAskpassScript: vi.fn(() => "/tmp/askpass"),
    close: vi.fn(async () => {}),
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  })),
}));
vi.mock("#app/utils/github", () => ({
  createOctokit: vi.fn(() => ({})),
  writeGitHubUsageSummaryToFile: vi.fn(async () => {}),
}));
vi.mock("#app/utils/instructions", () => ({
  resolveInstructions: vi.fn(() => ({
    full: "FULL PROMPT",
    system: "",
    user: "USER REQUEST BODY",
    eventInstructions: "",
    event: "EVENT INSTRUCTIONS",
    runtime: "",
  })),
}));
vi.mock("#app/utils/learnings", () => ({
  persistLearnings: vi.fn(async () => {}),
  seedLearningsFile: vi.fn(async () => "/tmp/learnings.md"),
}));
vi.mock("#app/utils/lifecycle", () => ({
  describeSetupFailure: vi.fn(() => ""),
  executeLifecycleHook: vi.fn(async () => ({})),
}));
vi.mock("#app/utils/normalizeEnv", () => ({ normalizeEnv: vi.fn() }));
vi.mock("#app/utils/openCodeModels", () => ({
  captureAuthorizedModels: vi.fn(),
  captureBaselineModels: vi.fn(),
  getAuthorizedModels: vi.fn(() => new Set<string>()),
}));
vi.mock("#app/utils/overrides", () => ({
  applyOverrides: vi.fn(() => ({ applied: [], denied: [] })),
}));
vi.mock("#app/utils/packageManager", () => ({
  ensurePackageManager: vi.fn(async () => true),
  packageManagerBinDir: vi.fn((tmpdir: string) => `${tmpdir}/pm-bin`),
  resolvePackageManagerSpec: vi.fn(async () => null),
}));
vi.mock("#app/utils/patchWorkflowRunFields", () => ({
  aggregateUsage: vi.fn(() => ({})),
  patchWorkflowRunFields: vi.fn(async () => {}),
}));
vi.mock("#app/utils/payload", () => ({
  Inputs: {},
  resolveOutputSchema: vi.fn(() => undefined),
  resolvePayload: vi.fn(),
  resolvePromptInput: vi.fn(() => "plain text prompt"),
}));
vi.mock("#app/utils/prSummary", () => ({
  fetchPreviousSnapshot: vi.fn(async () => null),
  persistSummary: vi.fn(async () => {}),
  seedSummaryFile: vi.fn(async () => "/tmp/summary.md"),
}));
vi.mock("#app/utils/run", () => ({
  handleAgentResult: vi.fn(async () => ({ success: true })),
}));
vi.mock("#app/utils/runContextData", () => ({ resolveRunContextData: vi.fn() }));
vi.mock("#app/utils/runErrorRenderer", () => ({
  renderRunError: vi.fn(() => ({ summary: "rendered-summary", comment: "rendered-comment" })),
}));
vi.mock("#app/utils/runLifecycle", () => ({
  finalizeSuccessRun: vi.fn(async () => {}),
  persistRunArtifacts: vi.fn(async () => {}),
  writeRunErrorOutputs: vi.fn(async () => {}),
}));
vi.mock("#app/utils/runStartupLog", () => ({ logRunStartup: vi.fn() }));
vi.mock("#app/utils/secrets", () => ({ setEnvAllowlist: vi.fn() }));
vi.mock("#app/utils/setup", () => ({
  createTempDirectory: vi.fn(() => "/tmp/terramend-test"),
  setupGit: vi.fn(async () => {}),
  wipeRunnerLeakSurface: vi.fn(),
}));
vi.mock("#app/utils/subprocess", () => ({ killTrackedChildren: vi.fn() }));
vi.mock("#app/utils/todoTracking", () => ({
  createTodoTracker: vi.fn(() => ({
    update: vi.fn(),
    flush: vi.fn(async () => {}),
    cancel: vi.fn(),
    settled: vi.fn(async () => {}),
    completeInProgress: vi.fn(),
    renderCollapsible: vi.fn(() => ""),
    enabled: true,
    hasPublished: false,
  })),
}));
vi.mock("#app/utils/token", () => ({
  getJobToken: vi.fn(() => "job-token"),
  resolveTokens: vi.fn(async () => ({
    gitToken: "git-token",
    mcpToken: "mcp-token",
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  })),
}));
vi.mock("#app/utils/vertex", () => ({
  cleanupVertexCredentials: vi.fn(),
  materializeVertexCredentials: vi.fn(() => undefined),
}));
vi.mock("#app/utils/workflow", () => ({ resolveRun: vi.fn(async () => ({ runId: 42 })) }));

function makePayload(overrides: Record<string, unknown> = {}): ResolvedPayload {
  return {
    "~terramend": true,
    version: "0.0.0",
    model: undefined,
    mode: undefined,
    prompt: "do the thing",
    triggerer: "octocat",
    event: { trigger: "workflow_dispatch" },
    timeout: undefined,
    cwd: undefined,
    progressComment: undefined,
    generateSummary: undefined,
    push: "restricted",
    shell: "restricted",
    ...overrides,
  } as unknown as ResolvedPayload;
}

function makeRunContext(
  settings: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): RunContextData {
  return {
    repo: { owner: "octo", name: "repo", data: {} },
    repoSettings: {
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
      ...settings,
    },
    apiToken: "api-token",
    oss: false,
    plan: "none",
    ...overrides,
  } as unknown as RunContextData;
}

function makeAgent(
  name: "claude" | "opencode",
  run?: (params: AgentRunContext) => Promise<AgentResult>,
): Agent {
  return {
    name,
    install: vi.fn(async () => "/tmp/agent-cli"),
    run: vi.fn(run ?? (async () => ({ success: true }))),
  } as unknown as Agent;
}

function getToolContext(): ToolContext {
  const call = vi.mocked(startMcpHttpServer).mock.calls[0];
  if (!call) throw new Error("startMcpHttpServer was not called");
  return call[0];
}

function getToolState(): ToolState {
  return getToolContext().toolState;
}

function lastRunParams(agent: Agent): AgentRunContext {
  const call = vi.mocked(agent.run).mock.calls[0];
  if (!call) throw new Error("agent.run was not called");
  return call[0];
}

async function fireExitHandlers(): Promise<void> {
  for (const call of vi.mocked(onExitSignal).mock.calls) {
    await call[0]("SIGTERM");
  }
}

let agent: Agent;

beforeEach(() => {
  vi.spyOn(process, "chdir").mockImplementation(() => {});
  agent = makeAgent("opencode");
  vi.mocked(resolveAgent).mockReturnValue(agent);
  vi.mocked(resolveModel).mockImplementation(({ slug }) => slug);
  vi.mocked(resolvePayload).mockReturnValue(makePayload());
  vi.mocked(resolveRunContextData).mockResolvedValue(makeRunContext());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("main – happy path", () => {
  it("orchestrates a successful run end to end", async () => {
    const result = await main();

    expect(result).toEqual({ success: true });
    expect(normalizeEnv).toHaveBeenCalledOnce();
    expect(resolveGit).toHaveBeenCalledOnce();
    expect(agents.opencode.install).toHaveBeenCalledOnce();
    expect(captureBaselineModels).toHaveBeenCalledWith("/tmp/opencode-cli");
    expect(installCodexAuth).toHaveBeenCalledOnce();
    expect(captureAuthorizedModels).toHaveBeenCalledWith("/tmp/opencode-cli");
    expect(wipeRunnerLeakSurface).toHaveBeenCalledOnce();
    expect(setupGit).toHaveBeenCalledOnce();
    expect(executeLifecycleHook).toHaveBeenCalledWith({
      event: "setup",
      script: null,
      normalizeWorkingTreeAfter: true,
    });
    expect(startInstallation).toHaveBeenCalledWith(getToolContext());
    expect(finalizeSuccessRun).toHaveBeenCalledOnce();
    expect(handleAgentResult).toHaveBeenCalledOnce();
    expect(killTrackedChildren).toHaveBeenCalled();
    expect(cleanupVertexCredentials).toHaveBeenCalledWith(undefined);
    // model undefined → provider-key probe is skipped, gate sees false
    expect(hasProviderKeyForModel).not.toHaveBeenCalled();
    // empty usage patch → no workflow-run PATCH
    expect(patchWorkflowRunFields).not.toHaveBeenCalled();
    // mcp url is written back onto the shared tool context
    expect(getToolContext().mcpServerUrl).toBe("http://127.0.0.1:7777/mcp");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("MCP server started at"));
  });

  it("applies env overrides when UNSAFE_OVERRIDES is set", async () => {
    vi.stubEnv("UNSAFE_OVERRIDES", '{"FOO":"1"}');
    vi.mocked(applyOverrides).mockReturnValueOnce({ applied: ["FOO"], denied: ["GITHUB_TOKEN"] });

    await main();

    expect(applyOverrides).toHaveBeenCalledWith({ raw: '{"FOO":"1"}', env: process.env });
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("applied 1 env override(s): FOO"),
    );
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("refused to override 1 protected env var(s): GITHUB_TOKEN"),
    );
  });

  it("registers a usage-summary exit handler and writes the summary in finally", async () => {
    vi.stubEnv("TERRAMEND_USAGE_SUMMARY_PATH", "/tmp/usage.json");

    const result = await main();

    expect(result.success).toBe(true);
    expect(onExitSignal).toHaveBeenCalled();
    expect(writeGitHubUsageSummaryToFile).toHaveBeenCalledWith("/tmp/usage.json");
    await fireExitHandlers();
    expect(vi.mocked(writeGitHubUsageSummaryToFile).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("logs instead of failing when the finally usage-summary write rejects", async () => {
    vi.stubEnv("TERRAMEND_USAGE_SUMMARY_PATH", "/tmp/usage.json");
    vi.mocked(writeGitHubUsageSummaryToFile).mockRejectedValueOnce(new Error("ENOSPC"));

    const result = await main();

    expect(result.success).toBe(true);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("failed to write usage summary to /tmp/usage.json: ENOSPC"),
    );
  });

  it("configures the env allowlist from repo settings", async () => {
    vi.mocked(resolveRunContextData).mockResolvedValueOnce(
      makeRunContext({ envAllowlist: "FOO,BAR" }),
    );

    await main();

    expect(setEnvAllowlist).toHaveBeenCalledWith("FOO,BAR");
  });

  it("records before_sha on pull_request_synchronize triggers", async () => {
    vi.mocked(resolvePayload).mockReturnValue(
      makePayload({
        event: { trigger: "pull_request_synchronize", is_pr: true, before_sha: "abc123" },
      }),
    );

    await main();

    expect(getToolState().beforeSha).toBe("abc123");
  });

  it("chdirs into payload.cwd when it differs from the current directory", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ cwd: "/somewhere/else" }));

    await main();

    expect(process.chdir).toHaveBeenCalledWith("/somewhere/else");
  });

  it("substitutes the resolved body into the event and prompt", async () => {
    const payload = makePayload({
      prompt: "Request: original body",
      event: { trigger: "issues_opened", issue_number: 3, body: "original body" },
    });
    vi.mocked(resolvePayload).mockReturnValue(payload);
    vi.mocked(resolveBody).mockResolvedValueOnce("resolved body");

    await main();

    expect(payload.event.body).toBe("resolved body");
    expect(payload.prompt).toBe("Request: resolved body");
  });

  it("clears OIDC env vars when shell is not enabled", async () => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "tok");

    await main();

    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
  });

  it("keeps OIDC env vars when shell is enabled", async () => {
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://oidc");
    vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "tok");
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ shell: "enabled" }));

    await main();

    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("https://oidc");
    expect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("tok");
  });
});

describe("main – BYOK model gate", () => {
  it("passes resolveAgent({model: initialResolvedModel}).name into the gate", async () => {
    const claudeAgent = makeAgent("claude");
    vi.mocked(resolveAgent).mockReturnValue(claudeAgent);
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "anthropic/claude-opus" }));

    await main();

    expect(vi.mocked(resolveAgent).mock.calls[0]).toEqual([{ model: "anthropic/claude-opus" }]);
    expect(selectFallbackModelIfNeeded).toHaveBeenCalledWith({
      resolvedModel: "anthropic/claude-opus",
      authorized: expect.any(Set),
      providerKeyPresent: false,
      agentName: "claude",
    });
  });

  it("probes the provider key for the resolved model", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "openai/gpt-6" }));
    vi.mocked(hasProviderKeyForModel).mockReturnValueOnce(true);

    await main();

    expect(hasProviderKeyForModel).toHaveBeenCalledWith("openai/gpt-6");
    expect(selectFallbackModelIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ providerKeyPresent: true }),
    );
  });

  it("validates the agent api key on the use-resolved path", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "openai/gpt-6" }));

    await main();

    expect(validateAgentApiKey).toHaveBeenCalledWith({
      agent,
      model: "openai/gpt-6",
      authorized: expect.any(Set),
      owner: "octo",
      name: "repo",
    });
  });

  it("falls back to the free model with a warning and records modelFallback", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "google/gemini-3" }));
    vi.mocked(selectFallbackModelIfNeeded).mockReturnValueOnce({
      kind: "fallback",
      from: "google/gemini-3",
      to: "opencode/big-pickle",
    });

    const result = await main();

    expect(result.success).toBe(true);
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("fell back from google/gemini-3 to opencode/big-pickle"),
    );
    expect(getToolState().modelFallback).toEqual({ from: "google/gemini-3" });
    expect(getToolState().model).toBe("opencode/big-pickle");
    // fallback slug must NOT be re-resolved (TERRAMEND_MODEL would override it)
    expect(resolveModel).toHaveBeenCalledTimes(1);
    expect(resolveModel).toHaveBeenCalledWith({ slug: "google/gemini-3" });
    // validation is skipped — the gate already authorized the fallback model
    expect(validateAgentApiKey).not.toHaveBeenCalled();
    // the agent runs with the fallback model
    expect(lastRunParams(agent).resolvedModel).toBe("opencode/big-pickle");
    expect(vi.mocked(resolveAgent).mock.calls[1]).toEqual([{ model: "opencode/big-pickle" }]);
  });

  it("fails loudly when the model is unavailable to the present key", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "google/wrong-id" }));
    vi.mocked(selectFallbackModelIfNeeded).mockReturnValueOnce({
      kind: "unavailable",
      model: "google/wrong-id",
    });

    const result = await main();

    expect(result).toEqual({ success: false, error: "unavailable-error" });
    expect(buildUnavailableModelError).toHaveBeenCalledWith({
      model: "google/wrong-id",
      authorized: expect.any(Set),
    });
    expect(agent.run).not.toHaveBeenCalled();
    // toolContext was never built → no artifact persistence on this path
    expect(persistRunArtifacts).not.toHaveBeenCalled();
    expect(renderRunError).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: "unavailable-error" }),
    );
    expect(writeRunErrorOutputs).toHaveBeenCalledOnce();
  });

  it("materializes vertex credentials and denies their dir to the agent", async () => {
    const creds = { secretDir: "/tmp/vertex-secret" } as unknown as VertexCredentials;
    vi.mocked(materializeVertexCredentials).mockReturnValueOnce(creds);
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ model: "google/gemini-3" }));

    await main();

    expect(materializeVertexCredentials).toHaveBeenCalledWith({ model: "google/gemini-3" });
    expect(lastRunParams(agent).secretDenyPaths).toEqual([
      TERRAMEND_DATA_DIR,
      "/tmp/vertex-secret",
    ]);
    expect(cleanupVertexCredentials).toHaveBeenCalledWith(creds);
  });
});

describe("main – setup hook and package manager", () => {
  it("warns when the setup hook fails but the run continues", async () => {
    vi.mocked(executeLifecycleHook).mockResolvedValueOnce({
      warning: "setup hook failed: boom",
      failure: { kind: "exit", exitCode: 1, output: "boom" },
    } as unknown as Awaited<ReturnType<typeof executeLifecycleHook>>);

    const result = await main();

    expect(result.success).toBe(true);
    expect(log.warning).toHaveBeenCalledWith("setup hook failed: boom");
  });

  it("pins the resolved package manager into the private bin dir", async () => {
    const spec = { name: "pnpm", version: "11.0.0" } as unknown as Awaited<
      ReturnType<typeof resolvePackageManagerSpec>
    >;
    vi.mocked(resolvePackageManagerSpec).mockResolvedValueOnce(spec);

    await main();

    expect(ensurePackageManager).toHaveBeenCalledWith({
      spec,
      binDir: "/tmp/terramend-test/pm-bin",
    });
  });
});

describe("main – learnings and summary seeding", () => {
  it("seeds the learnings file when a backend is configured", async () => {
    vi.mocked(isBackendConfigured).mockReturnValueOnce(true);
    vi.mocked(resolveRunContextData).mockResolvedValueOnce(
      makeRunContext({ learnings: "  existing learnings  " }),
    );

    await main();

    expect(seedLearningsFile).toHaveBeenCalledWith({
      tmpdir: "/tmp/terramend-test",
      current: "  existing learnings  ",
    });
    expect(getToolState().learningsFilePath).toBe("/tmp/learnings.md");
    expect(getToolState().learningsSeed).toBe("existing learnings");
    await fireExitHandlers();
    expect(persistLearnings).toHaveBeenCalledWith(getToolContext());
  });

  it("continues with a warning when learnings seeding fails", async () => {
    vi.mocked(isBackendConfigured).mockReturnValueOnce(true);
    vi.mocked(seedLearningsFile).mockRejectedValueOnce(new Error("ENOSPC"));

    const result = await main();

    expect(result.success).toBe(true);
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("learnings seed failed: ENOSPC"),
    );
    expect(getToolState().learningsFilePath).toBeUndefined();
  });

  it("skips learnings seeding without a configured backend", async () => {
    await main();

    expect(seedLearningsFile).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("no backend configured"));
  });

  it("seeds the PR summary file when generateSummary is requested", async () => {
    vi.mocked(resolvePayload).mockReturnValue(
      makePayload({
        generateSummary: true,
        event: { trigger: "pull_request_opened", is_pr: true, issue_number: 7 },
      }),
    );
    vi.mocked(fetchPreviousSnapshot).mockResolvedValueOnce("previous snapshot");

    await main();

    expect(fetchPreviousSnapshot).toHaveBeenCalledWith(getToolContext(), 7);
    expect(seedSummaryFile).toHaveBeenCalledWith({
      tmpdir: "/tmp/terramend-test",
      previousSnapshot: "previous snapshot",
    });
    expect(getToolState().summaryFilePath).toBe("/tmp/summary.md");
    expect(getToolState().summarySeed).toBe("seed-bytes");
    await fireExitHandlers();
    expect(persistSummary).toHaveBeenCalledWith(getToolContext());
  });

  it("leaves summarySeed undefined when the seed read-back fails", async () => {
    vi.mocked(resolvePayload).mockReturnValue(
      makePayload({
        generateSummary: true,
        event: { trigger: "pull_request_opened", is_pr: true, issue_number: 7 },
      }),
    );
    vi.mocked(readFile).mockRejectedValueOnce(new Error("EACCES"));

    await main();

    expect(getToolState().summaryFilePath).toBe("/tmp/summary.md");
    expect(getToolState().summarySeed).toBeUndefined();
  });
});

describe("main – agent run plumbing", () => {
  it("awaits dependency installation when .opencode/plugin files exist", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(["plugin.ts"] as unknown as ReturnType<
      typeof readdirSync
    >);
    vi.mocked(startInstallation).mockImplementationOnce((ctx: ToolContext) => {
      ctx.toolState.dependencyInstallation = {
        status: "in_progress",
        promise: Promise.resolve([]),
        results: undefined,
      };
    });

    await main();

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining(".opencode/plugin/ detected — awaiting dependency installation"),
    );
  });

  it("tracks diff coverage from agent tool-use events", async () => {
    agent = makeAgent("opencode", async (params) => {
      params.onToolUse?.({ toolName: "Read", input: { file_path: "/x" } });
      params.onToolUse?.({ toolName: "Bash", input: {} });
      return { success: true };
    });
    vi.mocked(resolveAgent).mockReturnValue(agent);
    vi.mocked(recordDiffReadFromToolUse).mockReturnValueOnce(true);

    await main();

    expect(recordDiffReadFromToolUse).toHaveBeenCalledTimes(2);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("diff coverage tracked from tool Read"),
    );
  });

  it("reports todo-tracker progress and survives report failures", async () => {
    await main();

    const call = vi.mocked(createTodoTracker).mock.calls[0];
    if (!call) throw new Error("createTodoTracker was not called");
    const onUpdate = call[0];

    await onUpdate("- [ ] item");
    expect(reportProgress).toHaveBeenCalledWith(getToolContext(), {
      body: "- [ ] item",
      liveProgress: true,
    });

    vi.mocked(reportProgress).mockRejectedValueOnce(new Error("github down"));
    await onUpdate("- [x] item");
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("progress update failed"));
  });

  it("stops the MCP server once when the inner activity timeout fires", async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(startMcpHttpServer).mockResolvedValueOnce({
      url: "http://127.0.0.1:7777/mcp",
      [Symbol.asyncDispose]: dispose,
    });
    agent = makeAgent("opencode", async (params) => {
      params.onActivityTimeout?.();
      params.onActivityTimeout?.(); // second call must be a no-op
      return { success: true };
    });
    vi.mocked(resolveAgent).mockReturnValue(agent);

    const result = await main();

    expect(result.success).toBe(true);
    // once from the inner-timeout handler + once from the `await using` cleanup
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("inner activity timeout fired"));
  });

  it("logs when the fire-and-forget MCP stop after the inner kill fails", async () => {
    const dispose = vi.fn(async () => {});
    dispose.mockRejectedValueOnce(new Error("already closed"));
    vi.mocked(startMcpHttpServer).mockResolvedValueOnce({
      url: "http://127.0.0.1:7777/mcp",
      [Symbol.asyncDispose]: dispose,
    });
    agent = makeAgent("opencode", async (params) => {
      params.onActivityTimeout?.();
      return { success: true };
    });
    vi.mocked(resolveAgent).mockReturnValue(agent);

    await main();

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("mcp server stop after inner kill failed: already closed"),
    );
  });

  it("races only the activity timeout when --notimeout is set", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ timeout: "none" }));

    const result = await main();

    expect(result.success).toBe(true);
    expect(agent.run).toHaveBeenCalledOnce();
  });

  it("warns and falls back to 1h on an unparseable timeout", async () => {
    vi.mocked(resolvePayload).mockReturnValue(makePayload({ timeout: "bogus" }));

    const result = await main();

    expect(result.success).toBe(true);
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('invalid timeout "bogus"'));
  });

  it("fails the run when the agent exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(resolvePayload).mockReturnValue(makePayload({ timeout: "1s" }));
      agent = makeAgent("opencode", () => new Promise<never>(() => {}));
      vi.mocked(resolveAgent).mockReturnValue(agent);

      const resultPromise = main();
      await vi.advanceTimersByTimeAsync(1_001);
      const result = await resultPromise;

      expect(result).toEqual({ success: false, error: "agent run timed out after 1s" });
      expect(persistRunArtifacts).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pushes agent usage and patches the workflow run in finally", async () => {
    const usage = { agent: "opencode", inputTokens: 10, outputTokens: 4 };
    agent = makeAgent("opencode", async () => ({ success: true, usage }));
    vi.mocked(resolveAgent).mockReturnValue(agent);
    const patch = { inputTokens: "10" } as unknown as ReturnType<typeof aggregateUsage>;
    vi.mocked(aggregateUsage).mockReturnValueOnce(patch);

    await main();

    expect(aggregateUsage).toHaveBeenCalledWith([usage]);
    expect(patchWorkflowRunFields).toHaveBeenCalledWith(getToolContext(), patch);
  });

  it("throws when output_schema is set but the agent never called set_output", async () => {
    vi.mocked(resolveOutputSchema).mockReturnValueOnce({ type: "object" });

    const result = await main();

    expect(result.success).toBe(false);
    expect(result.error).toContain("output_schema was provided but agent did not call set_output");
    expect(finalizeSuccessRun).not.toHaveBeenCalled();
  });
});

describe("main – error path", () => {
  it("renders and persists when the agent run rejects after toolContext exists", async () => {
    agent = makeAgent("opencode", async () => {
      throw new Error("agent exploded");
    });
    vi.mocked(resolveAgent).mockReturnValue(agent);

    const result = await main();

    expect(result).toEqual({ success: false, error: "agent exploded" });
    expect(log.error).toHaveBeenCalledWith("agent exploded");
    expect(renderRunError).toHaveBeenCalledWith({
      errorMessage: "agent exploded",
      repo: { owner: "octo", name: "repo", data: {} },
      agentDiagnostic: undefined,
    });
    expect(writeRunErrorOutputs).toHaveBeenCalledWith({
      rendered: { summary: "rendered-summary", comment: "rendered-comment" },
      toolState: getToolState(),
    });
    expect(persistRunArtifacts).toHaveBeenCalledWith(getToolContext());
    const tracker = vi.mocked(createTodoTracker).mock.results[0]?.value as TodoTracker;
    expect(tracker.cancel).toHaveBeenCalled();
    expect(killTrackedChildren).toHaveBeenCalled();
  });

  it("skips artifact persistence when the failure precedes toolContext", async () => {
    vi.mocked(setupGit).mockRejectedValueOnce(new Error("git setup failed"));

    const result = await main();

    expect(result).toEqual({ success: false, error: "git setup failed" });
    expect(persistRunArtifacts).not.toHaveBeenCalled();
    expect(agent.run).not.toHaveBeenCalled();
  });

  it("uses a generic message for non-Error throws", async () => {
    vi.mocked(setupGit).mockRejectedValueOnce("string failure");

    const result = await main();

    expect(result).toEqual({ success: false, error: "unknown error occurred" });
  });
});
