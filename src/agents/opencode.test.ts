import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  type AssistantMessage,
  createOpencodeClient,
  type EventSubscribeResponse,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk/v2";
import { fetch as undiciFetch } from "undici";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootOpencodeServer,
  buildSecurityConfig,
  buildUsage,
  consumeEvents,
  dispatchEvent,
  extractTextFromParts,
  formatPartDuration,
  formatPromptError,
  newTurn,
  opencode,
  parseModel,
  processTerminalToolPart,
  type RunnerContext,
  runPromptTurn,
  runTurnGuarded,
  startInnerActivityWatchdog,
} from "#app/agents/opencode";
import { TERRAMEND_OPENCODE_GATE_PLUGIN_FILENAME } from "#app/agents/opencodePlugin";
import { runPostRunRetryLoop } from "#app/agents/postRun";
import { REVIEWER_AGENT_NAME } from "#app/agents/reviewer";
import { SessionLabeler } from "#app/agents/sessionLabeler";
import type { AgentRunContext } from "#app/agents/shared";
import type { ToolState } from "#app/toolState";
import { AGENT_ACTIVITY_TIMEOUT_MS } from "#app/utils/activity";
import { installCodexAuth } from "#app/utils/codexHome";
import type { TodoTracker } from "#app/utils/todoTracking";

// the harness spawns the opencode server binary directly — fake the child
// process so tests never start a real subprocess on any OS.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});
// the SDK client talks loopback HTTP — replace with a scriptable fake.
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient: vi.fn() }));
// undici Agent would open real sockets; the fetch override is exercised
// directly against the mock.
vi.mock("undici", () => {
  class FakeUndiciAgent {
    options: unknown;
    close = vi.fn(async () => {});
    constructor(options: unknown) {
      this.options = options;
    }
  }
  return { Agent: FakeUndiciAgent, fetch: vi.fn(async () => new Response("ok")) };
});
// CLI install hits the npm registry.
vi.mock("#app/agents/opencodeShared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/agents/opencodeShared")>();
  return { ...actual, installOpencodeCli: vi.fn(async () => "/fake/bin/opencode.exe") };
});
// the retry loop shells out to git via collectPostRunIssues — passthrough.
vi.mock("#app/agents/postRun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/agents/postRun")>();
  return { ...actual, runPostRunRetryLoop: vi.fn() };
});
// codex auth materialization touches /var/lib in CI.
vi.mock("#app/utils/codexHome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/codexHome")>();
  return { ...actual, installCodexAuth: vi.fn(() => null) };
});
// skills install writes into the fake HOME.
vi.mock("#app/utils/skills", () => ({ installBundledSkills: vi.fn() }));
// child tracking installs process-wide signal handlers.
vi.mock("#app/utils/subprocess", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#app/utils/subprocess")>();
  return { ...actual, trackChild: vi.fn(), untrackChild: vi.fn() };
});

const nodeSpawnMock = vi.mocked(nodeSpawn);
const createOpencodeClientMock = vi.mocked(createOpencodeClient);
const undiciFetchMock = vi.mocked(undiciFetch);
const runPostRunRetryLoopMock = vi.mocked(runPostRunRetryLoop);
const installCodexAuthMock = vi.mocked(installCodexAuth);

const MCP_URL = "http://127.0.0.1:7777/mcp";

function makeCtx(): AgentRunContext {
  // buildSecurityConfig only reads ctx.mcpServerUrl.
  return { mcpServerUrl: MCP_URL } as unknown as AgentRunContext;
}

interface ParsedSecurityConfig {
  permission: Record<string, string>;
  mcp: Record<string, { type: string; url: string; timeout: number }>;
  agent: Record<string, { mode?: string; prompt?: string }>;
  provider: Record<string, { npm?: string; models?: Record<string, unknown> }>;
  model?: string;
  enabled_providers?: string[];
}

function parseConfig(model: string | undefined): ParsedSecurityConfig {
  return JSON.parse(buildSecurityConfig(makeCtx(), model)) as ParsedSecurityConfig;
}

