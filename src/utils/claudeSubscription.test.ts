import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModelSlug } from "#app/models";
import { preflightClaudeSubscription } from "#app/utils/claudeSubscription";

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function stubFetch(impl: () => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function firstCall(mock: { mock: { calls: unknown[][] } }): FetchArgs {
  const call = mock.mock.calls[0];
  if (!call) throw new Error("expected fetch to have been called");
  return call as FetchArgs;
}

function requestBody(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const [, init] = firstCall(mock);
  if (!init || typeof init.body !== "string") throw new Error("expected a string request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preflightClaudeSubscription", () => {
  it("returns usable on 200 OK and probes with the run's model on the OAuth surface", async () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }));

    const result = await preflightClaudeSubscription({
      token: "oauth-tok",
      model: "claude-fable-5",
    });

    expect(result).toEqual({ usable: true });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = firstCall(mock);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    if (!init) throw new Error("expected a request init");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer oauth-tok",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    });
    expect(requestBody(mock)).toMatchObject({ model: "claude-fable-5", max_tokens: 1 });
  });

  it("falls back to the registry-resolved haiku probe model when no model is set", async () => {
    const mock = stubFetch(async () => new Response("{}", { status: 200 }));

    await preflightClaudeSubscription({ token: "oauth-tok", model: undefined });

    const resolved = resolveModelSlug("anthropic/claude-haiku");
    if (!resolved) throw new Error("anthropic/claude-haiku missing from registry");
    const expected = resolved.slice(resolved.indexOf("/") + 1);
    const body = requestBody(mock);
    expect(body.model).toBe(expected);
    expect(String(body.model)).not.toContain("/");
  });

  it("marks the token unusable on 401 with the error.message from the JSON body", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: "OAuth token revoked" } }), {
          status: 401,
        }),
    );

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result).toEqual({ usable: false, reason: "401: OAuth token revoked" });
  });

  it("marks the token unusable on 429 (subscription limit hit)", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ error: { message: "You've hit your Opus limit" } }), {
          status: 429,
        }),
    );

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-opus-4-8" });

    expect(result).toEqual({ usable: false, reason: "429: You've hit your Opus limit" });
  });

  it.each([400, 403, 500, 529])("fails open (usable) on status %d", async (status) => {
    stubFetch(async () => new Response("nope", { status }));

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result).toEqual({ usable: true });
  });

  it("fails open when fetch itself throws (network error / timeout)", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result).toEqual({ usable: true });
  });

  it("uses a raw excerpt of a non-JSON 401 body, capped at 200 chars", async () => {
    const html = `<html>upstream error${"x".repeat(300)}</html>`;
    stubFetch(async () => new Response(html, { status: 401 }));

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result.usable).toBe(false);
    if (result.usable) throw new Error("expected an unusable result");
    expect(result.reason).toBe(`401: ${html.slice(0, 200)}`);
  });

  it("uses the raw excerpt when the JSON body has no error.message string", async () => {
    const body = JSON.stringify({ error: "rate_limited" });
    stubFetch(async () => new Response(body, { status: 429 }));

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result).toEqual({ usable: false, reason: `429: ${body}` });
  });

  it("degrades to an empty reason body when reading the response body fails", async () => {
    const fake = {
      status: 401,
      text: () => Promise.reject(new Error("body stream interrupted")),
    } as unknown as Response;
    stubFetch(async () => fake);

    const result = await preflightClaudeSubscription({ token: "t", model: "claude-fable-5" });

    expect(result).toEqual({ usable: false, reason: "401: " });
  });
});
