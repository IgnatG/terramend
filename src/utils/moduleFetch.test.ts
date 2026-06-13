import { describe, expect, it } from "vitest";
import {
  buildModuleFetchGitEnv,
  moduleFetchHosts,
  resolveModuleFetchEnv,
} from "#app/utils/moduleFetch";

describe("buildModuleFetchGitEnv", () => {
  it("injects a Basic auth extraheader per host via GIT_CONFIG_*", () => {
    const env = buildModuleFetchGitEnv("tok123", ["github.com"]);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    const expected = `Authorization: Basic ${Buffer.from("x-access-token:tok123").toString("base64")}`;
    expect(env.GIT_CONFIG_VALUE_0).toBe(expected);
  });

  it("never embeds the raw token in a key/url (only in the auth header value)", () => {
    const env = buildModuleFetchGitEnv("supersecret", ["github.com"]);
    expect(env.GIT_CONFIG_KEY_0).not.toContain("supersecret");
    // the token is base64'd inside the header, not present verbatim.
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("supersecret");
  });

  it("emits one entry per host and de-duplicates case-insensitively", () => {
    const env = buildModuleFetchGitEnv("t", ["github.com", "GitHub.com", "ghe.acme.dev"]);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_KEY_1).toBe("http.https://ghe.acme.dev/.extraheader");
  });

  it("returns an empty object when no usable host remains", () => {
    expect(buildModuleFetchGitEnv("t", [])).toEqual({});
    expect(buildModuleFetchGitEnv("t", ["  "])).toEqual({});
  });
});

describe("moduleFetchHosts", () => {
  it("defaults to github.com", () => {
    expect(moduleFetchHosts(undefined)).toEqual(["github.com"]);
  });

  it("adds a GitHub Enterprise Server host from GITHUB_SERVER_URL", () => {
    expect(moduleFetchHosts("https://ghe.acme.dev")).toEqual(["github.com", "ghe.acme.dev"]);
  });

  it("ignores a malformed server url", () => {
    expect(moduleFetchHosts("not a url")).toEqual(["github.com"]);
  });
});

describe("resolveModuleFetchEnv", () => {
  it("returns undefined without a token (the common public/registry case)", () => {
    expect(resolveModuleFetchEnv({})).toBeUndefined();
    expect(resolveModuleFetchEnv({ moduleFetchToken: "   " })).toBeUndefined();
  });

  it("builds the git env when a token is supplied", () => {
    const env = resolveModuleFetchEnv({ moduleFetchToken: "abc" });
    expect(env?.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
  });
});
