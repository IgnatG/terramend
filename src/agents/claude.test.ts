import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentsJson,
  buildManagedSettings,
  buildStopHookScript,
  CLAUDE_EXEC_TOOL_DENY_RULES,
  claude,
  runClaude,
  stripProviderPrefix,
  tailLines,
  writeMcpConfig,
} from "#app/agents/claude";
import { startGateServer } from "#app/agents/gateServer";
import { finalizeAgentResult } from "#app/agents/postRun";
import { REVIEWER_AGENT_NAME } from "#app/agents/reviewer";
import type { AgentRunContext } from "#app/agents/shared";
import type { ToolState } from "#app/toolState";
import { preflightClaudeSubscription } from "#app/utils/claudeSubscription";
import { installFromNpmTarball } from "#app/utils/install";
import { installBundledSkills } from "#app/utils/skills";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  type SpawnOptions,
  SpawnTimeoutError,
  spawn,
} from "#app/utils/subprocess";
import type { TodoTracker } from "#app/utils/todoTracking";

// installManagedSettings shells out to sudo in CI — fake execFileSync so the
// CI=true path can be exercised without privileges (or a Linux host).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});
// the harness shells out via spawn() — fake it so tests stay subprocess-free
// and we can feed scripted NDJSON event streams. error classes stay real.
vi.mock("#app/utils/subprocess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/subprocess")>();
  return { ...actual, spawn: vi.fn() };
});
// CLI install hits the npm registry — never in unit tests.
vi.mock("#app/utils/install", () => ({
  installFromNpmTarball: vi.fn(async () => "/fake/bin/claude.exe"),
}));
// gate server binds a real HTTP port — replace with an inert handle.
vi.mock("#app/agents/gateServer", () => ({ startGateServer: vi.fn() }));
// subscription preflight makes a live Anthropic API call.
vi.mock("#app/utils/claudeSubscription", () => ({ preflightClaudeSubscription: vi.fn() }));
// finalizeAgentResult shells out to git via collectPostRunIssues — passthrough.
vi.mock("#app/agents/postRun", () => ({
  finalizeAgentResult: vi.fn(async (params: { result: unknown }) => params.result),
}));
// skills install shells out to npx.
vi.mock("#app/utils/skills", () => ({ installBundledSkills: vi.fn() }));
// terraform-mcp-server resolution probes for docker — pin it per test via the
// mutable state (a plain closure, so mock resets can't wipe the default).
const terraformMcpState = vi.hoisted(() => ({
  resolution: { kind: "disabled" } as { kind: string; command?: string; args?: string[] },
}));
vi.mock("#app/utils/terraformMcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/terraformMcp")>();
  return { ...actual, resolveTerraformMcp: () => terraformMcpState.resolution };
});

const execFileSyncMock = vi.mocked(execFileSync);
const spawnMock = vi.mocked(spawn);
const startGateServerMock = vi.mocked(startGateServer);
const preflightMock = vi.mocked(preflightClaudeSubscription);
const finalizeMock = vi.mocked(finalizeAgentResult);
const installMock = vi.mocked(installFromNpmTarball);
const installBundledSkillsMock = vi.mocked(installBundledSkills);

function makeCtx(secretDenyPaths?: string[]): AgentRunContext {
  // buildManagedSettings only reads ctx.secretDenyPaths.
  return { secretDenyPaths } as unknown as AgentRunContext;
}

function buildSettings(params?: { secretDenyPaths?: string[]; stopHookPath?: string | null }) {
  return buildManagedSettings({
    ctx: makeCtx(params?.secretDenyPaths),
    stopHookPath: params?.stopHookPath ?? null,
    pretoolGateScriptPath: "/tmp/run/terramend-pretool-gate.mjs",
  });
}

function denyRules(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions as { deny: string[] };
  return permissions.deny;
}

