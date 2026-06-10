import { afterEach, describe, expect, it } from "vitest";
import { filterEnv, isSensitiveEnvName, resolveEnv, setEnvAllowlist } from "#app/utils/secrets";

// keys this suite injects into process.env — cleaned up after each test so we
// don't leak state into other tests sharing the worker.
const INJECTED = [
  "GITHUB_WORKSPACE",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "GITHUB_FUTURE_UNKNOWN_VAR",
  "RUNNER_TEMP",
  "ANTHROPIC_API_KEY",
  "MY_CUSTOM_VALUE",
];

afterEach(() => {
  for (const k of INJECTED) delete process.env[k];
  // reset any user allowlist set during a test
  setEnvAllowlist("");
});

describe("isSensitiveEnvName", () => {
  it("flags _KEY/_SECRET/_TOKEN/_PASSWORD/_CREDENTIAL suffixes", () => {
    expect(isSensitiveEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSensitiveEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isSensitiveEnvName("VERCEL_AUTOMATION_BYPASS_SECRET")).toBe(true);
    expect(isSensitiveEnvName("GITHUB_WORKSPACE")).toBe(false);
  });
});

describe("filterEnv GITHUB_* exact allowlist (fail-closed)", () => {
  it("passes through known runner context vars", () => {
    process.env.GITHUB_WORKSPACE = "/work";
    process.env.GITHUB_REPOSITORY = "terramend/terramend";
    process.env.RUNNER_TEMP = "/tmp/runner";
    const env = filterEnv();
    expect(env.GITHUB_WORKSPACE).toBe("/work");
    expect(env.GITHUB_REPOSITORY).toBe("terramend/terramend");
    expect(env.RUNNER_TEMP).toBe("/tmp/runner");
  });

  it("drops an unknown GITHUB_* var that is not in the exact allowlist", () => {
    process.env.GITHUB_FUTURE_UNKNOWN_VAR = "leak-me";
    expect(filterEnv().GITHUB_FUTURE_UNKNOWN_VAR).toBeUndefined();
  });

  it("drops GITHUB_TOKEN even though it shares the GITHUB_ prefix", () => {
    process.env.GITHUB_TOKEN = "ghs_secret";
    expect(filterEnv().GITHUB_TOKEN).toBeUndefined();
  });

  it("drops obviously sensitive vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
    expect(filterEnv().ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("drops arbitrary non-allowlisted vars by default", () => {
    process.env.MY_CUSTOM_VALUE = "x";
    expect(filterEnv().MY_CUSTOM_VALUE).toBeUndefined();
  });

  it("honors an explicit user allowlist opt-in", () => {
    process.env.MY_CUSTOM_VALUE = "x";
    process.env.GITHUB_FUTURE_UNKNOWN_VAR = "y";
    setEnvAllowlist("MY_CUSTOM_VALUE\nGITHUB_FUTURE_UNKNOWN_VAR");
    const env = filterEnv();
    expect(env.MY_CUSTOM_VALUE).toBe("x");
    expect(env.GITHUB_FUTURE_UNKNOWN_VAR).toBe("y");
  });

  it("lets the user allowlist opt a sensitive-named var back in", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
    setEnvAllowlist("ANTHROPIC_API_KEY");
    expect(filterEnv().ANTHROPIC_API_KEY).toBe("sk-ant-xxx");
  });

  it("passes through safe prefixes (RUNNER_*, JAVA_HOME_*)", () => {
    process.env.RUNNER_TEMP = "/tmp/runner";
    const env = filterEnv();
    expect(env.RUNNER_TEMP).toBe("/tmp/runner");
  });
});

describe("resolveEnv", () => {
  it("returns the full process env for 'inherit'", () => {
    expect(resolveEnv("inherit")).toBe(process.env);
  });

  it("filters for 'restricted' and for the undefined default", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
    expect(resolveEnv("restricted").ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolveEnv(undefined).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("merges a custom env object over the restricted base", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-xxx";
    process.env.GITHUB_WORKSPACE = "/work";
    const env = resolveEnv({ EXTRA_VAR: "1" });
    expect(env.EXTRA_VAR).toBe("1");
    expect(env.GITHUB_WORKSPACE).toBe("/work"); // restricted base survives
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // secrets still filtered
  });
});
