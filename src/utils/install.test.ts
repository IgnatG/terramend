import { spawnSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFromCurl,
  installFromDirectTarball,
  installFromGithub,
  installFromGithubTarball,
  installFromNpmTarball,
} from "#app/utils/install";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  chmodSync: vi.fn(),
  createWriteStream: vi.fn(() => ({})),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(),
}));

vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn(async () => undefined),
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(async () => undefined),
}));

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const TEMP = join("tmp", "terramend-install-test");

const existsSyncMock = vi.mocked(existsSync);
const spawnSyncMock = vi.mocked(spawnSync);
const sleepMock = vi.mocked(sleep);

type FakeResponseInit = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  body?: unknown;
  headers?: Record<string, string>;
  headersGet?: (name: string) => string | null;
};

function fakeResponse(init: FakeResponseInit = {}): Response {
  const headers = init.headersGet ? { get: init.headersGet } : new Headers(init.headers ?? {});
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    headers,
    json: async () => init.json,
    body: "body" in init ? init.body : {},
  } as unknown as Response;
}

function spawnResult(
  init: { status?: number | null; stdout?: string; stderr?: string } = {},
): ReturnType<typeof spawnSync> {
  return {
    status: init.status ?? 0,
    stdout: init.stdout ?? "",
    stderr: init.stderr ?? "",
  } as unknown as ReturnType<typeof spawnSync>;
}

function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fetchUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): string {
  const call = fetchMock.mock.calls.at(index);
  if (!call) throw new Error(`expected fetch call at index ${index}`);
  return String(call[0]);
}

