import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import {
  _clearDockerProbeCache,
  resolveTerraformMcp,
  TERRAFORM_MCP_IMAGE,
} from "#app/utils/terraformMcp";

beforeEach(() => {
  vi.clearAllMocks();
  _clearDockerProbeCache();
});

function dockerProbe(result: { status?: number | null; error?: Error }) {
  spawnSyncMock.mockReturnValue({
    status: result.status ?? 0,
    error: result.error,
    stdout: "",
    stderr: "",
  } as unknown as ReturnType<typeof import("node:child_process").spawnSync>);
}

describe("resolveTerraformMcp", () => {
  it("is disabled when the input is off — and never probes docker", () => {
    expect(resolveTerraformMcp({ terraformMcp: false })).toEqual({ kind: "disabled" });
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("resolves the pinned image with the registry-only toolset when docker is present", () => {
    dockerProbe({ status: 0 });
    const resolution = resolveTerraformMcp({ terraformMcp: true });
    expect(resolution).toEqual({
      kind: "available",
      command: "docker",
      args: ["run", "-i", "--rm", TERRAFORM_MCP_IMAGE, "--toolsets=registry"],
    });
    // version-pinned, never :latest (P4 will move this to a digest pin).
    expect(TERRAFORM_MCP_IMAGE).toMatch(/^hashicorp\/terraform-mcp-server:\d+\.\d+\.\d+$/);
  });

  it("degrades green with a note when docker is missing (ENOENT or non-zero)", () => {
    dockerProbe({ status: null, error: new Error("spawn docker ENOENT") });
    const resolution = resolveTerraformMcp({ terraformMcp: true });
    expect(resolution.kind).toBe("docker_missing");
    if (resolution.kind === "docker_missing") {
      expect(resolution.note).toContain("docker is not available");
    }
  });

  it("caches the docker probe across calls", () => {
    dockerProbe({ status: 0 });
    resolveTerraformMcp({ terraformMcp: true });
    resolveTerraformMcp({ terraformMcp: true });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });
});
