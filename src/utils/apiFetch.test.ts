import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "#app/utils/apiFetch";

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

type FetchArgs = [string, RequestInit];

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastFetchCall(fetchMock: ReturnType<typeof vi.fn>): FetchArgs {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("expected fetch to have been called");
  return call as FetchArgs;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("defaults to GET against the configured API_URL without bypass artifacts", async () => {
    vi.stubEnv("API_URL", "http://localhost:3000");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    const fetchMock = stubFetch();

    await apiFetch({ path: "/api/foo" });

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toBe("http://localhost:3000/api/foo");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
    expect(init.signal).toBeUndefined();
  });

  it("falls back to https://terramend.dev when API_URL is unset", async () => {
    vi.stubEnv("API_URL", "");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    const fetchMock = stubFetch();

    await apiFetch({ path: "/api/foo" });

    const [url] = lastFetchCall(fetchMock);
    expect(url).toBe("https://terramend.dev/api/foo");
  });

  it("adds the Vercel bypass secret as both a query param and a header", async () => {
    vi.stubEnv("API_URL", "http://localhost:3000");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "shh");
    const fetchMock = stubFetch();

    await apiFetch({ path: "/api/foo", method: "POST", body: "{}" });

    const [url, init] = lastFetchCall(fetchMock);
    expect(new URL(url).searchParams.get("x-vercel-protection-bypass")).toBe("shh");
    expect(init.headers).toMatchObject({ "x-vercel-protection-bypass": "shh" });
  });

  it("strips Content-Type headers (any casing) from body-less requests", async () => {
    vi.stubEnv("API_URL", "http://localhost:3000");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    const fetchMock = stubFetch();

    await apiFetch({
      path: "/api/foo",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    });

    const [, init] = lastFetchCall(fetchMock);
    expect(init.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("keeps Content-Type and forwards body, method, and signal when a body is present", async () => {
    vi.stubEnv("API_URL", "http://localhost:3000");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "");
    const fetchMock = stubFetch();
    const controller = new AbortController();

    await apiFetch({
      path: "/api/foo",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
      signal: controller.signal,
    });

    const [, init] = lastFetchCall(fetchMock);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe('{"a":1}');
    expect(init.signal).toBe(controller.signal);
  });

  it("propagates getApiUrl validation errors without fetching", async () => {
    vi.stubEnv("API_URL", "https://evil.example.com");
    const fetchMock = stubFetch();

    await expect(apiFetch({ path: "/api/foo" })).rejects.toThrow("is not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