describe("buildSecurityConfig", () => {
  it("denies native bash and allows the file/web surfaces", () => {
    const config = parseConfig(undefined);
    expect(config.permission).toEqual({
      bash: "deny",
      edit: "allow",
      read: "allow",
      webfetch: "allow",
      external_directory: "allow",
      skill: "allow",
    });
  });

  it("injects the terramend MCP server with the extended tool timeout", () => {
    const config = parseConfig(undefined);
    expect(config.mcp.terramend).toEqual({ type: "remote", url: MCP_URL, timeout: 300_000 });
  });

  it("registers the reviewer subagent", () => {
    const config = parseConfig(undefined);
    const reviewer = config.agent[REVIEWER_AGENT_NAME];
    expect(reviewer?.mode).toBe("subagent");
    expect(reviewer?.prompt?.length ?? 0).toBeGreaterThan(0);
  });

  it("omits model and enabled_providers when no model resolved", () => {
    const config = parseConfig(undefined);
    expect(config.model).toBeUndefined();
    expect(config.enabled_providers).toBeUndefined();
  });

  it("pins the model and restricts enabled_providers to its provider", () => {
    const config = parseConfig("anthropic/claude-opus-4-7");
    expect(config.model).toBe("anthropic/claude-opus-4-7");
    expect(config.enabled_providers).toEqual(["anthropic"]);
  });

  it("lowercases the provider id for enabled_providers", () => {
    expect(parseConfig("OpenAI/gpt-5.5").enabled_providers).toEqual(["openai"]);
  });

  it("sets no enabled_providers for a model without a provider prefix", () => {
    const config = parseConfig("gemini-2.5-pro");
    expect(config.model).toBe("gemini-2.5-pro");
    expect(config.enabled_providers).toBeUndefined();
  });

  it("pins the fixed openrouter stream parser for moonshot models only", () => {
    const moonshot = parseConfig("openrouter/moonshotai/kimi-k2.6");
    expect(moonshot.enabled_providers).toEqual(["openrouter"]);
    expect(moonshot.provider.openrouter?.npm).toBe("@openrouter/ai-sdk-provider@2.9.0");
    expect(moonshot.provider.openrouter?.models).toEqual({ "moonshotai/kimi-k2.6": {} });

    const other = parseConfig("openrouter/qwen/qwen3-coder");
    expect(other.provider.openrouter).toBeUndefined();
  });

  it("always carries the gemini high-thinking overrides", () => {
    const config = parseConfig("anthropic/claude-opus-4-7");
    expect(config.provider.google).toBeDefined();
  });
});

describe("parseModel", () => {
  it("splits provider/model into the SDK prompt shape", () => {
    expect(parseModel("anthropic/claude-opus-4-7")).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-7",
    });
  });

  it("keeps everything after the first slash in the modelID", () => {
    expect(parseModel("openrouter/moonshotai/kimi-k2.6")).toEqual({
      providerID: "openrouter",
      modelID: "moonshotai/kimi-k2.6",
    });
  });

  it("returns undefined for undefined, bare, and leading-slash values", () => {
    expect(parseModel(undefined)).toBeUndefined();
    expect(parseModel("claude-opus-4-7")).toBeUndefined();
    expect(parseModel("/oops")).toBeUndefined();
  });
});

describe("extractTextFromParts", () => {
  function textOnlyPart(text: string): Part {
    return { type: "text", text } as unknown as Part;
  }

  it("returns undefined for missing or text-free parts", () => {
    expect(extractTextFromParts(undefined)).toBeUndefined();
    expect(extractTextFromParts([])).toBeUndefined();
    expect(extractTextFromParts([{ type: "step-start" } as unknown as Part])).toBeUndefined();
    expect(extractTextFromParts([textOnlyPart("")])).toBeUndefined();
  });

  it("joins text parts and skips non-text parts", () => {
    const parts = [
      textOnlyPart("first"),
      { type: "step-start" } as unknown as Part,
      textOnlyPart("second"),
    ];
    expect(extractTextFromParts(parts)).toBe("first\nsecond");
  });
});

describe("formatPromptError", () => {
  it("passes strings through", () => {
    expect(formatPromptError("boom")).toBe("boom");
  });

  it("prefers message, then error.message, then JSON", () => {
    expect(formatPromptError({ message: "top-level" })).toBe("top-level");
    expect(formatPromptError({ error: { message: "nested" } })).toBe("nested");
    expect(formatPromptError({ data: { code: 500 } })).toBe('{"data":{"code":500}}');
  });

  it("stringifies primitives and unserializable objects", () => {
    expect(formatPromptError(42)).toBe("42");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatPromptError(circular)).toBe("[object Object]");
  });
});

describe("formatPartDuration", () => {
  it("returns an empty string when timing is missing or non-positive", () => {
    expect(formatPartDuration(undefined)).toBe("");
    expect(formatPartDuration({ start: 100 })).toBe("");
    expect(formatPartDuration({ start: 100, end: 100 })).toBe("");
    expect(formatPartDuration({ start: 200, end: 100 })).toBe("");
  });

  it("renders the duration in seconds", () => {
    expect(formatPartDuration({ start: 0, end: 1500 })).toBe(" (1.5s)");
  });
});

// ── in-process SDK harness ──────────────────────────────────────────────────────

const ORCH_SESSION = "ses_orch";
const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** ChildProcess stand-in: EventEmitter with stdout/stderr streams and a kill
 * that emits `close` on the next tick (matching async signal delivery). */
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 424242;
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    setImmediate(() => {
      this.emit("close", null, typeof signal === "string" ? signal : "SIGTERM");
    });
    return true;
  });
}

function stubSpawnedProcess(proc: FakeChildProcess): void {
  nodeSpawnMock.mockImplementation(() => proc as unknown as ReturnType<typeof nodeSpawn>);
}

/** route process-group kills to the per-child fallback (no real signals). */
function stubProcessKill(): void {
  vi.spyOn(process, "kill").mockImplementation((pid: number) => {
    if (pid < 0) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    return true;
  });
}

interface FakeClient {
  session: {
    create: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
  };
  event: { subscribe: ReturnType<typeof vi.fn> };
}

