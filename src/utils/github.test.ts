import { generateKeyPairSync } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as core from "@actions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "#app/utils/apiFetch";
import {
  acquireNewToken,
  createOctokit,
  ensureGitHubToken,
  parseRepoContext,
  type UsageSummary,
  writeGitHubUsageSummaryToFile,
} from "#app/utils/github";

vi.mock("#app/utils/apiFetch", () => ({
  apiFetch: vi.fn(),
}));

const retryState = vi.hoisted(() => ({
  lastOptions: undefined as
    | { label?: string; shouldRetry?: (error: unknown) => boolean }
    | undefined,
}));

vi.mock("#app/utils/retry", () => ({
  retry: vi.fn(
    async (
      fn: () => Promise<unknown>,
      options?: { label?: string; shouldRetry?: (error: unknown) => boolean },
    ) => {
      retryState.lastOptions = options;
      return fn();
    },
  ),
}));

vi.mock("@actions/core", () => ({
  getIDToken: vi.fn(async () => "oidc-token"),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
}));

const apiFetchMock = vi.mocked(apiFetch);

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init?.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubNoOidcEnv(): void {
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "");
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "");
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_APP_ID", "");
  vi.stubEnv("GITHUB_PRIVATE_KEY", "");
}

function stubOidcEnv(): void {
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_URL", "https://token.example");
  vi.stubEnv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "req-token");
}

const savedGithubToken = process.env.GITHUB_TOKEN;

beforeEach(() => {
  retryState.lastOptions = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (savedGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = savedGithubToken;
  }
});

describe("parseRepoContext", () => {
  it("parses owner and name from GITHUB_REPOSITORY", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    expect(parseRepoContext()).toEqual({ owner: "acme", name: "widgets" });
  });

  it("throws when GITHUB_REPOSITORY is unset", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "");
    expect(() => parseRepoContext()).toThrow("GITHUB_REPOSITORY environment variable is required");
  });

  it("throws on a malformed value", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "no-slash");
    expect(() => parseRepoContext()).toThrow("Invalid GITHUB_REPOSITORY format: no-slash");
  });

  it("throws when the repo part is empty", () => {
    vi.stubEnv("GITHUB_REPOSITORY", "acme/");
    expect(() => parseRepoContext()).toThrow("Invalid GITHUB_REPOSITORY format");
  });
});

