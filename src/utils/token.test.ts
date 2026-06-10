import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getInputMock = vi.fn((_name: string): string => "");
const setSecretMock = vi.fn();
const acquireNewTokenMock = vi.fn();
const onExitSignalMock = vi.fn((_handler: unknown) => removeSignalHandlerMock);
const removeSignalHandlerMock = vi.fn();

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  getInput: (name: string) => getInputMock(name),
  setSecret: (value: string) => setSecretMock(value),
}));

vi.mock("#app/utils/github", () => ({
  acquireNewToken: (opts: unknown) => acquireNewTokenMock(opts),
}));

const globalsState = { isGitHubActions: true };

vi.mock("#app/utils/globals", () => ({
  get isGitHubActions() {
    return globalsState.isGitHubActions;
  },
}));

vi.mock("#app/utils/exitHandler", () => ({
  onExitSignal: (handler: unknown) => onExitSignalMock(handler),
}));

// resolveTokens guards module-level token state with an assert, so each test
// imports a fresh module instance.
async function loadToken() {
  vi.resetModules();
  return await import("#app/utils/token");
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GITHUB_API_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  globalsState.isGitHubActions = true;
});

describe("getJobToken", () => {
  it("prefers the workflow token input", async () => {
    const { getJobToken } = await loadToken();
    getInputMock.mockReturnValueOnce("input-token");
    vi.stubEnv("GH_TOKEN", "gh-token");
    expect(getJobToken()).toBe("input-token");
  });

  it("falls back to GH_TOKEN when the input is empty", async () => {
    const { getJobToken } = await loadToken();
    vi.stubEnv("GH_TOKEN", "gh-token");
    vi.stubEnv("GITHUB_TOKEN", "actions-token");
    expect(getJobToken()).toBe("gh-token");
  });

  it("falls back to GITHUB_TOKEN when GH_TOKEN is unset", async () => {
    const { getJobToken } = await loadToken();
    vi.stubEnv("GITHUB_TOKEN", "actions-token");
    expect(getJobToken()).toBe("actions-token");
  });

  it("throws when no token source is available", async () => {
    const { getJobToken } = await loadToken();
    expect(() => getJobToken()).toThrow("token input is required");
  });
});

describe("resolveTokens with external GH_TOKEN", () => {
  it("uses the external token for both git and MCP and masks it", async () => {
    const token = await loadToken();
    vi.stubEnv("GH_TOKEN", "external-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    expect(ref.gitToken).toBe("external-token");
    expect(ref.mcpToken).toBe("external-token");
    expect(setSecretMock).toHaveBeenCalledWith("external-token");
    expect(acquireNewTokenMock).not.toHaveBeenCalled();
    expect(token.getGitHubInstallationToken()).toBe("external-token");

    await ref[Symbol.asyncDispose]();
    // dispose clears the stored value but does NOT revoke the user's own token
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => token.getGitHubInstallationToken()).toThrow(/tokens not set/);
  });
});

describe("resolveTokens with acquired installation tokens", () => {
  it("acquires a read-only git token when push is disabled", async () => {
    const token = await loadToken();
    acquireNewTokenMock.mockResolvedValueOnce("git-token").mockResolvedValueOnce("mcp-token");

    const ref = await token.resolveTokens({ push: "disabled" });
    expect(acquireNewTokenMock).toHaveBeenNthCalledWith(1, {
      permissions: { contents: "read" },
    });
    expect(ref.gitToken).toBe("git-token");
    expect(ref.mcpToken).toBe("mcp-token");
    await ref[Symbol.asyncDispose]();
  });

  it("acquires a write git token (with workflows) when push is enabled", async () => {
    const token = await loadToken();
    acquireNewTokenMock.mockResolvedValueOnce("git-token").mockResolvedValueOnce("mcp-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    expect(acquireNewTokenMock).toHaveBeenNthCalledWith(1, {
      permissions: { contents: "write", workflows: "write" },
    });
    expect(acquireNewTokenMock).toHaveBeenNthCalledWith(2, {
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        checks: "read",
        actions: "read",
      },
    });
    expect(setSecretMock).toHaveBeenCalledWith("git-token");
    expect(setSecretMock).toHaveBeenCalledWith("mcp-token");
    expect(token.getGitHubInstallationToken()).toBe("mcp-token");
    await ref[Symbol.asyncDispose]();
  });

  it("skips secret masking outside GitHub Actions", async () => {
    const token = await loadToken();
    globalsState.isGitHubActions = false;
    acquireNewTokenMock.mockResolvedValueOnce("git-token").mockResolvedValueOnce("mcp-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    expect(setSecretMock).not.toHaveBeenCalled();
    await ref[Symbol.asyncDispose]();
  });

  it("skips masking the external token outside GitHub Actions", async () => {
    const token = await loadToken();
    globalsState.isGitHubActions = false;
    vi.stubEnv("GH_TOKEN", "external-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    expect(setSecretMock).not.toHaveBeenCalled();
    await ref[Symbol.asyncDispose]();
  });

  it("rejects a second resolveTokens call while tokens are live", async () => {
    const token = await loadToken();
    acquireNewTokenMock.mockResolvedValue("some-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    await expect(token.resolveTokens({ push: "enabled" })).rejects.toThrow(
      /tokens are already resolved/,
    );
    await ref[Symbol.asyncDispose]();
  });

  it("dispose revokes both tokens and removes the exit-signal handler", async () => {
    const token = await loadToken();
    acquireNewTokenMock.mockResolvedValueOnce("git-token").mockResolvedValueOnce("mcp-token");

    const ref = await token.resolveTokens({ push: "restricted" });
    expect(onExitSignalMock).toHaveBeenCalledTimes(1);

    await ref[Symbol.asyncDispose]();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const tokensRevoked = fetchMock.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    );
    expect(tokensRevoked.map((h) => h.Authorization).sort()).toEqual([
      "Bearer git-token",
      "Bearer mcp-token",
    ]);
    expect(removeSignalHandlerMock).toHaveBeenCalledTimes(1);
    expect(() => token.getGitHubInstallationToken()).toThrow(/tokens not set/);
  });

  it("concurrent dispose calls share the in-flight revocation", async () => {
    const token = await loadToken();
    acquireNewTokenMock.mockResolvedValueOnce("git-token").mockResolvedValueOnce("mcp-token");

    const ref = await token.resolveTokens({ push: "enabled" });
    await Promise.all([ref[Symbol.asyncDispose](), ref[Symbol.asyncDispose]()]);

    // 2 revocations total, not 4 — the second dispose awaited the first
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("revokeGitHubInstallationToken", () => {
  it("DELETEs the installation token with auth headers", async () => {
    const { revokeGitHubInstallationToken } = await loadToken();
    await revokeGitHubInstallationToken("revoke-me");

    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer revoke-me",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  });

  it("honors GITHUB_API_URL for GitHub Enterprise Server", async () => {
    const { revokeGitHubInstallationToken } = await loadToken();
    vi.stubEnv("GITHUB_API_URL", "https://ghe.example.com/api/v3");
    await revokeGitHubInstallationToken("revoke-me");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ghe.example.com/api/v3/installation/token",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("swallows revocation failures instead of throwing", async () => {
    const { revokeGitHubInstallationToken } = await loadToken();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(revokeGitHubInstallationToken("revoke-me")).resolves.toBeUndefined();
  });

  it("swallows non-Error revocation rejections too", async () => {
    const { revokeGitHubInstallationToken } = await loadToken();
    fetchMock.mockRejectedValueOnce("string failure");
    await expect(revokeGitHubInstallationToken("revoke-me")).resolves.toBeUndefined();
  });
});