function makeClient(): FakeClient {
  return {
    session: {
      create: vi.fn(async () => ({ data: { id: ORCH_SESSION } })),
      prompt: vi.fn(async () => ({ data: { info: assistantInfo(), parts: [] } })),
      messages: vi.fn(async () => ({ data: [] })),
    },
    event: {
      subscribe: vi.fn(async () => ({ stream: (async function* () {})() })),
    },
  };
}

function assistantInfo(overrides?: Record<string, unknown>): AssistantMessage {
  return {
    id: "msg_assistant",
    sessionID: ORCH_SESSION,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "claude-opus-4-7",
    providerID: "anthropic",
    mode: "build",
    agent: "general",
    path: { cwd: "/", root: "/" },
    cost: 0.1,
    tokens: { input: 50, output: 9, reasoning: 0, cache: { read: 3, write: 4 } },
    ...overrides,
  } as unknown as AssistantMessage;
}

function makeRunnerCtx(client: FakeClient, overrides?: Partial<RunnerContext>): RunnerContext {
  const labeler = new SessionLabeler();
  labeler.labelFor(ORCH_SESSION);
  return {
    client: client as unknown as OpencodeClient,
    sessionID: ORCH_SESSION,
    label: "Terramend",
    orchestratorSessionID: ORCH_SESSION,
    labeler,
    toolState: {} as unknown as ToolState,
    todoTracker: undefined,
    onActivityTimeout: undefined,
    onToolUse: undefined,
    currentTurn: null,
    eventCount: 0,
    lastEventAt: performance.now(),
    taskDispatchByCallID: new Map(),
    loggedToolCallIDs: new Set(),
    recentStderr: [],
    diagnostic: {
      label: "Terramend",
      recentStderr: [],
      lastProviderError: undefined,
      eventCount: 0,
    },
    ...overrides,
  };
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

function sdkTextPart(text: string, sessionID = ORCH_SESSION, end?: number): Part {
  return {
    id: `prt_${text.slice(0, 8)}`,
    sessionID,
    messageID: "msg_1",
    type: "text",
    text,
    time: { start: 1, ...(end === undefined ? {} : { end }) },
  } as unknown as Part;
}

type ToolPartShape = Extract<Part, { type: "tool" }>;

function sdkToolPart(params: {
  tool: string;
  callID: string;
  sessionID?: string;
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}): ToolPartShape {
  const state =
    params.status === "completed"
      ? {
          status: "completed",
          input: params.input ?? {},
          output: params.output ?? "",
          title: "title",
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : params.status === "error"
        ? {
            status: "error",
            input: params.input ?? {},
            error: params.error ?? "tool exploded",
            time: { start: 1, end: 2 },
          }
        : params.status === "running"
          ? { status: "running", input: params.input ?? {}, time: { start: 1 } }
          : { status: "pending" };
  return {
    id: `prt_${params.callID}`,
    sessionID: params.sessionID ?? ORCH_SESSION,
    messageID: "msg_1",
    type: "tool",
    callID: params.callID,
    tool: params.tool,
    state,
  } as unknown as ToolPartShape;
}

function partUpdated(part: Part): EventSubscribeResponse {
  return {
    type: "message.part.updated",
    properties: { part },
  } as unknown as EventSubscribeResponse;
}

function sessionErrorEvent(sessionID: string, error?: unknown): EventSubscribeResponse {
  return {
    type: "session.error",
    properties: { sessionID, error },
  } as unknown as EventSubscribeResponse;
}

describe("bootOpencodeServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubProcessKill();
  });

  function boot(proc: FakeChildProcess) {
    stubSpawnedProcess(proc);
    return bootOpencodeServer({ cliPath: "/fake/bin/opencode.exe", env: {}, cwd: process.cwd() });
  }

  it("resolves with the base URL once the listening line arrives (split across chunks)", async () => {
    const proc = new FakeChildProcess();
    const promise = boot(proc);

    proc.stderr.emit("data", Buffer.from("warming up\n"));
    proc.stdout.emit("data", Buffer.from("opencode server listen"));
    proc.stdout.emit("data", Buffer.from("ing on http://127.0.0.1:43117\nextra noise\n"));

    const handle = await promise;
    expect(handle.baseUrl).toBe("http://127.0.0.1:43117");
    expect(handle.recentStderr).toContain("warming up");
    expect(nodeSpawnMock).toHaveBeenCalledWith(
      "/fake/bin/opencode.exe",
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      expect.objectContaining({ detached: true }),
    );

    await handle.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    // idempotent: a second close must not re-kill.
    await handle.close();
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });

  it("escalates to SIGKILL when the server ignores SIGTERM for 2s", async () => {
    vi.useFakeTimers();
    try {
      const proc = new FakeChildProcess();
      const promise = boot(proc);
      proc.stdout.emit(
        "data",
        Buffer.from("opencode server listening on http://127.0.0.1:43117\n"),
      );
      const handle = await promise;

      // first kill (SIGTERM) is swallowed — no close event, killed stays false
      proc.kill.mockImplementationOnce(() => true);
      const closePromise = handle.close();
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.runAllTimersAsync(); // flush the SIGKILL kill's close emission
      await closePromise;

      expect(proc.kill).toHaveBeenCalledTimes(2);
      expect(proc.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the spawn itself errors", async () => {
    const proc = new FakeChildProcess();
    const promise = boot(proc);
    const assertion = expect(promise).rejects.toThrow(
      "failed to spawn opencode serve: ENOENT opencode",
    );
    proc.emit("error", new Error("ENOENT opencode"));
    await assertion;
  });

  it("rejects with the stderr tail when the server exits before ready", async () => {
    const proc = new FakeChildProcess();
    const promise = boot(proc);
    const assertion = expect(promise).rejects.toThrow(
      /exited before ready \(code=1 signal=null\)[\s\S]*port already in use/,
    );
    proc.stderr.emit("data", Buffer.from("port already in use\n"));
    proc.emit("close", 1, null);
    await assertion;
  });

  it("rejects after the 30s boot timeout", async () => {
    vi.useFakeTimers();
    try {
      const proc = new FakeChildProcess();
      const promise = boot(proc);
      const assertion = expect(promise).rejects.toThrow(/timed out after 30s waiting/);
      vi.advanceTimersByTime(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("dispatchEvent", () => {
  it("captures completed orchestrator text as the turn's final text", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();
    const before = ctx.lastEventAt;

    await dispatchEvent(ctx, partUpdated(sdkTextPart("the answer", ORCH_SESSION, 9)));

    expect(ctx.currentTurn.finalText).toBe("the answer");
    expect(ctx.lastEventAt).toBeGreaterThanOrEqual(before);
  });

  it("ignores text without time.end and text from subagent sessions", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();

    await dispatchEvent(ctx, partUpdated(sdkTextPart("streaming…", ORCH_SESSION)));
    expect(ctx.currentTurn.finalText).toBe("");

    await dispatchEvent(ctx, partUpdated(sdkTextPart("subagent says", "ses_sub", 9)));
    expect(ctx.currentTurn.finalText).toBe("");
  });

  it("logs reasoning parts (long ones truncated) without touching the turn", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();
    const reasoning = {
      id: "prt_r",
      sessionID: ORCH_SESSION,
      messageID: "msg_1",
      type: "reasoning",
      text: "deep thought ".repeat(40),
      time: { start: 0, end: 2_000 },
    } as unknown as Part;

    await dispatchEvent(ctx, partUpdated(reasoning));

    expect(ctx.currentTurn.finalText).toBe("");
  });

  it("aggregates step-finish tokens and cost across orchestrator and subagents", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();
    const stepFinish = (sessionID: string, cost: number) =>
      partUpdated({
        id: "prt_sf",
        sessionID,
        messageID: "msg_1",
        type: "step-finish",
        reason: "stop",
        cost,
        tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 2, write: 3 } },
      } as unknown as Part);

    await dispatchEvent(ctx, stepFinish(ORCH_SESSION, 0.25));
    await dispatchEvent(ctx, stepFinish("ses_sub", 0.5));
    // non-finite cost must not poison the sum
    await dispatchEvent(
      ctx,
      partUpdated({
        id: "prt_sf2",
        sessionID: ORCH_SESSION,
        messageID: "msg_1",
        type: "step-finish",
        reason: "stop",
        cost: Number.NaN,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      } as unknown as Part),
    );

    expect(ctx.currentTurn.tokens).toEqual({ input: 21, output: 9, cacheRead: 4, cacheWrite: 6 });
    expect(ctx.currentTurn.costUsd).toBe(0.75);
  });

  it("ignores step-finish events between turns", async () => {
    const ctx = makeRunnerCtx(makeClient());
    await expect(
      dispatchEvent(
        ctx,
        partUpdated({
          id: "prt_sf",
          sessionID: ORCH_SESSION,
          messageID: "msg_1",
          type: "step-finish",
          reason: "stop",
          cost: 1,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        } as unknown as Part),
      ),
    ).resolves.toBeUndefined();
  });

  it("records orchestrator session errors and ignores foreign sessions", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();

    await dispatchEvent(ctx, sessionErrorEvent("ses_other", { name: "ProviderAuthError" }));
    expect(ctx.currentTurn.sessionError).toBeNull();

    await dispatchEvent(
      ctx,
      sessionErrorEvent(ORCH_SESSION, { name: "ProviderAuthError", data: { message: "401" } }),
    );
    expect(ctx.currentTurn.sessionError).toBe("401");

    await dispatchEvent(ctx, sessionErrorEvent(ORCH_SESSION, undefined));
    expect(ctx.currentTurn.sessionError).toBe("(no error payload)");
  });

  it("binds a task dispatch to a subagent label that future sessions inherit", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();

    await dispatchEvent(
      ctx,
      partUpdated(
        sdkToolPart({
          tool: "task",
          callID: "call_task",
          status: "running",
          input: { description: "Security review", prompt: "lens: security\ngo deep" },
        }),
      ),
    );

    const dispatch = ctx.taskDispatchByCallID.get("call_task");
    expect(dispatch?.label).toBe("lens:security");

    // the next unseen sessionID consumes the queued label (FIFO contract)
    await dispatchEvent(ctx, partUpdated(sdkTextPart("sub text", "ses_sub", 5)));
    expect(ctx.labeler.entries()).toContainEqual(["ses_sub", "lens:security"]);
    expect(ctx.currentTurn.finalText).toBe("");
  });
});