describe("acquireNewToken — OIDC path", () => {
  it("exchanges the OIDC token and appends the target repo to the repos param", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue(jsonResponse({ token: "installation-token" }));

    await expect(acquireNewToken()).resolves.toBe("installation-token");

    expect(core.getIDToken).toHaveBeenCalledWith("terramend-api");
    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/github/installation-token?repos=widgets",
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer oidc-token" }),
      }),
    );
  });

  it("merges explicit repos with the target repo and sends permissions in the body", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue(jsonResponse({ token: "t" }));

    await acquireNewToken({ repos: ["other"], permissions: { contents: "write" } });

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/github/installation-token?repos=other,widgets",
        body: JSON.stringify({ permissions: { contents: "write" } }),
      }),
    );
  });

  it("omits the repos param when no repos are known", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "");
    apiFetchMock.mockResolvedValue(jsonResponse({ token: "t" }));

    await acquireNewToken();

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/api/github/installation-token" }),
    );
  });

  it("surfaces the server-provided error message on a non-2xx response", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue(
      jsonResponse({ error: "app not installed — visit https://example/install" }, { status: 404 }),
    );

    await expect(acquireNewToken()).rejects.toThrow(
      "app not installed — visit https://example/install",
    );
  });

  it("falls back to a generic message when the error field is not a string", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue(
      jsonResponse({ error: 42 }, { status: 503, statusText: "Service Unavailable" }),
    );

    await expect(acquireNewToken()).rejects.toThrow(
      "Token exchange failed: 503 Service Unavailable",
    );
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    await expect(acquireNewToken()).rejects.toThrow("Token exchange failed: 502 Bad Gateway");
  });

  it("aborts the exchange via the 30s timeout controller", async () => {
    vi.useFakeTimers();
    try {
      stubOidcEnv();
      vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
      apiFetchMock.mockImplementation(
        (options) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => {
              const abortError = new Error("aborted");
              abortError.name = "AbortError";
              reject(abortError);
            });
          }),
      );

      const pending = expect(acquireNewToken()).rejects.toThrow(
        "Token exchange timed out after 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps AbortError to a timeout message", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    apiFetchMock.mockRejectedValue(abortError);

    await expect(acquireNewToken()).rejects.toThrow("Token exchange timed out after 30000ms");
  });

  it("retries 5xx and 429 token-exchange failures but not 4xx", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");

    const errorForStatus = async (status: number): Promise<unknown> => {
      apiFetchMock.mockResolvedValueOnce(jsonResponse({ error: `status ${status}` }, { status }));
      return acquireNewToken().then(
        () => {
          throw new Error("expected acquireNewToken to reject");
        },
        (error: unknown) => error,
      );
    };

    const notFound = await errorForStatus(404);
    const serverError = await errorForStatus(500);
    const rateLimited = await errorForStatus(429);

    const shouldRetry = retryState.lastOptions?.shouldRetry;
    if (!shouldRetry) throw new Error("expected retry options to have been captured");

    expect(shouldRetry(notFound)).toBe(false);
    expect(shouldRetry(serverError)).toBe(true);
    expect(shouldRetry(rateLimited)).toBe(true);
  });

  it("retries plain network errors by message, but not unrelated errors", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    apiFetchMock.mockResolvedValue(jsonResponse({ token: "t" }));
    await acquireNewToken();

    const shouldRetry = retryState.lastOptions?.shouldRetry;
    if (!shouldRetry) throw new Error("expected retry options to have been captured");

    expect(shouldRetry(new Error("fetch failed"))).toBe(true);
    expect(shouldRetry(new Error("Token exchange timed out after 30000ms"))).toBe(true);
    expect(shouldRetry(new Error("read ECONNRESET"))).toBe(true);
    expect(shouldRetry(new Error("connect ETIMEDOUT"))).toBe(true);
    expect(shouldRetry(new Error("schema validation failed"))).toBe(false);
    expect(shouldRetry("not an error")).toBe(false);
  });
});

describe("acquireNewToken — no OIDC", () => {
  it("explains the missing id-token permission when running in GitHub Actions", async () => {
    stubNoOidcEnv();
    vi.stubEnv("GITHUB_ACTIONS", "true");

    await expect(acquireNewToken()).rejects.toThrow(
      "missing `permissions: id-token: write` on the Terramend workflow job",
    );
  });

  it("requires GitHub App credentials for local development", async () => {
    stubNoOidcEnv();

    await expect(acquireNewToken()).rejects.toThrow(
      "GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set",
    );
  });
});