describe("writeMcpConfig", () => {
  function writeConfigIn(dir: string): Record<string, Record<string, unknown>> {
    const ctx = {
      tmpdir: dir,
      mcpServerUrl: "http://127.0.0.1:7777/mcp",
      payload: { terraformMcp: false },
    } as unknown as AgentRunContext;
    const path = writeMcpConfig(ctx);
    return (
      JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      }
    ).mcpServers;
  }

  it("writes only the terramend HTTP server by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "terramend-mcpconf-"));
    try {
      const servers = writeConfigIn(dir);
      expect(servers).toEqual({
        terramend: { type: "http", url: "http://127.0.0.1:7777/mcp" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds the terraform stdio server when terraform-mcp resolves available (P2.2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "terramend-mcpconf-"));
    terraformMcpState.resolution = {
      kind: "available",
      command: "docker",
      args: ["run", "-i", "--rm", "hashicorp/terraform-mcp-server:0.5.2", "--toolsets=registry"],
    };
    try {
      const servers = writeConfigIn(dir);
      expect(servers.terraform).toEqual({
        type: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", "hashicorp/terraform-mcp-server:0.5.2", "--toolsets=registry"],
      });
      expect(servers.terramend).toEqual({ type: "http", url: "http://127.0.0.1:7777/mcp" });
    } finally {
      terraformMcpState.resolution = { kind: "disabled" };
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLAUDE_EXEC_TOOL_DENY_RULES", () => {
  it("covers every native exec tool at top level and inside Agent(...) subagents", () => {
    expect([...CLAUDE_EXEC_TOOL_DENY_RULES].sort()).toEqual(
      [
        "Bash",
        "Monitor",
        "REPL",
        "Workflow",
        "Agent(Bash)",
        "Agent(Monitor)",
        "Agent(REPL)",
        "Agent(Workflow)",
      ].sort(),
    );
  });
});

describe("buildManagedSettings", () => {
  it("denies the native exec tools in permissions.deny (bypass-immune layer)", () => {
    // regression lock for the --dangerously-skip-permissions leak: the
    // cliArg-source --disallowedTools deny alone was bypassable, so every
    // exec tool MUST also appear in the managed-settings deny.
    const deny = denyRules(buildSettings());
    for (const rule of ["Bash", "Monitor", "REPL", "Workflow"]) {
      expect(deny).toContain(rule);
      expect(deny).toContain(`Agent(${rule})`);
    }
  });

  it("denies /proc and /sys for every native FS tool", () => {
    const deny = denyRules(buildSettings());
    for (const tool of ["Read", "Grep", "Edit", "Glob"]) {
      expect(deny).toContain(`${tool}(//proc/**)`);
      expect(deny).toContain(`${tool}(//sys/**)`);
    }
  });

  it("carries the blanket .git write deny and the narrow .git/config read deny", () => {
    const deny = denyRules(buildSettings());
    expect(deny).toContain("Edit(.git)");
    expect(deny).toContain("Edit(.git/**)");
    expect(deny).toContain("Edit(**/.git)");
    expect(deny).toContain("Edit(**/.git/**)");
    for (const tool of ["Read", "Grep", "Glob"]) {
      expect(deny).toContain(`${tool}(.git/config)`);
    }
  });

  it("maps every secretDenyPath onto all four FS tools and the bash sandbox", () => {
    const path = "/var/lib/terramend/opencode";
    const settings = buildSettings({ secretDenyPaths: [path] });
    const deny = denyRules(settings);
    for (const tool of ["Read", "Grep", "Edit", "Glob"]) {
      expect(deny).toContain(`${tool}(${path}/**)`);
      expect(deny).toContain(`${tool}(/${path}/**)`);
    }
    const sandbox = settings.sandbox as { filesystem: { denyRead: string[] } };
    expect(sandbox.filesystem.denyRead).toEqual(["/proc", "/sys", path]);
  });

  it("locks managed-only permission rules and hooks", () => {
    const settings = buildSettings();
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.allowManagedHooksOnly).toBe(true);
  });

  it("registers the PreToolUse gate against terramend MCP tools", () => {
    const settings = buildSettings();
    const hooks = settings.hooks as {
      PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      Stop?: unknown;
    };
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]?.matcher).toBe("^mcp__terramend__");
    expect(hooks.PreToolUse[0]?.hooks[0]?.command).toContain("terramend-pretool-gate.mjs");
    expect(hooks.Stop).toBeUndefined();
  });

  it("layers the Stop hook in when a stop hook path is provided", () => {
    const settings = buildSettings({ stopHookPath: "/tmp/run/terramend-stop-hook.sh" });
    const hooks = settings.hooks as {
      Stop: Array<{ hooks: Array<{ type: string; command: string }> }>;
    };
    expect(hooks.Stop).toEqual([
      { hooks: [{ type: "command", command: "/tmp/run/terramend-stop-hook.sh" }] },
    ]);
  });
});

describe("buildAgentsJson", () => {
  it("defines the reviewer subagent on the cheaper sibling model", () => {
    const agents = JSON.parse(buildAgentsJson()) as Record<
      string,
      { description: string; prompt: string; model: string }
    >;
    const reviewer = agents[REVIEWER_AGENT_NAME];
    expect(reviewer).toBeDefined();
    expect(reviewer?.model).toBe("claude-sonnet-4-6");
    expect(reviewer?.description).toContain("Read-only");
    expect(reviewer?.prompt.length ?? 0).toBeGreaterThan(0);
  });
});

describe("stripProviderPrefix", () => {
  it("strips the provider segment from a provider/model specifier", () => {
    expect(stripProviderPrefix("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("only strips up to the first slash", () => {
    expect(stripProviderPrefix("openrouter/moonshotai/kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
  });

  it("leaves bare model names and leading-slash specifiers unchanged", () => {
    expect(stripProviderPrefix("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(stripProviderPrefix("/weird")).toBe("/weird");
  });
});

describe("buildStopHookScript", () => {
  it("reads the gate URL/token from env and emits a block decision", () => {
    const script = buildStopHookScript();
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(script).toContain("TERRAMEND_GATE_URL");
    expect(script).toContain("TERRAMEND_GATE_TOKEN");
    expect(script).toContain('{decision: "block", reason: $reason}');
    // absent gate URL must disable the hook (non-CI local dev path).
    expect(script).toContain('if [ -z "$url" ]; then exit 0; fi');
  });
});

describe("tailLines", () => {
  it("returns short text unchanged", () => {
    expect(tailLines("hello\nworld", 100)).toBe("hello\nworld");
  });

  it("drops the partial first line from the capped tail", () => {
    expect(tailLines("aaaa\nbbbb\ncccc", 9)).toBe("cccc");
  });

  it("returns the raw tail when no newline falls inside the window", () => {
    expect(tailLines("abcdefghij", 5)).toBe("fghij");
  });

  it("returns the raw tail when the only newline is at the window start", () => {
    expect(tailLines("aaa\nbcdef", 6)).toBe("\nbcdef");
  });
});

// ── runner + agent harness ──────────────────────────────────────────────────────

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** one NDJSON line. */
function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

interface SpawnScript {
  stdout?: string[];
  stderr?: string[];
  exitCode?: number;
  reject?: Error;
}

/** drive the spawn fake: feed scripted stdout/stderr chunks, then exit. */
function scriptSpawn(script: SpawnScript): void {
  spawnMock.mockImplementation(async (options: SpawnOptions) => {
    for (const chunk of script.stdout ?? []) {
      await Promise.resolve(options.onStdout?.(chunk));
    }
    for (const chunk of script.stderr ?? []) {
      options.onStderr?.(chunk);
    }
    if (script.reject) throw script.reject;
    return { stdout: "", stderr: "", exitCode: script.exitCode ?? 0, durationMs: 5 };
  });
}

function lastSpawnOptions(): SpawnOptions {
  const call = spawnMock.mock.calls.at(-1);
  if (!call) throw new Error("spawn was never called");
  return call[0];
}

function makeTodoTracker(): TodoTracker & {
  update: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  return {
    enabled: true,
    update: vi.fn(),
    cancel: vi.fn(),
    flush: vi.fn(async () => {}),
  } as unknown as TodoTracker & {
    update: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
  };
}

function runParams(overrides?: {
  todoTracker?: TodoTracker;
  onToolUse?: (event: { toolName: string; input: unknown }) => void;
}) {
  return {
    label: "Terramend",
    cmd: "/fake/bin/claude.exe",
    args: ["--output-format", "stream-json"],
    cwd: process.cwd(),
    env: {},
    todoTracker: overrides?.todoTracker,
    onToolUse: overrides?.onToolUse,
  };
}

const successResultEvent = {
  type: "result",
  subtype: "success",
  session_id: "ses_1",
  num_turns: 3,
  total_cost_usd: 0.42,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 40,
  },
  result: "final answer",
};

describe("runClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses the NDJSON stream into output, usage, and session id", async () => {
    scriptSpawn({
      stdout: [
        line({ type: "system", subtype: "init", session_id: "ses_1", parent_tool_use_id: null }),
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "working on it" }] },
        }),
        line(successResultEvent),
      ],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(true);
    expect(result.output).toBe("final answer");
    expect(result.sessionId).toBe("ses_1");
    expect(result.usage).toEqual({
      agent: "claude",
      inputTokens: 80, // input + cacheRead + cacheWrite
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      costUsd: 0.42,
    });
  });

  it("reassembles events split across stdout chunks", async () => {
    const whole = line(successResultEvent);
    scriptSpawn({ stdout: [whole.slice(0, 25), whole.slice(25)] });

    const result = await runClaude(runParams());

    expect(result.success).toBe(true);
    expect(result.output).toBe("final answer");
  });

  it("forwards tool_use to onToolUse and keeps subagent text out of the final output", async () => {
    const onToolUse = vi.fn();
    scriptSpawn({
      stdout: [
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: "orchestrator answer" }] },
        }),
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "mcp__terramend__shell",
                input: { command: "ls" },
              },
              {
                type: "tool_use",
                id: "tu_task",
                name: "Task",
                input: { description: "security lens", subagent_type: REVIEWER_AGENT_NAME },
              },
            ],
          },
        }),
        // subagent events carry parent_tool_use_id of the dispatching tool_use.
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: "tu_task",
          message: { content: [{ type: "text", text: "subagent report-back" }] },
        }),
        line({
          type: "user",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "file-a\nfile-b" },
              {
                type: "tool_result",
                tool_use_id: "tu_task",
                content: [{ type: "text", text: "lens done" }, "raw string", { other: 1 }],
                is_error: true,
              },
            ],
          },
        }),
      ],
    });

    const result = await runClaude(runParams({ onToolUse }));

    expect(result.success).toBe(true);
    // subagent text must not clobber the orchestrator's final answer.
    expect(result.output).toBe("orchestrator answer");
    expect(onToolUse).toHaveBeenCalledTimes(2);
    expect(onToolUse).toHaveBeenCalledWith({
      toolName: "mcp__terramend__shell",
      input: { command: "ls" },
    });
  });

  it("tracks orchestrator TodoWrite, ignores subagent todos, and flushes on success", async () => {
    const todoTracker = makeTodoTracker();
    const todos = { todos: [{ content: "step", status: "pending" }] };
    scriptSpawn({
      stdout: [
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: {
            content: [
              { type: "tool_use", id: "tu_task", name: "Agent", input: { description: "lens" } },
              { type: "tool_use", id: "tu_2", name: "TodoWrite", input: todos },
            ],
          },
        }),
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: "tu_task",
          message: {
            content: [{ type: "tool_use", id: "tu_3", name: "TodoWrite", input: todos }],
          },
        }),
      ],
    });

    const result = await runClaude(runParams({ todoTracker }));

    expect(result.success).toBe(true);
    expect(todoTracker.update).toHaveBeenCalledTimes(1);
    expect(todoTracker.update).toHaveBeenCalledWith(todos);
    expect(todoTracker.flush).toHaveBeenCalledTimes(1);
    expect(todoTracker.cancel).not.toHaveBeenCalled();
  });

  it("cancels todo tracking when the agent calls report_progress", async () => {
    const todoTracker = makeTodoTracker();
    scriptSpawn({
      stdout: [
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "mcp__terramend__report_progress",
                input: {},
              },
            ],
          },
        }),
      ],
    });

    await runClaude(runParams({ todoTracker }));

    expect(todoTracker.cancel).toHaveBeenCalled();
  });

  it("accumulates per-message usage when no result event arrives", async () => {
    scriptSpawn({
      stdout: [
        line({
          type: "assistant",
          session_id: "ses_1",
          parent_tool_use_id: null,
          message: {
            content: [{ type: "text", text: "partial" }],
            usage: {
              input_tokens: 5,
              output_tokens: 7,
              cache_read_input_tokens: 11,
              cache_creation_input_tokens: 13,
            },
          },
        }),
      ],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(true);
    expect(result.output).toBe("partial");
    expect(result.usage).toEqual({
      agent: "claude",
      inputTokens: 29,
      outputTokens: 7,
      cacheReadTokens: 11,
      cacheWriteTokens: 13,
      costUsd: undefined,
    });
  });

  it("classifies a synthetic-stop result (is_error + subtype success) as a failure", async () => {
    scriptSpawn({
      stdout: [
        line({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: "OAuth token revoked",
          session_id: "ses_1",
        }),
      ],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("OAuth token revoked");
    expect(result.sessionId).toBe("ses_1");
  });

  it("synthesizes a message when the synthetic-stop result carries no text", async () => {
    scriptSpawn({
      stdout: [line({ type: "result", subtype: "success", is_error: true, api_error_status: 529 })],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toContain("api_error_status=529");
  });

  it("fails on error_max_turns and surfaces the errors payload", async () => {
    const todoTracker = makeTodoTracker();
    scriptSpawn({
      stdout: [
        line({ type: "result", subtype: "error_max_turns", errors: ["hit the turn ceiling"] }),
      ],
    });

    const result = await runClaude(runParams({ todoTracker }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("hit the turn ceiling");
    // exit code was 0, so the tracker still flushes (result gating happens upstream)
    expect(todoTracker.flush).toHaveBeenCalled();
  });

  it("fails on error_during_execution and falls back to the subtype when errors are empty", async () => {
    scriptSpawn({
      stdout: [line({ type: "result", subtype: "error_during_execution" })],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("result subtype: error_during_execution");
  });

  it("fails on any other error_* subtype", async () => {
    scriptSpawn({
      stdout: [line({ type: "result", subtype: "error_quota", errors: ["quota exceeded"] })],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("quota exceeded");
  });

  it("survives unknown event types and handler throws", async () => {
    scriptSpawn({
      stdout: [
        line({ type: "banana", session_id: "ses_1" }),
        // message.content is a number — the assistant handler throws, gets caught.
        line({ type: "assistant", session_id: "ses_1", message: { content: 42 } }),
        // unknown non-error result subtype is logged but not fatal.
        line({ type: "result", subtype: "checkpoint" }),
        line(successResultEvent),
      ],
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(true);
    expect(result.output).toBe("final answer");
  });

  it("prefers stderr over the NDJSON tail on a non-zero exit", async () => {
    const todoTracker = makeTodoTracker();
    scriptSpawn({
      stdout: [line({ type: "system", subtype: "init", session_id: "ses_1" })],
      stderr: ['API error: {"status": 429, "message": "rate limited"}'],
      exitCode: 1,
    });

    const result = await runClaude(runParams({ todoTracker }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('API error: {"status": 429, "message": "rate limited"}');
    expect(todoTracker.cancel).toHaveBeenCalled();
    expect(todoTracker.flush).not.toHaveBeenCalled();
  });

  it("prefers human-readable non-JSON stdout chrome over the NDJSON tail on exit 1", async () => {
    scriptSpawn({
      stdout: [
        line({ type: "system", subtype: "init", session_id: "ses_1" }),
        "You have exceeded your usage quota for today\n",
      ],
      exitCode: 1,
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("You have exceeded your usage quota for today");
  });

  it("prefers the structured result error over everything else on exit 1", async () => {
    scriptSpawn({
      stdout: [
        line({
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: "invalid x-api-key",
        }),
      ],
      stderr: ["noisy stderr"],
      exitCode: 1,
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid x-api-key");
  });

  it("reports an unknown error when a non-zero exit produced no output at all", async () => {
    scriptSpawn({ exitCode: 7 });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown error - no output from Claude CLI");
  });

  it("classifies a zero-event run with a provider stderr error", async () => {
    scriptSpawn({
      stderr: ["Your credit balance is too low to access the Anthropic API"],
      exitCode: 0,
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toBe("provider error: provider billing exhausted");
  });

  it("converts a SpawnTimeoutError into a diagnosed failure result", async () => {
    const todoTracker = makeTodoTracker();
    scriptSpawn({
      stdout: [
        line({
          type: "assistant",
          session_id: "ses_1",
          message: { content: [{ type: "text", text: "got this far" }] },
        }),
      ],
      reject: new SpawnTimeoutError(
        "activity timeout: no output for 900s",
        SPAWN_ACTIVITY_TIMEOUT_CODE,
      ),
    });

    const result = await runClaude(runParams({ todoTracker }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("activity timeout: no output for 900s");
    expect(result.error).toContain("1 events were processed before the hang");
    expect(result.output).toBe("got this far");
    expect(todoTracker.cancel).toHaveBeenCalled();
  });

  it("diagnoses a zero-event hang as a possible API-reachability problem", async () => {
    scriptSpawn({
      reject: new SpawnTimeoutError(
        "activity timeout: no output for 900s",
        SPAWN_ACTIVITY_TIMEOUT_CODE,
      ),
    });

    const result = await runClaude(runParams());

    expect(result.success).toBe(false);
    expect(result.error).toContain("0 stdout events");
  });
});

describe("claude.run", () => {
  let gateDispose: ReturnType<typeof vi.fn<() => Promise<void>>>;

  function makeRunCtx(overrides?: Partial<AgentRunContext>): AgentRunContext {
    const dir = mkdtempSync(join(tmpdir(), "terramend-claude-run-"));
    tempDirs.push(dir);
    const ctx = {
      payload: {},
      resolvedModel: "anthropic/claude-opus-4-6",
      mcpServerUrl: "http://127.0.0.1:7777/mcp",
      tmpdir: dir,
      instructions: {
        full: "fix the bug",
        system: "",
        user: "",
        eventInstructions: "",
        event: "",
        runtime: "",
      },
      toolState: {} as unknown as ToolState,
      apiToken: "",
      ...overrides,
    };
    return ctx as unknown as AgentRunContext;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // installManagedSettings shells out to sudo when CI === "true" — keep it off.
    vi.stubEnv("CI", "false");
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
    vi.stubEnv("BEDROCK_MODEL_ID", undefined);
    vi.stubEnv("VERTEX_MODEL_ID", undefined);
    gateDispose = vi.fn(async () => {});
    startGateServerMock.mockResolvedValue({
      url: "http://127.0.0.1:9999/gates",
      token: "gate-token",
      [Symbol.asyncDispose]: gateDispose,
    });
    scriptSpawn({ stdout: [line(successResultEvent)] });
  });

  it("assembles the CLI invocation: args, MCP config, gate env, and result passthrough", async () => {
    const ctx = makeRunCtx();
    const result = await claude.run(ctx);

    expect(result.success).toBe(true);
    expect(result.output).toBe("final answer");
    expect(installMock).toHaveBeenCalled();
    expect(installBundledSkillsMock).toHaveBeenCalledWith({ home: ctx.tmpdir });

    const opts = lastSpawnOptions();
    expect(opts.cmd).toBe("/fake/bin/claude.exe");
    expect(opts.cwd).toBe(process.cwd());

    const args = opts.args;
    expect(args.slice(0, 2)).toEqual(["--output-format", "stream-json"]);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.at(-2)).toBe("-p");
    expect(args.at(-1)).toBe("fix the bug");

    // model is stripped of the provider prefix
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6");

    // disallowed exec tools ride --disallowedTools
    const disallowed = args[args.indexOf("--disallowedTools") + 1] ?? "";
    expect(disallowed.split(",").sort()).toEqual([...CLAUDE_EXEC_TOOL_DENY_RULES].sort());

    // --agents carries the reviewer definition
    const agentsJson = JSON.parse(args[args.indexOf("--agents") + 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(agentsJson[REVIEWER_AGENT_NAME]).toBeDefined();

    // MCP config written into the per-run tmpdir
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1] ?? "";
    expect(mcpConfigPath).toBe(join(ctx.tmpdir, ".claude", "mcp.json"));
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers: Record<string, { type: string; url: string }>;
    };
    expect(mcpConfig.mcpServers.terramend).toEqual({
      type: "http",
      url: "http://127.0.0.1:7777/mcp",
    });

    // flag settings + pretool gate script + stop hook all land in tmpdir
    const settingsPath = args[args.indexOf("--settings") + 1] ?? "";
    expect(settingsPath).toBe(join(ctx.tmpdir, "terramend-claude-settings.json"));
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(join(ctx.tmpdir, "terramend-stop-hook.sh"))).toBe(true);

    // gate server env wiring + HOME redirect
    const env = opts.env ?? {};
    expect(env.TERRAMEND_GATE_URL).toBe("http://127.0.0.1:9999/gates");
    expect(env.TERRAMEND_GATE_TOKEN).toBe("gate-token");
    expect(env.HOME).toBe(ctx.tmpdir);
    expect(env.PWD).toBe(process.cwd());
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();

    expect(gateDispose).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  it("omits --model when no model resolved", async () => {
    await claude.run(makeRunCtx({ resolvedModel: undefined }));
    expect(lastSpawnOptions().args).not.toContain("--model");
  });

  it("passes the bare Bedrock id through and sets CLAUDE_CODE_USE_BEDROCK", async () => {
    vi.stubEnv("BEDROCK_MODEL_ID", "eu.anthropic.claude-opus-4-7");
    await claude.run(makeRunCtx({ resolvedModel: "eu.anthropic.claude-opus-4-7" }));

    const opts = lastSpawnOptions();
    expect(opts.args[opts.args.indexOf("--model") + 1]).toBe("eu.anthropic.claude-opus-4-7");
    expect(opts.env?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });

  it("routes Vertex models through env instead of --model", async () => {
    vi.stubEnv("VERTEX_MODEL_ID", "claude-opus-4-1@20250805");
    await claude.run(makeRunCtx({ resolvedModel: "claude-opus-4-1@20250805" }));

    const opts = lastSpawnOptions();
    expect(opts.args).not.toContain("--model");
    expect(opts.env?.ANTHROPIC_MODEL).toBe("claude-opus-4-1@20250805");
    expect(opts.env?.CLAUDE_CODE_USE_VERTEX).toBe("1");
  });

  it("strips ANTHROPIC_API_KEY when the OAuth subscription preflight passes", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "api-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    preflightMock.mockResolvedValue({ usable: true });

    await claude.run(makeRunCtx());

    expect(preflightMock).toHaveBeenCalledWith({
      token: "oauth-token",
      model: "claude-opus-4-6",
    });
    const env = lastSpawnOptions().env ?? {};
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
  });

  it("drops the OAuth token and keeps the API key when the preflight fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "api-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    preflightMock.mockResolvedValue({ usable: false, reason: "weekly limit reached" });

    await claude.run(makeRunCtx());

    const env = lastSpawnOptions().env ?? {};
    expect("CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("api-key");
  });

  it("skips the preflight when no API key competes with the OAuth token", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");

    await claude.run(makeRunCtx());

    expect(preflightMock).not.toHaveBeenCalled();
    expect(lastSpawnOptions().env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
  });

  it("installs managed settings via sudo when running in CI", async () => {
    vi.stubEnv("CI", "true");

    await claude.run(makeRunCtx());

    expect(execFileSyncMock).toHaveBeenCalledWith("sudo", ["mkdir", "-p", "/etc/claude-code"]);
    const teeCall = execFileSyncMock.mock.calls.find((call) => call[1]?.[0] === "tee");
    expect(teeCall?.[1]).toEqual(["tee", "/etc/claude-code/managed-settings.json"]);
    const teeOptions = teeCall?.[2] as { input: string };
    const managed = JSON.parse(teeOptions.input) as { permissions: { deny: string[] } };
    expect(managed.permissions.deny).toContain("Bash");
  });

  it("degrades to a warning when the managed-settings install fails", async () => {
    vi.stubEnv("CI", "true");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("sudo: command not found");
    });

    const result = await claude.run(makeRunCtx());
    expect(result.success).toBe(true);
  });

  it("skips the managed-settings install outside CI", async () => {
    await claude.run(makeRunCtx());
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("never strips credentials on the Bedrock route", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "api-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-token");
    vi.stubEnv("BEDROCK_MODEL_ID", "eu.anthropic.claude-opus-4-7");

    await claude.run(makeRunCtx({ resolvedModel: "eu.anthropic.claude-opus-4-7" }));

    expect(preflightMock).not.toHaveBeenCalled();
    const env = lastSpawnOptions().env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("api-key");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
  });
});
