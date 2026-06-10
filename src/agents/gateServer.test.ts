import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GateServerHandle, startGateServer } from "#app/agents/gateServer";
import type { AgentRunContext, PostRunIssues } from "#app/agents/shared";

const collectPostRunIssuesMock = vi.fn();
const shouldRunReflectionMock = vi.fn();

vi.mock("#app/agents/postRun", () => ({
  collectPostRunIssues: (ctx: unknown, opts: unknown) => collectPostRunIssuesMock(ctx, opts),
  buildPostRunPrompt: (issues: PostRunIssues) => `post-run prompt: ${JSON.stringify(issues)}`,
  buildLearningsReflectionPrompt: (path: string) => `reflection prompt for ${path}`,
  shouldRunReflection: (mode: string | undefined) => shouldRunReflectionMock(mode),
}));

const noIssues: PostRunIssues = {};
const dirtyIssues: PostRunIssues = { dirtyTree: "M src/main.tf" };

function makeCtx(
  toolState: { learningsFilePath?: string; selectedMode?: string } = {},
): AgentRunContext {
  return { toolState } as unknown as AgentRunContext;
}

let handle: GateServerHandle | undefined;

async function startServer(ctx: AgentRunContext): Promise<GateServerHandle> {
  handle = await startGateServer(ctx);
  return handle;
}

function gateFetch(server: GateServerHandle, init?: RequestInit): Promise<Response> {
  return fetch(server.url, {
    headers: { authorization: `Bearer ${server.token}` },
    ...init,
  });
}

beforeEach(() => {
  collectPostRunIssuesMock.mockResolvedValue(noIssues);
  shouldRunReflectionMock.mockReturnValue(false);
});

afterEach(async () => {
  if (handle) {
    await handle[Symbol.asyncDispose]();
    handle = undefined;
  }
  vi.clearAllMocks();
});

describe("gate server routing and auth", () => {
  it("binds a loopback url and a uuid bearer token", async () => {
    const server = await startServer(makeCtx());
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gates$/);
    expect(server.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns 404 for unknown paths and non-GET methods", async () => {
    const server = await startServer(makeCtx());

    const wrongPath = await fetch(server.url.replace("/gates", "/other"), {
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await gateFetch(server, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
    });
    expect(wrongMethod.status).toBe(404);
  });

  it("rejects missing or wrong bearer tokens without consuming budget", async () => {
    collectPostRunIssuesMock.mockResolvedValue(dirtyIssues);
    const server = await startServer(makeCtx());

    const noAuth = await fetch(server.url);
    expect(noAuth.status).toBe(403);

    const wrongAuth = await fetch(server.url, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrongAuth.status).toBe(403);

    // gate state was never read — the budget is untouched
    expect(collectPostRunIssuesMock).not.toHaveBeenCalled();

    // all MAX_POST_RUN_RETRIES blocks are still available afterwards
    for (let i = 0; i < 3; i++) {
      const res = await gateFetch(server);
      expect(await res.json()).toMatchObject({ block: true });
    }
  });
});

describe("gate decisions", () => {
  it("allows the stop when gates are clean and no reflection is pending", async () => {
    const server = await startServer(makeCtx());
    const res = await gateFetch(server);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ block: false });
  });

  it("blocks with the combined gate prompt while issues persist", async () => {
    collectPostRunIssuesMock.mockResolvedValue(dirtyIssues);
    const server = await startServer(makeCtx());

    const res = await gateFetch(server);
    const body = (await res.json()) as { block: boolean; reason: string };
    expect(body.block).toBe(true);
    expect(body.reason).toContain("post-run prompt:");
    expect(body.reason).toContain("M src/main.tf");
  });

  it("allows the stop once the retry budget is exhausted (terminal hard-fail)", async () => {
    collectPostRunIssuesMock.mockResolvedValue(dirtyIssues);
    const server = await startServer(makeCtx());

    for (let i = 0; i < 3; i++) {
      const res = await gateFetch(server);
      expect(await res.json()).toMatchObject({ block: true });
    }

    const exhausted = await gateFetch(server);
    expect(await exhausted.json()).toEqual({ block: false });
  });

  it("nudges summaryStale exactly once, then skips it on later collections", async () => {
    collectPostRunIssuesMock
      .mockResolvedValueOnce({ summaryStale: { filePath: "/tmp/summary.md" } })
      .mockResolvedValue(noIssues);
    const server = await startServer(makeCtx());

    const first = await gateFetch(server);
    expect(await first.json()).toMatchObject({ block: true });
    expect(collectPostRunIssuesMock).toHaveBeenLastCalledWith(expect.anything(), {
      skipSummaryStale: false,
    });

    const second = await gateFetch(server);
    expect(await second.json()).toEqual({ block: false });
    expect(collectPostRunIssuesMock).toHaveBeenLastCalledWith(expect.anything(), {
      skipSummaryStale: true,
    });
  });

  it("delivers the reflection nudge once when gates are clean", async () => {
    shouldRunReflectionMock.mockReturnValue(true);
    const server = await startServer(
      makeCtx({ learningsFilePath: "/tmp/learnings.md", selectedMode: "Remediate" }),
    );

    const first = await gateFetch(server);
    const body = (await first.json()) as { block: boolean; reason: string };
    expect(body.block).toBe(true);
    expect(body.reason).toBe("reflection prompt for /tmp/learnings.md");
    expect(shouldRunReflectionMock).toHaveBeenCalledWith("Remediate");

    // one-shot: the second stop is allowed
    const second = await gateFetch(server);
    expect(await second.json()).toEqual({ block: false });
  });

  it("skips reflection when no learnings file was seeded", async () => {
    shouldRunReflectionMock.mockReturnValue(true);
    const server = await startServer(makeCtx({ selectedMode: "Remediate" }));

    const res = await gateFetch(server);
    expect(await res.json()).toEqual({ block: false });
    expect(shouldRunReflectionMock).not.toHaveBeenCalled();
  });

  it("skips reflection when the selected mode opts out", async () => {
    shouldRunReflectionMock.mockReturnValue(false);
    const server = await startServer(
      makeCtx({ learningsFilePath: "/tmp/learnings.md", selectedMode: "Review" }),
    );

    const res = await gateFetch(server);
    expect(await res.json()).toEqual({ block: false });
  });

  it("allows the stop when the gate collection itself throws", async () => {
    collectPostRunIssuesMock.mockRejectedValue(new Error("github 500"));
    const server = await startServer(makeCtx());

    const res = await gateFetch(server);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ block: false });
  });
});

describe("gate server disposal", () => {
  it("stops accepting connections after dispose", async () => {
    const server = await startServer(makeCtx());
    const url = server.url;
    await server[Symbol.asyncDispose]();
    handle = undefined;

    const err = await fetch(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