describe("acquireNewToken — GitHub App path (local dev)", () => {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  function stubAppEnv(): void {
    stubNoOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    vi.stubEnv("GITHUB_APP_ID", "12345");
    // encode with literal \n to exercise the unescaping in acquireTokenViaGitHubApp
    vi.stubEnv("GITHUB_PRIVATE_KEY", privateKey.replace(/\n/g, "\\n"));
  }

  it("signs a JWT, finds the installation with repo access, and mints a token", async () => {
    stubAppEnv();
    const tokensByInstallation: Record<string, string[]> = {
      "11": ["tmp-11"],
      "22": ["tmp-22", "final-22"],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/app/installations") {
        const headers = init?.headers as Record<string, string>;
        // a real three-segment JWT must be presented
        expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
        return jsonResponse([
          { id: 11, account: { login: "someone-else", type: "User" } },
          { id: 22, account: { login: "acme", type: "Organization" } },
        ]);
      }
      const tokenMatch = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (tokenMatch) {
        const queue = tokensByInstallation[tokenMatch[1] ?? ""] ?? [];
        const token = queue.shift();
        return jsonResponse({ token, expires_at: "soon" });
      }
      if (path === "/installation/repositories") {
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === "token tmp-22") {
          return jsonResponse({ repositories: [{ owner: { login: "ACME" }, name: "Widgets" }] });
        }
        return jsonResponse({ repositories: [{ owner: { login: "someone-else" }, name: "x" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireNewToken({ permissions: { contents: "write" } })).resolves.toBe("final-22");

    // the final mint carries the requested permissions in the body
    const finalCall = fetchMock.mock.calls.at(-1);
    if (!finalCall) throw new Error("expected a final access_tokens call");
    expect(finalCall[1]?.body).toBe(JSON.stringify({ permissions: { contents: "write" } }));
  });

  it("throws when no installation has access to the target repository", async () => {
    stubAppEnv();
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/app/installations") {
        return jsonResponse([{ id: 11, account: { login: "someone-else", type: "User" } }]);
      }
      if (path.endsWith("/access_tokens")) {
        return jsonResponse({ token: "tmp", expires_at: "soon" });
      }
      if (path === "/installation/repositories") {
        // checkRepositoryAccess swallows this failure and reports no access
        return jsonResponse({ message: "boom" }, { status: 500, statusText: "Server Error" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireNewToken()).rejects.toThrow(
      "No installation found with access to acme/widgets",
    );
  });

  it("skips installations whose token mint fails and keeps searching", async () => {
    stubAppEnv();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/app/installations") {
        return jsonResponse([
          { id: 11, account: { login: "a", type: "User" } },
          { id: 22, account: { login: "acme", type: "Organization" } },
        ]);
      }
      if (path === "/app/installations/11/access_tokens") {
        return jsonResponse({ message: "nope" }, { status: 403, statusText: "Forbidden" });
      }
      if (path === "/app/installations/22/access_tokens") {
        return jsonResponse({ token: "t22", expires_at: "soon" });
      }
      if (path === "/installation/repositories") {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("token t22");
        return jsonResponse({ repositories: [{ owner: { login: "acme" }, name: "widgets" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(acquireNewToken()).resolves.toBe("t22");
  });

  it("ensureGitHubToken exports the minted app token when no token exists", async () => {
    stubAppEnv();
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const tokens = ["tmp-22", "final-22"];
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/app/installations") {
        return jsonResponse([{ id: 22, account: { login: "acme", type: "Organization" } }]);
      }
      if (path === "/app/installations/22/access_tokens") {
        return jsonResponse({ token: tokens.shift(), expires_at: "soon" });
      }
      if (path === "/installation/repositories") {
        return jsonResponse({ repositories: [{ owner: { login: "acme" }, name: "widgets" }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await ensureGitHubToken();

    expect(process.env.GITHUB_TOKEN).toBe("final-22");
  });
});

describe("ensureGitHubToken", () => {
  it("always mints a fresh token when OIDC is available", async () => {
    stubOidcEnv();
    vi.stubEnv("GITHUB_REPOSITORY", "acme/widgets");
    vi.stubEnv("GITHUB_TOKEN", "stale-runner-token");
    apiFetchMock.mockResolvedValue(jsonResponse({ token: "fresh-token" }));

    await ensureGitHubToken();

    expect(process.env.GITHUB_TOKEN).toBe("fresh-token");
  });

  it("keeps an existing GITHUB_TOKEN when OIDC is unavailable", async () => {
    stubNoOidcEnv();
    vi.stubEnv("GITHUB_TOKEN", "existing");

    await ensureGitHubToken();

    expect(process.env.GITHUB_TOKEN).toBe("existing");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("accepts GH_TOKEN as an existing credential", async () => {
    stubNoOidcEnv();
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "gh-existing");

    await ensureGitHubToken();

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("propagates acquisition failures when no token source exists", async () => {
    stubNoOidcEnv();
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");

    await expect(ensureGitHubToken()).rejects.toThrow(
      "GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set",
    );
  });
});

describe("writeGitHubUsageSummaryToFile", () => {
  async function writtenSummary(path: string): Promise<UsageSummary> {
    await writeGitHubUsageSummaryToFile(path);
    const call = vi.mocked(writeFile).mock.calls.at(-1);
    if (!call) throw new Error("expected writeFile to have been called");
    return JSON.parse(String(call[1])) as UsageSummary;
  }

  it("writes the summary atomically via a temp file in the same directory", async () => {
    const target = join("out", "usage.json");
    const summary = await writtenSummary(target);

    const expectedTmp = join(dirname(target), `.usage-summary-${process.pid}.tmp`);
    expect(writeFile).toHaveBeenCalledWith(expectedTmp, expect.any(String));
    expect(rename).toHaveBeenCalledWith(expectedTmp, target);
    expect(summary.version).toBe(1);
    expect(summary.github.core).toMatchObject({ requestCount: expect.any(Number) });
    expect(summary.github.graphql).toMatchObject({ requestCount: expect.any(Number) });
  });

  it("tracks octokit request usage from rate-limit headers, including error responses", async () => {
    const target = join("out", "usage.json");
    const before = await writtenSummary(target);

    const octokit = createOctokit("test-token");

    const okFetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "42",
            "x-ratelimit-reset": "100",
          },
        }),
    );
    await octokit.request("GET /zen", { request: { fetch: okFetch } });

    const middle = await writtenSummary(target);
    expect(middle.github.core.requestCount).toBe(before.github.core.requestCount + 1);
    expect(middle.github.core.rateLimitRemaining).toBe(42);
    expect(middle.github.core.rateLimitResetMs).toBe(100_000);

    // a failing request still records usage from the error response headers
    const errorFetch = vi.fn(
      async () =>
        new Response('{"message":"not found"}', {
          status: 404,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "7",
          },
        }),
    );
    await expect(
      octokit.request("GET /missing", { request: { fetch: errorFetch } }),
    ).rejects.toThrow();

    // a response without the resource header is ignored
    const headerlessFetch = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await octokit.request("GET /zen", { request: { fetch: headerlessFetch } });

    // a resource without rate-limit headers counts the request but keeps nulls
    const graphqlFetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "x-ratelimit-resource": "graphql" },
        }),
    );
    await octokit.request("GET /zen", { request: { fetch: graphqlFetch } });

    // a plain network failure carries no response and records nothing
    const brokenFetch = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(
      octokit.request("GET /zen", { request: { fetch: brokenFetch, retries: 0 } }),
    ).rejects.toThrow();

    const after = await writtenSummary(target);
    expect(after.github.core.requestCount).toBe(before.github.core.requestCount + 2);
    expect(after.github.core.rateLimitRemaining).toBe(7);
    // reset header was absent on the error response — previous value sticks
    expect(after.github.core.rateLimitResetMs).toBe(100_000);
    expect(after.github.graphql.requestCount).toBe(before.github.graphql.requestCount + 1);
    expect(after.github.graphql.rateLimitRemaining).toBeNull();
    expect(after.github.graphql.rateLimitResetMs).toBeNull();
  });

  it("retries a primary rate-limited request once via the throttling plugin", async () => {
    const octokit = createOctokit("test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"message":"API rate limit exceeded"}', {
          status: 403,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "0",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );

    const response = await octokit.request("GET /zen", { request: { fetch: fetchMock } });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a secondary rate-limited request once via the throttling plugin", {
    timeout: 10_000,
  }, async () => {
    const octokit = createOctokit("test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"message":"You have exceeded a secondary rate limit"}', {
          status: 403,
          // "0" is falsy and makes the plugin fall back to a 60s wait — use 1s
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      );

    const response = await octokit.request("GET /zen", { request: { fetch: fetchMock } });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