beforeEach(() => {
  vi.stubEnv("TERRAMEND_TEMP_DIR", TEMP);
  vi.stubEnv("NPM_REGISTRY", "");
  spawnSyncMock.mockReturnValue(spawnResult());
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("installFromNpmTarball", () => {
  const params = { packageName: "mytool", version: "1.2.3", executablePath: "bin/cli.js" };
  const cliPath = join(TEMP, "package", "bin/cli.js");

  it("throws when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", undefined);
    await expect(installFromNpmTarball(params)).rejects.toThrow("TERRAMEND_TEMP_DIR is not set");
  });

  it("returns the cached binary without fetching", async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = stubFetch();

    await expect(installFromNpmTarball(params)).resolves.toBe(cliPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads, extracts, and chmods an exact version from the default registry", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse());

    await expect(installFromNpmTarball(params)).resolves.toBe(cliPath);

    expect(fetchUrl(fetchMock, 0)).toBe("https://registry.npmjs.org/mytool/-/mytool-1.2.3.tgz");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(TEMP, "package.tgz"), "-C", TEMP],
      expect.objectContaining({ stdio: "pipe", encoding: "utf-8" }),
    );
    expect(chmodSync).toHaveBeenCalledWith(cliPath, 0o755);
    expect(createWriteStream).toHaveBeenCalledWith(join(TEMP, "package.tgz"));
  });

  it("resolves 'latest' through the registry metadata first", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(
      fakeResponse({ json: { "dist-tags": { latest: "9.9.9" }, versions: {} } }),
      fakeResponse(),
    );

    await installFromNpmTarball({ ...params, version: "latest" });

    expect(fetchUrl(fetchMock, 0)).toBe("https://registry.npmjs.org/mytool");
    expect(fetchUrl(fetchMock, 1)).toBe("https://registry.npmjs.org/mytool/-/mytool-9.9.9.tgz");
  });

  it("resolves caret ranges and honors a custom NPM_REGISTRY", async () => {
    vi.stubEnv("NPM_REGISTRY", "https://npm.corp.example");
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(
      fakeResponse({ json: { "dist-tags": { latest: "1.4.0" }, versions: {} } }),
      fakeResponse(),
    );

    await installFromNpmTarball({ ...params, version: "^1.0.0" });

    expect(fetchUrl(fetchMock, 0)).toBe("https://npm.corp.example/mytool");
    expect(fetchUrl(fetchMock, 1)).toBe("https://npm.corp.example/mytool/-/mytool-1.4.0.tgz");
  });

  it("throws and warns when version resolution fails", async () => {
    stubFetch(fakeResponse({ ok: false, status: 500 }));

    await expect(installFromNpmTarball({ ...params, version: "~2.0.0" })).rejects.toThrow(
      "Failed to query registry: 500",
    );
  });

  it("stringifies non-Error registry failures in the warning", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce("registry offline");
    vi.stubGlobal("fetch", fetchMock);

    await expect(installFromNpmTarball({ ...params, version: "latest" })).rejects.toBe(
      "registry offline",
    );
  });

  it("URL-encodes scoped package names in the tarball URL", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse());

    await installFromNpmTarball({ ...params, packageName: "@scope/pkg", version: "2.0.0" });

    expect(fetchUrl(fetchMock, 0)).toBe("https://registry.npmjs.org/@scope%2Fpkg/-/pkg-2.0.0.tgz");
  });

  it("throws when the tarball download fails", async () => {
    stubFetch(fakeResponse({ ok: false, status: 404, statusText: "Not Found" }));

    await expect(installFromNpmTarball(params)).rejects.toThrow(
      "Failed to download tarball: 404 Not Found",
    );
  });

  it("throws when the tarball response has no body", async () => {
    stubFetch(fakeResponse({ body: null }));

    await expect(installFromNpmTarball(params)).rejects.toThrow("Response body is null");
  });

  it("surfaces tar stderr when extraction fails", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: "tar: boom" }));

    await expect(installFromNpmTarball(params)).rejects.toThrow(
      "Failed to extract tarball: tar: boom",
    );
  });

  it("falls back to 'Unknown error' when tar produces no output", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));

    await expect(installFromNpmTarball(params)).rejects.toThrow(
      "Failed to extract tarball: Unknown error",
    );
  });

  it("throws when the executable is missing from the extracted package", async () => {
    existsSyncMock.mockReturnValue(false);
    stubFetch(fakeResponse());

    await expect(installFromNpmTarball(params)).rejects.toThrow(
      `Executable not found in extracted package at ${cliPath}`,
    );
  });

  it("runs npm install with the AUTHORIZED guard flag when installDependencies is set", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());

    await installFromNpmTarball({ ...params, installDependencies: true });

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).toHaveBeenLastCalledWith(
      "npm",
      ["install", "--production"],
      expect.objectContaining({
        cwd: join(TEMP, "package"),
        env: expect.objectContaining({ AUTHORIZED: "1" }),
      }),
    );
  });

  it("throws when dependency installation fails", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());
    spawnSyncMock
      .mockReturnValueOnce(spawnResult())
      .mockReturnValueOnce(spawnResult({ status: 1, stderr: "EACCES" }));

    await expect(installFromNpmTarball({ ...params, installDependencies: true })).rejects.toThrow(
      "Failed to install dependencies: EACCES",
    );
  });

  it("falls back to npm stdout, then 'Unknown error', when npm fails silently", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());
    spawnSyncMock
      .mockReturnValueOnce(spawnResult())
      .mockReturnValueOnce(spawnResult({ status: 1, stdout: "npm ERR! 403" }));

    await expect(installFromNpmTarball({ ...params, installDependencies: true })).rejects.toThrow(
      "Failed to install dependencies: npm ERR! 403",
    );

    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());
    spawnSyncMock
      .mockReturnValueOnce(spawnResult())
      .mockReturnValueOnce(spawnResult({ status: 1 }));

    await expect(installFromNpmTarball({ ...params, installDependencies: true })).rejects.toThrow(
      "Failed to install dependencies: Unknown error",
    );
  });
});