describe("processTerminalToolPart", () => {
  it("logs a completed orchestrator call once and forwards it to onToolUse", () => {
    const onToolUse = vi.fn();
    const ctx = makeRunnerCtx(makeClient(), { onToolUse });
    const part = sdkToolPart({
      tool: "read",
      callID: "call_1",
      status: "completed",
      input: { filePath: "src/main.ts" },
      output: "contents",
    });

    processTerminalToolPart(ctx, part, "orchestrator", true);
    processTerminalToolPart(ctx, part, "orchestrator", true);

    expect(onToolUse).toHaveBeenCalledTimes(1);
    expect(onToolUse).toHaveBeenCalledWith({
      toolName: "read",
      input: { filePath: "src/main.ts" },
    });
    expect(ctx.loggedToolCallIDs.has("call_1")).toBe(true);
  });

  it("ignores pending/running states", () => {
    const onToolUse = vi.fn();
    const ctx = makeRunnerCtx(makeClient(), { onToolUse });

    processTerminalToolPart(
      ctx,
      sdkToolPart({ tool: "read", callID: "call_p", status: "pending" }),
      "orchestrator",
      true,
    );
    processTerminalToolPart(
      ctx,
      sdkToolPart({ tool: "read", callID: "call_r", status: "running" }),
      "orchestrator",
      true,
    );

    expect(onToolUse).not.toHaveBeenCalled();
    expect(ctx.loggedToolCallIDs.size).toBe(0);
  });

  it("records orchestrator tool errors on the current turn", () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();

    processTerminalToolPart(
      ctx,
      sdkToolPart({ tool: "edit", callID: "call_e", status: "error", error: "patch failed" }),
      "orchestrator",
      true,
    );

    expect(ctx.currentTurn.lastToolError).toBe("patch failed");
  });

  it("emits the subagent-finished summary and clears the dispatch entry", () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.taskDispatchByCallID.set("call_task", {
      label: "lens:security",
      startedAt: performance.now() - 1_000,
    });

    processTerminalToolPart(
      ctx,
      sdkToolPart({
        tool: "task",
        callID: "call_task",
        status: "completed",
        output: "x".repeat(200),
      }),
      "orchestrator",
      true,
    );

    expect(ctx.taskDispatchByCallID.has("call_task")).toBe(false);
  });

  it("drives the todo tracker: todowrite updates, report_progress cancels", () => {
    const todoTracker = makeTodoTracker();
    const ctx = makeRunnerCtx(makeClient(), { todoTracker });
    const todos = { todos: [{ content: "a", status: "pending" }] };

    processTerminalToolPart(
      ctx,
      sdkToolPart({ tool: "todowrite", callID: "call_t", status: "completed", input: todos }),
      "orchestrator",
      true,
    );
    expect(todoTracker.update).toHaveBeenCalledWith(todos);

    // subagent todowrite must NOT update the tracker
    processTerminalToolPart(
      ctx,
      sdkToolPart({
        tool: "todowrite",
        callID: "call_t2",
        sessionID: "ses_sub",
        status: "completed",
        input: todos,
      }),
      "lens:security",
      false,
    );
    expect(todoTracker.update).toHaveBeenCalledTimes(1);

    processTerminalToolPart(
      ctx,
      sdkToolPart({
        tool: "terramend_report_progress",
        callID: "call_rp",
        status: "completed",
      }),
      "orchestrator",
      true,
    );
    expect(todoTracker.cancel).toHaveBeenCalled();
  });
});

