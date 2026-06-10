import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePackageManager,
  type PackageManagerSpec,
  packageManagerBinDir,
  resolvePackageManagerSpec,
} from "#app/utils/packageManager";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => "{}"),
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

vi.mock("#app/utils/subprocess", () => ({
  spawn: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { log } from "#app/utils/cli";
import { spawn } from "#app/utils/subprocess";

const existsSyncMock = vi.mocked(existsSync);
const readFileMock = vi.mocked(readFile);
const spawnMock = vi.mocked(spawn);
const warningMock = vi.mocked(log.warning);

function spawnResult(init: { exitCode?: number; stdout?: string; stderr?: string } = {}) {
  return {
    exitCode: init.exitCode ?? 0,
    stdout: init.stdout ?? "",
    stderr: init.stderr ?? "",
    durationMs: 1,
  };
}

function mockPackageJson(pkg: unknown): void {
  existsSyncMock.mockReturnValue(true);
  readFileMock.mockResolvedValue(JSON.stringify(pkg));
}

describe("resolvePackageManagerSpec", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when package.json does not exist", async () => {
    existsSyncMock.mockReturnValue(false);
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
    expect(existsSyncMock).toHaveBeenCalledWith(join("/repo", "package.json"));
  });

  it("returns null and warns when package.json is unparseable", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue("{nope");
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("failed to parse"));
  });

  it("returns null when neither field is declared", async () => {
    mockPackageJson({});
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
  });

  it("parses packageManager field and strips the integrity hash", async () => {
    mockPackageJson({ packageManager: "pnpm@11.1.1+sha512.abcdef" });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toEqual({
      name: "pnpm",
      version: "11.1.1",
      concrete: true,
      source: "packageManager",
    });
  });

  it("flags range versions as non-concrete", async () => {
    mockPackageJson({ packageManager: "yarn@^4.0.0" });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toEqual({
      name: "yarn",
      version: "^4.0.0",
      concrete: false,
      source: "packageManager",
    });
  });

  it("rejects unsupported packageManager names with a warning", async () => {
    mockPackageJson({ packageManager: "lerna@9.0.0" });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("unknown packageManager"));
  });

  it("rejects a packageManager value without a name", async () => {
    mockPackageJson({ packageManager: "@11.0.0" });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
  });

  it("parses devEngines.packageManager", async () => {
    mockPackageJson({ devEngines: { packageManager: { name: "pnpm", version: " 11.0.0 " } } });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toEqual({
      name: "pnpm",
      version: "11.0.0",
      concrete: true,
      source: "devEngines",
    });
  });

  it("ignores devEngines entries missing name or version", async () => {
    mockPackageJson({ devEngines: { packageManager: { name: "pnpm" } } });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
  });

  it("rejects unsupported devEngines names with a warning", async () => {
    mockPackageJson({ devEngines: { packageManager: { name: "vlt", version: "1.0.0" } } });
    await expect(resolvePackageManagerSpec("/repo")).resolves.toBeNull();
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining("unknown devEngines.packageManager.name"),
    );
  });

  it("prefers devEngines when the two fields name different managers", async () => {
    mockPackageJson({
      packageManager: "yarn@4.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.name).toBe("pnpm");
    expect(spec?.source).toBe("devEngines");
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("disagrees"));
  });

  it("uses a concrete devEngines version, warning when packageManager disagrees", async () => {
    mockPackageJson({
      packageManager: "pnpm@11.2.0",
      devEngines: { packageManager: { name: "pnpm", version: "11.1.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.version).toBe("11.1.0");
    expect(spec?.source).toBe("devEngines");
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("disagrees"));
  });

  it("keeps a concrete devEngines version without warning when both agree", async () => {
    mockPackageJson({
      packageManager: "pnpm@11.1.0",
      devEngines: { packageManager: { name: "pnpm", version: "11.1.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.version).toBe("11.1.0");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("prefers a concrete packageManager that satisfies the devEngines range", async () => {
    mockPackageJson({
      packageManager: "pnpm@11.2.3",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec).toEqual({
      name: "pnpm",
      version: "11.2.3",
      concrete: true,
      source: "packageManager",
    });
  });

  it("falls back to devEngines when packageManager does not satisfy the range", async () => {
    mockPackageJson({
      packageManager: "pnpm@10.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.source).toBe("devEngines");
    expect(spec?.version).toBe("^11.0.0");
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("does not satisfy"));
  });

  it("falls back to devEngines when both are ranges without warning", async () => {
    mockPackageJson({
      packageManager: "pnpm@^11.0.0",
      devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } },
    });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.source).toBe("devEngines");
    expect(warningMock).not.toHaveBeenCalled();
  });

  it("falls back to packageManager when devEngines is absent", async () => {
    mockPackageJson({ packageManager: "npm@10.9.0" });
    const spec = await resolvePackageManagerSpec("/repo");
    expect(spec?.name).toBe("npm");
    expect(spec?.source).toBe("packageManager");
  });
});

describe("packageManagerBinDir", () => {
  it("nests pm-bin under the run tmpdir", () => {
    expect(packageManagerBinDir("/tmp/run")).toBe(join("/tmp/run", "pm-bin"));
  });
});

describe("ensurePackageManager", () => {
  const binDir = join("/tmp/run", "pm-bin");
  let originalPath: string | undefined;

  function spec(overrides: Partial<PackageManagerSpec> = {}): PackageManagerSpec {
    return {
      name: "pnpm",
      version: "11.1.1",
      concrete: true,
      source: "packageManager",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("returns true for npm without spawning anything", async () => {
    await expect(ensurePackageManager({ spec: spec({ name: "npm" }), binDir })).resolves.toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns false for managers corepack does not ship (bun)", async () => {
    await expect(ensurePackageManager({ spec: spec({ name: "bun" }), binDir })).resolves.toBe(
      false,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns false for range versions with a warning", async () => {
    const result = await ensurePackageManager({
      spec: spec({ version: "^11.0.0", concrete: false }),
      binDir,
    });
    expect(result).toBe(false);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("requires a concrete pin"));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("short-circuits when the requested version is already active", async () => {
    spawnMock.mockResolvedValueOnce(spawnResult({ stdout: "11.1.1\n" }));
    await expect(ensurePackageManager({ spec: spec(), binDir })).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "pnpm", args: ["--version"] }),
    );
  });

  it("returns false when corepack enable fails", async () => {
    spawnMock
      .mockResolvedValueOnce(spawnResult({ exitCode: 1 })) // pnpm --version
      .mockResolvedValueOnce(spawnResult({ exitCode: 1, stderr: "enable broke" })); // enable
    await expect(ensurePackageManager({ spec: spec(), binDir })).resolves.toBe(false);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("corepack enable failed"));
  });

  it("returns false when corepack prepare fails, after prepending binDir to PATH", async () => {
    process.env.PATH = "/usr/bin";
    spawnMock
      .mockResolvedValueOnce(spawnResult({ stdout: "10.0.0\n" })) // wrong version active
      .mockResolvedValueOnce(spawnResult()) // enable ok
      .mockResolvedValueOnce(spawnResult({ exitCode: 1, stderr: "" })); // prepare fails
    await expect(ensurePackageManager({ spec: spec(), binDir })).resolves.toBe(false);
    expect(process.env.PATH).toBe(`${binDir}${delimiter}/usr/bin`);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("(empty)"));
  });

  it("returns true on full corepack success and verifies the resolved version", async () => {
    spawnMock
      .mockResolvedValueOnce(spawnResult({ exitCode: 1 })) // not on PATH yet
      .mockImplementationOnce(async (call) => {
        // exercise the corepack stream-forwarding callbacks
        call.onStdout?.("");
        call.onStderr?.("");
        return spawnResult(); // enable ok
      })
      .mockResolvedValueOnce(spawnResult()) // prepare ok
      .mockResolvedValueOnce(spawnResult({ stdout: "11.1.1\n" })); // verify
    await expect(ensurePackageManager({ spec: spec(), binDir })).resolves.toBe(true);
    expect(warningMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "corepack",
        args: ["enable", "--install-directory", binDir, "pnpm"],
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "corepack", args: ["prepare", "pnpm@11.1.1", "--activate"] }),
    );
  });

  it("returns true but warns when PATH still resolves to another version", async () => {
    spawnMock
      .mockResolvedValueOnce(spawnResult({ exitCode: 1 })) // not on PATH yet
      .mockResolvedValueOnce(spawnResult()) // enable ok
      .mockResolvedValueOnce(spawnResult()) // prepare ok
      .mockResolvedValueOnce(spawnResult({ exitCode: 1 })); // verify fails → null
    await expect(ensurePackageManager({ spec: spec(), binDir })).resolves.toBe(true);
    expect(warningMock).toHaveBeenCalledWith(expect.stringContaining("(missing)"));
  });
});