describe("installFromGithub", () => {
  const params = { owner: "o", repo: "r", assetName: "tool.bin" };
  const installDir = join(TEMP, "github-o-r");
  const release = {
    tag_name: "v1",
    assets: [{ name: "tool.bin", browser_download_url: "https://gh.example/dl/tool.bin" }],
  };

  it("returns the cached binary without fetching", async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = stubFetch();

    await expect(installFromGithub({ ...params, executablePath: "bin/tool" })).resolves.toBe(
      join(installDir, "bin/tool"),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads the latest release asset into the deterministic temp dir", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithub(params)).resolves.toBe(join(installDir, "tool.bin"));

    expect(fetchUrl(fetchMock, 0)).toBe("https://api.github.com/repos/o/r/releases/latest");
    expect(fetchUrl(fetchMock, 1)).toBe("https://gh.example/dl/tool.bin");
    expect(mkdirSync).toHaveBeenCalledWith(installDir, { recursive: true });
    expect(chmodSync).toHaveBeenCalledWith(join(installDir, "tool.bin"), 0o755);
  });

  it("falls back to mkdtemp when TERRAMEND_TEMP_DIR is unset", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", undefined);
    const mkdtempDir = join("mk", "o-r-github-abc");
    vi.mocked(mkdtemp).mockResolvedValue(mkdtempDir);
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithub(params)).resolves.toBe(join(mkdtempDir, "tool.bin"));
    expect(mkdtemp).toHaveBeenCalledWith(join(tmpdir(), "o-r-github-"));
  });

  it("pins the release by tag and sends the installation token", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse({ json: release }), fakeResponse());

    await installFromGithub({ ...params, tag: "v2", githubInstallationToken: "ghs_tok" });

    expect(fetchUrl(fetchMock, 0)).toBe("https://api.github.com/repos/o/r/releases/tags/v2");
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
      headers: { Authorization: "Bearer ghs_tok" },
    });
  });

  it("returns the explicit executablePath instead of the download path", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithub({ ...params, executablePath: "bin/tool" })).resolves.toBe(
      join(installDir, "bin/tool"),
    );
  });

  it("falls back to the literal 'asset' cache name when no names are given", async () => {
    existsSyncMock.mockReturnValue(true);

    await expect(installFromGithub({ owner: "o", repo: "r" })).resolves.toBe(
      join(installDir, "asset"),
    );
  });

  it("falls back to the 'asset' file name when the download URL has no basename", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const slashRelease = {
      tag_name: "v1",
      assets: [{ name: "tool.bin", browser_download_url: "https://gh.example/dl/" }],
    };
    stubFetch(fakeResponse({ json: slashRelease }), fakeResponse());

    await expect(installFromGithub(params)).resolves.toBe(join(installDir, "asset"));
  });

  it("throws when the requested asset is not in the release", async () => {
    stubFetch(fakeResponse({ json: { tag_name: "v1", assets: [] } }));

    await expect(installFromGithub(params)).rejects.toThrow(
      "Asset 'tool.bin' not found in release v1",
    );
  });

  it("throws when the downloaded executable does not exist", async () => {
    existsSyncMock.mockReturnValue(false);
    stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithub(params)).rejects.toThrow(
      `Executable not found at ${join(installDir, "tool.bin")}`,
    );
  });

  it("throws when the asset response has no body", async () => {
    stubFetch(fakeResponse({ json: release }), fakeResponse({ body: null }));

    await expect(installFromGithub(params)).rejects.toThrow("Response body is null");
  });
});

describe("fetchWithRetry (via installFromGithub release fetch)", () => {
  const params = { owner: "o", repo: "r", assetName: "tool.bin" };
  const release = {
    tag_name: "v1",
    assets: [{ name: "tool.bin", browser_download_url: "https://gh.example/dl/tool.bin" }],
  };

  it("throws immediately on a failure without a Retry-After header", async () => {
    stubFetch(fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error" }));

    await expect(installFromGithub(params)).rejects.toThrow(
      "Failed to fetch release: 500 Internal Server Error",
    );
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("waits the advertised Retry-After and retries once", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(
      fakeResponse({ ok: false, status: 429, headers: { "Retry-After": "2" } }),
      fakeResponse({ json: release }),
      fakeResponse(),
    );

    await expect(installFromGithub(params)).resolves.toBe(join(TEMP, "github-o-r", "tool.bin"));
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it("reports a failed retry distinctly", async () => {
    stubFetch(
      fakeResponse({ ok: false, status: 429, headers: { "Retry-After": "1" } }),
      fakeResponse({ ok: false, status: 403, statusText: "Forbidden" }),
    );

    await expect(installFromGithub(params)).rejects.toThrow(
      "Failed to fetch release: 403 Forbidden (retry failed)",
    );
  });

  it("does not retry when Retry-After is zero", async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "0" },
      }),
    );

    await expect(installFromGithub(params)).rejects.toThrow(
      "Failed to fetch release: 429 Too Many Requests",
    );
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("does not retry when Retry-After is not a number", async () => {
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Retry-After": "soon" },
      }),
    );

    await expect(installFromGithub(params)).rejects.toThrow(
      "Failed to fetch release: 429 Too Many Requests",
    );
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("falls back to the lowercase retry-after header", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(
      fakeResponse({
        ok: false,
        status: 429,
        // case-sensitive lookup: only the exact lowercase name matches
        headersGet: (name) => (name === "retry-after" ? "1" : null),
      }),
      fakeResponse({ json: release }),
      fakeResponse(),
    );

    await expect(installFromGithub(params)).resolves.toBe(join(TEMP, "github-o-r", "tool.bin"));
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });
});