describe("consumeEvents", () => {
  it("pumps the stream, counts events, and survives a dispatch throw", async () => {
    const client = makeClient();
    const malformed = { type: "message.part.updated" } as unknown as EventSubscribeResponse;
    client.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        yield malformed; // event.properties.part access throws — must be caught
        yield partUpdated(sdkTextPart("ok", ORCH_SESSION, 3));
      })(),
    });
    const ctx = makeRunnerCtx(client);
    ctx.currentTurn = newTurn();

    await consumeEvents(ctx, new AbortController().signal);

    expect(ctx.eventCount).toBe(2);
    expect(ctx.diagnostic.eventCount).toBe(2);
    expect(ctx.currentTurn.finalText).toBe("ok");
  });

  it("stops consuming once the signal aborts", async () => {
    const client = makeClient();
    const abortController = new AbortController();
    client.event.subscribe.mockResolvedValue({
      stream: (async function* () {
        yield partUpdated(sdkTextPart("first", ORCH_SESSION, 3));
        abortController.abort();
        yield partUpdated(sdkTextPart("second", ORCH_SESSION, 4));
      })(),
    });
    const ctx = makeRunnerCtx(client);

    await consumeEvents(ctx, abortController.signal);

    expect(ctx.eventCount).toBe(1);
    const subscribeOptions = client.event.subscribe.mock.calls[0]?.[1] as { signal: AbortSignal };
    expect(subscribeOptions.signal).toBe(abortController.signal);
  });
});

