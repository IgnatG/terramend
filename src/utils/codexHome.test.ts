import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "#app/utils/cli";
import { installCodexAuth, TERRAMEND_DATA_DIR } from "#app/utils/codexHome";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(), writeFileSync: vi.fn() };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

const SAVED_XDG_DATA_HOME = process.env.XDG_DATA_HOME;

function makeJwt(payload: Record<string, unknown>): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${segment}.signature`;
}

function codexAuthJson(tokens: Record<string, unknown>): string {
  return JSON.stringify({ auth_mode: "chatgpt", tokens });
}

function writtenAuthFile(): { path: unknown; content: Record<string, unknown>; mode: unknown } {
  const call = vi.mocked(writeFileSync).mock.calls[0];
  if (!call) throw new Error("expected writeFileSync to have been called");
  return {
    path: call[0],
    content: JSON.parse(String(call[1])) as Record<string, unknown>,
    mode: call[2],
  };
}

beforeEach(() => {
  vi.stubEnv("CI", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  if (SAVED_XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = SAVED_XDG_DATA_HOME;
});

describe("installCodexAuth", () => {
  it("returns null without touching disk when CODEX_AUTH_JSON is absent", () => {
    vi.stubEnv("CODEX_AUTH_JSON", undefined);

    expect(installCodexAuth()).toBeNull();
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(mkdirSync)).not.toHaveBeenCalled();
  });

  it("returns null and warns when CODEX_AUTH_JSON is not valid JSON", () => {
    const warning = vi.spyOn(log, "warning").mockImplementation(() => {});
    vi.stubEnv("CODEX_AUTH_JSON", "{not json");

    expect(installCodexAuth()).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("CODEX_AUTH_JSON"));
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("returns null and warns on a wrong auth_mode shape", () => {
    const warning = vi.spyOn(log, "warning").mockImplementation(() => {});
    vi.stubEnv(
      "CODEX_AUTH_JSON",
      JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "a", refresh_token: "r" } }),
    );

    expect(installCodexAuth()).toBeNull();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("materializes auth.json under $HOME locally and exports XDG_DATA_HOME", () => {
    const exp = 1_893_456_000; // 2030-01-01T00:00:00Z
    const accessToken = makeJwt({ exp });
    vi.stubEnv(
      "CODEX_AUTH_JSON",
      codexAuthJson({ access_token: accessToken, refresh_token: "r-1", account_id: "acct-9" }),
    );

    const result = installCodexAuth();

    const xdgDataHome = join(homedir(), ".local", "share");
    const authPath = join(xdgDataHome, "opencode", "auth.json");
    expect(result).toEqual({ authPath, xdgDataHome, originalRefresh: "r-1" });
    // load-bearing: every opencode subprocess discovers the auth.json via env
    expect(process.env.XDG_DATA_HOME).toBe(xdgDataHome);
    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(join(xdgDataHome, "opencode"), {
      recursive: true,
    });

    const written = writtenAuthFile();
    expect(written.path).toBe(authPath);
    expect(written.mode).toEqual({ mode: 0o600 });
    expect(written.content).toEqual({
      openai: {
        type: "oauth",
        refresh: "r-1",
        access: accessToken,
        expires: exp * 1000,
        accountId: "acct-9",
      },
    });
  });

  it("falls back to expires 0 when the access token is not a decodable JWT", () => {
    vi.stubEnv(
      "CODEX_AUTH_JSON",
      codexAuthJson({ access_token: "opaque-token", refresh_token: "r-2" }),
    );

    const result = installCodexAuth();

    expect(result).not.toBeNull();
    const written = writtenAuthFile();
    expect(written.content).toEqual({
      openai: { type: "oauth", refresh: "r-2", access: "opaque-token", expires: 0 },
    });
  });

  it("uses the sudo-bootstrapped terramend data dir in CI", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("CODEX_AUTH_JSON", codexAuthJson({ access_token: "a", refresh_token: "r-3" }));
    vi.mocked(execFileSync).mockImplementation(((cmd: string) =>
      cmd === "id" ? "runners\n" : "") as typeof execFileSync);

    const result = installCodexAuth();

    expect(result).toEqual({
      authPath: join(TERRAMEND_DATA_DIR, "opencode", "auth.json"),
      xdgDataHome: TERRAMEND_DATA_DIR,
      originalRefresh: "r-3",
    });
    expect(process.env.XDG_DATA_HOME).toBe(TERRAMEND_DATA_DIR);
    const user = userInfo().username;
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "sudo",
      ["-n", "chown", `${user}:runners`, TERRAMEND_DATA_DIR],
      { stdio: "pipe" },
    );
  });

  it("falls back to the username as group when `id -gn` fails", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("CODEX_AUTH_JSON", codexAuthJson({ access_token: "a", refresh_token: "r-4" }));
    vi.mocked(execFileSync).mockImplementation(((cmd: string) => {
      if (cmd === "id") throw new Error("id: command not found");
      return "";
    }) as typeof execFileSync);

    expect(installCodexAuth()).not.toBeNull();

    const user = userInfo().username;
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "sudo",
      ["-n", "chown", `${user}:${user}`, TERRAMEND_DATA_DIR],
      { stdio: "pipe" },
    );
  });

  it("fails closed in CI when the sudo bootstrap is unavailable", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("CODEX_AUTH_JSON", codexAuthJson({ access_token: "a", refresh_token: "r-5" }));
    vi.mocked(execFileSync).mockImplementation((() => {
      throw new Error("sudo: a password is required");
    }) as typeof execFileSync);

    expect(() => installCodexAuth()).toThrow(/failed to bootstrap .*terramend/);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("stringifies non-Error bootstrap failures into the fail-closed message", () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("CODEX_AUTH_JSON", codexAuthJson({ access_token: "a", refresh_token: "r-6" }));
    vi.mocked(execFileSync).mockImplementation((() => {
      // eslint-style non-Error throw — exercises the String(err) fallback
      throw "sudo denied";
    }) as typeof execFileSync);

    expect(() => installCodexAuth()).toThrow(/sudo denied/);
  });
});