describe("installFromGithubTarball", () => {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const assetName = `tool-${os}-${arch}.tar.gz`;
  const params = {
    owner: "o",
    repo: "r",
    assetNamePattern: "tool-{os}-{arch}.tar.gz",
    executablePath: "bin/tool",
  };
  const cliPath = join(TEMP, "bin/tool");
  const release = {
    tag_name: "v3",
    assets: [{ name: assetName, browser_download_url: `https://gh.example/dl/${assetName}` }],
  };

  it("throws when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", undefined);
    await expect(installFromGithubTarball(params)).rejects.toThrow("TERRAMEND_TEMP_DIR is not set");
  });

  it("returns the cached binary without fetching", async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = stubFetch();

    await expect(installFromGithubTarball(params)).resolves.toBe(cliPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the platform asset, extracts it, and returns the executable", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithubTarball({ ...params, tag: "v3" })).resolves.toBe(cliPath);

    expect(fetchUrl(fetchMock, 0)).toBe("https://api.github.com/repos/o/r/releases/tags/v3");
    expect(fetchUrl(fetchMock, 1)).toBe(`https://gh.example/dl/${assetName}`);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(TEMP, assetName), "-C", TEMP],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(chmodSync).toHaveBeenCalledWith(cliPath, 0o755);
  });

  it("sends the installation token when provided", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse({ json: release }), fakeResponse());

    await installFromGithubTarball({ ...params, githubInstallationToken: "ghs_tok" });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
      headers: { Authorization: "Bearer ghs_tok" },
    });
  });

  it("throws when the platform asset is missing from the release", async () => {
    stubFetch(fakeResponse({ json: { tag_name: "v3", assets: [] } }));

    await expect(installFromGithubTarball(params)).rejects.toThrow(
      `Asset '${assetName}' not found in release v3`,
    );
  });

  it("throws when the asset response has no body", async () => {
    stubFetch(fakeResponse({ json: release }), fakeResponse({ body: null }));

    await expect(installFromGithubTarball(params)).rejects.toThrow("Response body is null");
  });

  it("surfaces extraction failures", async () => {
    stubFetch(fakeResponse({ json: release }), fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stdout: "bad archive" }));

    await expect(installFromGithubTarball(params)).rejects.toThrow(
      "Failed to extract tarball: bad archive",
    );
  });

  it("reports 'Unknown error' when tar fails without output", async () => {
    stubFetch(fakeResponse({ json: release }), fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 2 }));

    await expect(installFromGithubTarball(params)).rejects.toThrow(
      "Failed to extract tarball: Unknown error",
    );
  });

  it("throws when the executable is missing after extraction", async () => {
    existsSyncMock.mockReturnValue(false);
    stubFetch(fakeResponse({ json: release }), fakeResponse());

    await expect(installFromGithubTarball(params)).rejects.toThrow(
      `Executable not found in extracted tarball at ${cliPath}`,
    );
  });
});