describe("runPromptTurn", () => {
  const sdkModel = { providerID: "anthropic", modelID: "claude-opus-4-7" };

  it("aggregates authoritative usage from the message store and replays unseen tool calls", async () => {
    const client = makeClient();
    const onToolUse = vi.fn();
    client.session.prompt.mockResolvedValue({
      data: { info: assistantInfo(), parts: [sdkTextPart("turn answer", ORCH_SESSION, 9)] },
    });
    client.session.messages.mockImplementation(async (args: { sessionID: string }) => {
      // a subagent session whose read fails must not poison the aggregate.
      if (args.sessionID === "ses_sub") throw new Error("session store unavailable");
      return {
        data: [
          {
            info: {
              role: "assistant",
              time: { created: Date.now() + 60_000 },
              tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 10, write: 5 } },
              cost: 0.7,
            },
            parts: [
              sdkToolPart({
                tool: "grep",
                callID: "call_missed",
                status: "completed",
                input: { pattern: "needle" },
              }),
              sdkTextPart("not a tool part", ORCH_SESSION, 3),
            ],
          },
          {
            info: { role: "user", time: { created: Date.now() + 60_000 } },
            parts: [],
          },
          {
            // landed before this turn started — excluded from the aggregate
            info: {
              role: "assistant",
              time: { created: Date.now() - 60_000 },
              tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 9,
            },
            parts: [],
          },
        ],
      };
    });
    const ctx = makeRunnerCtx(client, { onToolUse });
    ctx.labeler.labelFor("ses_sub");

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("turn answer");
    expect(result.usage).toEqual({
      agent: "terramend",
      inputTokens: 115,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.7,
    });
    // SSE-connect race fallback: the tool call seen only in the message store
    // must still reach onToolUse exactly once.
    expect(onToolUse).toHaveBeenCalledWith({ toolName: "grep", input: { pattern: "needle" } });
    expect(client.session.prompt).toHaveBeenCalledWith(
      { sessionID: ORCH_SESSION, parts: [{ type: "text", text: "go" }], model: sdkModel },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("falls back to the assistant message usage when the store has nothing", async () => {
    const client = makeClient();
    const ctx = makeRunnerCtx(client);

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: undefined,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      agent: "terramend",
      inputTokens: 57, // 50 + cache read 3 + cache write 4
      outputTokens: 9,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.1,
    });
    // no model → prompt body must not carry one
    const promptBody = client.session.prompt.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("model" in promptBody).toBe(false);
  });

  it("fails on a transport error from session.prompt", async () => {
    const client = makeClient();
    client.session.prompt.mockResolvedValue({ error: { message: "bad gateway" } });
    const ctx = makeRunnerCtx(client);

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("opencode prompt failed: bad gateway");
  });

  it("fails when the response carries neither data nor error", async () => {
    const client = makeClient();
    client.session.prompt.mockResolvedValue({});
    const ctx = makeRunnerCtx(client);

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "opencode prompt failed: opencode prompt returned neither data nor error",
    );
  });

  it("classifies a watchdog-aborted prompt as an activity timeout", async () => {
    const client = makeClient();
    const abortController = new AbortController();
    client.session.prompt.mockImplementation(async () => {
      abortController.abort();
      throw new Error("This operation was aborted");
    });
    const ctx = makeRunnerCtx(client);

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("activity timeout:");
    expect(result.error).toContain("This operation was aborted");
  });

  it("classifies an assistant-level provider error", async () => {
    const client = makeClient();
    client.session.prompt.mockResolvedValue({
      data: {
        info: assistantInfo({
          error: { name: "ProviderAuthError", data: { message: "invalid api key" } },
        }),
        parts: [],
      },
    });
    const ctx = makeRunnerCtx(client);

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("provider error: invalid api key");
  });

  it("surfaces a session.error observed during the turn", async () => {
    const client = makeClient();
    const ctx = makeRunnerCtx(client);
    client.session.prompt.mockImplementation(async () => {
      const turn = ctx.currentTurn;
      if (turn) turn.sessionError = "session exploded";
      return { data: { info: assistantInfo(), parts: [] } };
    });

    const result = await runPromptTurn(ctx, {
      text: "go",
      model: sdkModel,
      signal: new AbortController().signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("session error: session exploded");
  });
});

describe("runTurnGuarded", () => {
  it("returns the result when the turn resolves", async () => {
    const ctx = makeRunnerCtx(makeClient());
    const result = await runTurnGuarded(ctx, async () => ({ success: true, output: "ok" }));
    expect(result).toEqual({ success: true, output: "ok" });
  });

  it("converts an escaped throw into a failure result with the turn's text", async () => {
    const ctx = makeRunnerCtx(makeClient());
    ctx.currentTurn = newTurn();
    ctx.currentTurn.finalText = "partial text";

    const result = await runTurnGuarded(ctx, async () => {
      throw new Error("post-prompt bookkeeping exploded");
    });

    expect(result).toEqual({
      success: false,
      output: "partial text",
      error: "post-prompt bookkeeping exploded",
    });
  });
});

