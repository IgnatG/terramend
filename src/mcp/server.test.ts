import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { FastMCP } from "fastmcp";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { startMcpHttpServer, type ToolContext } from "#app/mcp/server";
import { initToolState } from "#app/toolState";

type McpHandle = Awaited<ReturnType<typeof startMcpHttpServer>>;

type CtxOverrides = {
  trigger?: string;
  shell?: "restricted" | "enabled" | "disabled";
};

function makeCtx(overrides: CtxOverrides = {}): ToolContext {
  const ctx = {
    agentId: "claude",
    repo: {
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      data: { default_branch: "main" },
    },
    payload: {
      event: { trigger: overrides.trigger ?? "unknown" },
      shell: overrides.shell ?? "restricted",
      push: "enabled",
      model: "anthropic/claude-opus-4",
    },
    octokit: {},
    githubInstallationToken: "ghs_installation",
    gitToken: "ghs_git",
    apiToken: "api_jwt",
    modes: [],
    postCheckoutScript: null,
    prepushScript: null,
    prApproveEnabled: false,
    modeInstructions: {},
    toolState: initToolState({ progressComment: undefined }),
    runId: undefined,
    mcpServerUrl: "",
    tmpdir: tmpdir(),
    oss: false,
    plan: "none",
    resolvedModel: "anthropic/claude-opus-4",
  };
  return ctx as unknown as ToolContext;
}

function occupyPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind blocker port"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

let handle: McpHandle | undefined;
let addToolSpy: MockInstance<FastMCP["addTool"]>;

function registeredToolNames(): string[] {
  return addToolSpy.mock.calls.map((call) => (call[0] as { name: string }).name);
}

beforeEach(() => {
  addToolSpy = vi.spyOn(FastMCP.prototype, "addTool");
});

afterEach(async () => {
  if (handle) {
    await handle[Symbol.asyncDispose]();
    handle = undefined;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("startMcpHttpServer", () => {
  it("starts on a loopback port and serves the /mcp endpoint", async () => {
    handle = await startMcpHttpServer(makeCtx());
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    // the port is actually listening — a GET reaches the http-stream transport
    const res = await fetch(handle.url);
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  it("registers orchestrator tools including push/PR and standalone set_output", async () => {
    handle = await startMcpHttpServer(makeCtx({ trigger: "unknown", shell: "restricted" }));

    const names = registeredToolNames();
    expect(names).toContain("git");
    expect(names).toContain("push_branch");
    expect(names).toContain("create_pull_request");
    expect(names).toContain("select_mode");
    expect(names).toContain("report_progress");
    expect(names).toContain("terraform_scan");
    // standalone trigger → set_output available even without an output schema
    expect(names).toContain("set_output");
    // restricted shell → MCP shell + kill tools
    expect(names).toContain("shell");
  });

  it("omits set_output and shell tools when not standalone and shell is enabled", async () => {
    handle = await startMcpHttpServer(makeCtx({ trigger: "issue_comment", shell: "enabled" }));

    const names = registeredToolNames();
    expect(names).not.toContain("set_output");
    expect(names).not.toContain("shell");
    expect(names).not.toContain("kill_background");
  });

  it("registers set_output for event runs when an output schema is provided", async () => {
    handle = await startMcpHttpServer(makeCtx({ trigger: "issue_comment", shell: "enabled" }), {
      outputSchema: {
        type: "object",
        properties: { verdict: { type: "string" } },
        required: ["verdict"],
      },
    });

    expect(registeredToolNames()).toContain("set_output");
  });
});

describe("port selection", () => {
  it("honors TERRAMEND_MCP_PORT when the port is free", async () => {
    // find a free port, then release it for the server to claim
    const { server, port } = await occupyPort();
    await closeServer(server);

    vi.stubEnv("TERRAMEND_MCP_PORT", String(port));
    handle = await startMcpHttpServer(makeCtx());
    expect(handle.url).toBe(`http://127.0.0.1:${port}/mcp`);
  });

  it("falls back to scanning when TERRAMEND_MCP_PORT is occupied", async () => {
    const { server, port } = await occupyPort();
    try {
      vi.stubEnv("TERRAMEND_MCP_PORT", String(port));
      handle = await startMcpHttpServer(makeCtx());
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(handle.url).not.toContain(`:${port}/`);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects an invalid TERRAMEND_MCP_PORT", async () => {
    vi.stubEnv("TERRAMEND_MCP_PORT", "not-a-port");
    await expect(startMcpHttpServer(makeCtx())).rejects.toThrow(
      "invalid TERRAMEND_MCP_PORT: not-a-port",
    );
  });

  it("rejects an out-of-range TERRAMEND_MCP_PORT", async () => {
    vi.stubEnv("TERRAMEND_MCP_PORT", "70000");
    await expect(startMcpHttpServer(makeCtx())).rejects.toThrow(
      "invalid TERRAMEND_MCP_PORT: 70000",
    );
  });

  it("retries the scan when a start loses the bind race (EADDRINUSE)", async () => {
    const startSpy = vi.spyOn(FastMCP.prototype, "start");
    startSpy.mockRejectedValueOnce(new Error("listen EADDRINUSE: address already in use"));

    handle = await startMcpHttpServer(makeCtx());
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails with a diagnostic when every candidate port loses the bind race", async () => {
    // every start attempt loses the race: isPortAvailable says free, but the
    // transport bind fails with EADDRINUSE. exhausts the whole scan range.
    const startSpy = vi.spyOn(FastMCP.prototype, "start");
    startSpy.mockRejectedValue(new Error("listen EADDRINUSE: address already in use"));

    await expect(startMcpHttpServer(makeCtx())).rejects.toThrow(
      /could not find available mcp port starting at 3764/,
    );
  }, 30_000);

  it("rethrows non-EADDRINUSE start failures immediately", async () => {
    const startSpy = vi.spyOn(FastMCP.prototype, "start");
    startSpy.mockRejectedValue(new Error("transport exploded"));

    await expect(startMcpHttpServer(makeCtx())).rejects.toThrow("transport exploded");
  });
});

describe("disposal", () => {
  it("stops the server and is idempotent on repeated dispose", async () => {
    const localHandle = await startMcpHttpServer(makeCtx());
    const url = localHandle.url;

    await localHandle[Symbol.asyncDispose]();
    const err = await fetch(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);

    // second dispose is a no-op, not a crash
    await expect(localHandle[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it("SIGTERMs then SIGKILLs tracked background process groups on dispose", async () => {
    const ctx = makeCtx();
    ctx.toolState.backgroundProcesses.set("bg-1", {
      pid: 424242,
      outputPath: "/tmp/out.log",
      pidPath: "/tmp/out.pid",
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const localHandle = await startMcpHttpServer(ctx);
    await localHandle[Symbol.asyncDispose]();

    expect(killSpy).toHaveBeenCalledWith(-424242, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-424242, "SIGKILL");
    expect(ctx.toolState.backgroundProcesses.size).toBe(0);
  });

  it("survives kill() throwing for already-dead processes", async () => {
    const ctx = makeCtx();
    ctx.toolState.backgroundProcesses.set("bg-dead", {
      pid: 434343,
      outputPath: "/tmp/out.log",
      pidPath: "/tmp/out.pid",
    });

    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const localHandle = await startMcpHttpServer(ctx);
    await expect(localHandle[Symbol.asyncDispose]()).resolves.toBeUndefined();
    expect(ctx.toolState.backgroundProcesses.size).toBe(0);
  });
});