describe("installFromDirectTarball", () => {
  const params = { url: "https://example.com/pkg.tgz", executablePath: "bin/tool" };
  const extractDir = join(TEMP, "direct-package");
  const cliPath = join(extractDir, "bin/tool");

  it("throws when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", undefined);
    await expect(installFromDirectTarball(params)).rejects.toThrow("TERRAMEND_TEMP_DIR is not set");
  });

  it("returns the cached binary without fetching", async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = stubFetch();

    await expect(installFromDirectTarball(params)).resolves.toBe(cliPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads and extracts without strip-components by default", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse());

    await expect(installFromDirectTarball(params)).resolves.toBe(cliPath);

    expect(fetchUrl(fetchMock, 0)).toBe("https://example.com/pkg.tgz");
    expect(mkdirSync).toHaveBeenCalledWith(extractDir, { recursive: true });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(TEMP, "direct-package.tgz"), "-C", extractDir],
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(chmodSync).toHaveBeenCalledWith(cliPath, 0o755);
  });

  it("floors and forwards stripComponents to tar", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());

    await installFromDirectTarball({ ...params, stripComponents: 2.7 });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(TEMP, "direct-package.tgz"), "-C", extractDir, "--strip-components=2"],
      expect.anything(),
    );
  });

  it("omits strip-components when it is zero", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    stubFetch(fakeResponse());

    await installFromDirectTarball({ ...params, stripComponents: 0 });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tar",
      ["-xzf", join(TEMP, "direct-package.tgz"), "-C", extractDir],
      expect.anything(),
    );
  });

  it("throws when the download fails", async () => {
    stubFetch(fakeResponse({ ok: false, status: 500, statusText: "Internal Server Error" }));

    await expect(installFromDirectTarball(params)).rejects.toThrow(
      "failed to download tarball: 500 Internal Server Error",
    );
  });

  it("throws when the response has no body", async () => {
    stubFetch(fakeResponse({ body: null }));

    await expect(installFromDirectTarball(params)).rejects.toThrow("response body is null");
  });

  it("surfaces extraction failures", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 1, stderr: "gzip: corrupt" }));

    await expect(installFromDirectTarball(params)).rejects.toThrow(
      "failed to extract tarball: gzip: corrupt",
    );
  });

  it("reports 'unknown error' when tar fails without output", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 1 }));

    await expect(installFromDirectTarball(params)).rejects.toThrow(
      "failed to extract tarball: unknown error",
    );
  });

  it("throws when the executable is missing after extraction", async () => {
    existsSyncMock.mockReturnValue(false);
    stubFetch(fakeResponse());

    await expect(installFromDirectTarball(params)).rejects.toThrow(
      `executable not found in extracted tarball at ${cliPath}`,
    );
  });
});

describe("installFromCurl", () => {
  const params = { installUrl: "https://example.com/install.sh", executableName: "mytool" };
  const cliPath = join(TEMP, ".local", "bin", "mytool");
  const scriptPath = join(TEMP, "install.sh");

  it("throws when TERRAMEND_TEMP_DIR is not set", async () => {
    vi.stubEnv("TERRAMEND_TEMP_DIR", undefined);
    await expect(installFromCurl(params)).rejects.toThrow("TERRAMEND_TEMP_DIR is not set");
  });

  it("returns the cached binary without fetching", async () => {
    existsSyncMock.mockReturnValue(true);
    const fetchMock = stubFetch();

    await expect(installFromCurl(params)).resolves.toBe(cliPath);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads the script and runs it with HOME pointed at the temp dir", async () => {
    existsSyncMock.mockReturnValueOnce(false).mockReturnValue(true);
    const fetchMock = stubFetch(fakeResponse());

    await expect(installFromCurl(params)).resolves.toBe(cliPath);

    expect(fetchUrl(fetchMock, 0)).toBe("https://example.com/install.sh");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "bash",
      [scriptPath],
      expect.objectContaining({
        cwd: TEMP,
        env: expect.objectContaining({
          HOME: TEMP,
          XDG_CONFIG_HOME: join(TEMP, ".config"),
        }),
      }),
    );
    // the script and the resulting binary are both made executable
    expect(chmodSync).toHaveBeenCalledWith(scriptPath, 0o755);
    expect(chmodSync).toHaveBeenCalledWith(cliPath, 0o755);
  });

  it("throws when the install script download fails", async () => {
    stubFetch(fakeResponse({ ok: false, status: 404 }));

    await expect(installFromCurl(params)).rejects.toThrow("Failed to download install script: 404");
  });

  it("throws when the install script response has no body", async () => {
    stubFetch(fakeResponse({ body: null }));

    await expect(installFromCurl(params)).rejects.toThrow("Response body is null");
  });

  it("reports the exit code and output when the install script fails", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 2, stderr: "no curl" }));

    await expect(installFromCurl(params)).rejects.toThrow(
      "Failed to install mytool. Install script exited with code 2. Output: no curl",
    );
  });

  it("falls back to stdout, then 'No output', when the script fails silently", async () => {
    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 3, stdout: "partial log" }));

    await expect(installFromCurl(params)).rejects.toThrow("Output: partial log");

    stubFetch(fakeResponse());
    spawnSyncMock.mockReturnValue(spawnResult({ status: 3 }));

    await expect(installFromCurl(params)).rejects.toThrow("Output: No output");
  });

  it("throws when the executable is missing after the script ran", async () => {
    existsSyncMock.mockReturnValue(false);
    stubFetch(fakeResponse());

    await expect(installFromCurl(params)).rejects.toThrow(`Executable not found at ${cliPath}`);
  });
});