describe("buildUsage", () => {
  it("prefers the step-finish accumulator over the final assistant message", () => {
    const turn = newTurn();
    turn.tokens = { input: 100, output: 30, cacheRead: 20, cacheWrite: 10 };
    turn.costUsd = 1.5;

    expect(buildUsage(turn, assistantInfo())).toEqual({
      agent: "terramend",
      inputTokens: 130,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: 1.5,
    });
  });

  it("returns undefined when both the accumulator and the assistant are empty", () => {
    expect(buildUsage(newTurn(), undefined)).toBeUndefined();
    expect(
      buildUsage(
        newTurn(),
        assistantInfo({
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ),
    ).toBeUndefined();
  });
});

describe("startInnerActivityWatchdog", () => {
  it("aborts and notifies after sustained event silence, firing only once", () => {
    vi.useFakeTimers();
    try {
      const onActivityTimeout = vi.fn();
      const ctx = makeRunnerCtx(makeClient(), { onActivityTimeout });
      ctx.lastEventAt = performance.now() - AGENT_ACTIVITY_TIMEOUT_MS - 60_000;
      const abortController = new AbortController();

      const watchdog = startInnerActivityWatchdog({
        ctx,
        timeoutMs: AGENT_ACTIVITY_TIMEOUT_MS,
        abortController,
      });

      vi.advanceTimersByTime(5_000);
      expect(abortController.signal.aborted).toBe(true);
      expect(onActivityTimeout).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(15_000);
      expect(onActivityTimeout).toHaveBeenCalledTimes(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet while events are flowing and tolerates a throwing callback", () => {
    vi.useFakeTimers();
    try {
      const ctx = makeRunnerCtx(makeClient(), {
        onActivityTimeout: vi.fn(() => {
          throw new Error("callback exploded");
        }),
      });
      const abortController = new AbortController();
      const watchdog = startInnerActivityWatchdog({
        ctx,
        timeoutMs: AGENT_ACTIVITY_TIMEOUT_MS,
        abortController,
      });

      ctx.lastEventAt = performance.now();
      vi.advanceTimersByTime(10_000);
      expect(abortController.signal.aborted).toBe(false);

      // now go silent past the budget — the throwing callback must be caught
      ctx.lastEventAt = performance.now() - AGENT_ACTIVITY_TIMEOUT_MS - 60_000;
      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
      expect(abortController.signal.aborted).toBe(true);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("opencode.run", () => {
  function makeRunCtx(overrides?: Partial<AgentRunContext>): {
    ctx: AgentRunContext;
    toolState: ToolState;
    todoTracker: ReturnType<typeof makeTodoTracker>;
    onToolUse: ReturnType<typeof vi.fn>;
  } {
    const dir = mkdtempSync(join(tmpdir(), "terramend-opencode-run-"));
    tempDirs.push(dir);
    const toolState = {} as unknown as ToolState;
    const todoTracker = makeTodoTracker();
    const onToolUse = vi.fn();
    const ctx = {
      payload: {},
      resolvedModel: "anthropic/claude-opus-4-7",
      mcpServerUrl: MCP_URL,
      tmpdir: dir,
      instructions: {
        full: "do the task",
        system: "",
        user: "",
        eventInstructions: "",
        event: "",
        runtime: "",
      },
      toolState,
      todoTracker,
      onToolUse,
      apiToken: "",
      ...overrides,
    } as unknown as AgentRunContext;
    return { ctx, toolState, todoTracker, onToolUse };
  }

  let proc: FakeChildProcess;
  let client: FakeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BEDROCK_MODEL_ID", undefined);
    stubProcessKill();
    proc = new FakeChildProcess();
    nodeSpawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        proc.stdout.emit(
          "data",
          Buffer.from("opencode server listening on http://127.0.0.1:43117\n"),
        );
      });
      return proc as unknown as ReturnType<typeof nodeSpawn>;
    });
    client = makeClient();
    createOpencodeClientMock.mockReturnValue(client as unknown as OpencodeClient);
    // exercise one warm-session resume turn (gate retry / reflection re-entry)
    // before settling on the resumed result.
    runPostRunRetryLoopMock.mockImplementation(async (params) => {
      if (!params.initialResult.success) return params.initialResult;
      return await params.resume({
        prompt: "gate retry prompt",
        previousResult: params.initialResult,
      });
    });
  });

  it("boots the server, runs the prompt turn in-process, and tears everything down", async () => {
    const { ctx, toolState, todoTracker, onToolUse } = makeRunCtx();
    toolState.learningsFilePath = "/tmp/run/learnings.md";
    client.session.prompt.mockImplementation(async () => {
      // server stderr → provider-error attribution (handler attached by run())
      proc.stderr.emit("data", Buffer.from('upstream said "status": 429 try later\n'));
      return {
        data: { info: assistantInfo(), parts: [sdkTextPart("all done", ORCH_SESSION, 9)] },
      };
    });
    client.session.messages.mockResolvedValue({
      data: [
        {
          info: {
            role: "assistant",
            time: { created: Date.now() + 60_000 },
            tokens: { input: 100, output: 25, reasoning: 0, cache: { read: 10, write: 5 } },
            cost: 0.7,
          },
          parts: [
            sdkToolPart({
              tool: "read",
              callID: "call_seen_late",
              status: "completed",
              input: { filePath: "src/x.ts" },
            }),
          ],
        },
      ],
    });

    const result = await opencode.run(ctx);

    expect(result.success).toBe(true);
    expect(result.output).toBe("all done");
    expect(result.usage).toEqual({
      agent: "terramend",
      inputTokens: 115,
      outputTokens: 25,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.7,
    });

    // model propagation: footer badge + SDK prompt model split
    expect(toolState.model).toBe("anthropic/claude-opus-4-7");
    const promptBody = client.session.prompt.mock.calls[0]?.[0] as {
      sessionID: string;
      parts: Array<{ type: string; text: string }>;
      model?: { providerID: string; modelID: string };
    };
    expect(promptBody.sessionID).toBe(ORCH_SESSION);
    expect(promptBody.parts).toEqual([{ type: "text", text: "do the task" }]);
    expect(promptBody.model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-7" });

    // spawn env carries the security config + sandbox + redirected HOME
    const spawnOptions = nodeSpawnMock.mock.calls[0]?.[2] as {
      env: NodeJS.ProcessEnv;
      cwd: string;
    };
    expect(spawnOptions.cwd).toBe(process.cwd());
    expect(spawnOptions.env.HOME).toBe(ctx.tmpdir);
    expect(spawnOptions.env.PWD).toBe(process.cwd());
    const securityConfig = JSON.parse(
      spawnOptions.env.OPENCODE_CONFIG_CONTENT ?? "{}",
    ) as ParsedSecurityConfig;
    expect(securityConfig.model).toBe("anthropic/claude-opus-4-7");
    expect(securityConfig.permission.bash).toBe("deny");
    const permission = JSON.parse(spawnOptions.env.OPENCODE_PERMISSION ?? "{}") as {
      external_directory: Record<string, string>;
    };
    expect(permission.external_directory["*"]).toBe("deny");
    expect(permission.external_directory["/tmp/*"]).toBe("allow");

    // gate plugin dropped into the tmpdir-redirected XDG plugin dir
    expect(
      existsSync(
        join(ctx.tmpdir, ".config", "opencode", "plugin", TERRAMEND_OPENCODE_GATE_PLUGIN_FILENAME),
      ),
    ).toBe(true);

    // client wired against the booted server with the custom undici fetch
    const clientConfig = createOpencodeClientMock.mock.calls[0]?.[0] as {
      baseUrl: string;
      directory: string;
      fetch: typeof fetch;
    };
    expect(clientConfig.baseUrl).toBe("http://127.0.0.1:43117");
    expect(clientConfig.directory).toBe(process.cwd());
    await clientConfig.fetch(new Request("http://127.0.0.1:43117/ping"));
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:43117/ping",
      expect.objectContaining({ method: "GET", duplex: "half" }),
    );

    // stderr provider-error attribution reached the shared diagnostic
    expect(toolState.agentDiagnostic?.lastProviderError).toBe("rate limited (429)");

    // end-of-turn fallback replayed the store-only tool call
    expect(onToolUse).toHaveBeenCalledWith({ toolName: "read", input: { filePath: "src/x.ts" } });

    // success path flushes todos; teardown kills the server process
    expect(todoTracker.flush).toHaveBeenCalledTimes(1);
    expect(todoTracker.cancel).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();
    expect(runPostRunRetryLoopMock).toHaveBeenCalledTimes(1);
    // learningsFilePath + non-skipped mode → reflection prompt wired through
    expect(runPostRunRetryLoopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reflectionPrompt: expect.stringContaining("/tmp/run/learnings.md"),
      }),
    );
  });

  it("redirects XDG_DATA_HOME and strips OPENAI_API_KEY when codex auth is installed", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-should-be-stripped");
    installCodexAuthMock.mockReturnValue({
      authPath: "/var/lib/terramend/opencode/auth.json",
      xdgDataHome: "/var/lib/terramend",
      originalRefresh: "refresh-token-1",
    });
    const { ctx } = makeRunCtx();

    const result = await opencode.run(ctx);

    expect(result.success).toBe(true);
    const spawnOptions = nodeSpawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(spawnOptions.env.XDG_DATA_HOME).toBe("/var/lib/terramend");
    expect("OPENAI_API_KEY" in spawnOptions.env).toBe(false);
  });

  it("fails fast when session.create errors, surviving a teardown kill failure", async () => {
    const { ctx } = makeRunCtx();
    client.session.create.mockResolvedValue({ error: { message: "out of sessions" } });
    // both the group kill and the direct kill fail — close() rejects and the
    // run() finally must swallow it (debug log) without masking the result.
    proc.kill.mockImplementation(() => {
      throw new Error("kill EPERM");
    });

    const result = await opencode.run(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("opencode session.create failed: out of sessions");
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();
  });

  it("cancels the todo tracker when the final verdict is a failure", async () => {
    const { ctx, todoTracker } = makeRunCtx();
    client.session.prompt.mockResolvedValue({ error: { message: "transport down" } });
    // a broken SSE subscription must be survivable (warning, not a crash)
    client.event.subscribe.mockRejectedValue(new Error("sse broke"));

    const result = await opencode.run(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("opencode prompt failed: transport down");
    expect(todoTracker.cancel).toHaveBeenCalled();
    expect(todoTracker.flush).not.toHaveBeenCalled();
    expect(proc.kill).toHaveBeenCalled();
  });
});
