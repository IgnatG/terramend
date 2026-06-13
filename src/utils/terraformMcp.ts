/**
 * HashiCorp terraform-mcp-server integration (P2.2).
 *
 * When the `terraform_mcp` input is on, the agent harness registers a SECOND
 * MCP server next to terramend's: HashiCorp's terraform-mcp-server, run as a
 * Docker container over stdio. It gives the fixing agent live Terraform
 * Registry knowledge — current module versions, provider argument shapes —
 * which directly powers module-source-aware fixes and generation.
 *
 * Security posture:
 *   - the image is VERSION-PINNED (`TERRAFORM_MCP_IMAGE`); bump deliberately.
 *     (P4's SHA-pinning sweep will move this to a digest pin.)
 *   - only the read-only `registry` toolset is enabled — no TFE operations,
 *     and no TFE_TOKEN is ever passed.
 *   - degrades green: docker absent → a log note, never a failed run.
 */

import { spawnSync } from "node:child_process";
import { resolveToolSelection, type ToolSelectionFlags } from "#app/utils/toolSelection";

/** pinned release of hashicorp/terraform-mcp-server. Bump deliberately. */
export const TERRAFORM_MCP_IMAGE = "hashicorp/terraform-mcp-server:0.5.2";

/** the registry name the server is registered under in agent MCP configs —
 * matches HashiCorp's own client-config examples, so agent guidance written
 * against "the terraform MCP server" finds it under the expected key. */
export const TERRAFORM_MCP_SERVER_NAME = "terraform";

/** stdio invocation, registry toolset ONLY (module/provider knowledge — the
 * agent must never get TFE workspace operations from this surface). */
const TERRAFORM_MCP_DOCKER_ARGS = [
  "run",
  "-i",
  "--rm",
  TERRAFORM_MCP_IMAGE,
  "--toolsets=registry",
] as const;

export type TerraformMcpResolution =
  | { kind: "disabled" }
  | { kind: "docker_missing"; note: string }
  | { kind: "available"; command: "docker"; args: string[] };

let cachedDockerAvailable: boolean | undefined;

/** test hook — the docker probe is cached per process. */
export function _clearDockerProbeCache(): void {
  cachedDockerAvailable = undefined;
}

function dockerAvailable(): boolean {
  if (cachedDockerAvailable === undefined) {
    const probe = spawnSync("docker", ["--version"], {
      stdio: "pipe",
      encoding: "utf-8",
      timeout: 10_000,
    });
    cachedDockerAvailable = !probe.error && probe.status === 0;
  }
  return cachedDockerAvailable;
}

/**
 * Decide whether the run gets the terraform-mcp-server, as a discriminated
 * union so each harness handles all three outcomes explicitly: register the
 * server (`available`), log the degrade-green note (`docker_missing`), or do
 * nothing (`disabled`).
 */
export function resolveTerraformMcp(payload: ToolSelectionFlags): TerraformMcpResolution {
  // terraform-mcp-server is licence-gated (HashiCorp, §1.5): on via the
  // `terraform_mcp` input OR by naming "terraform_mcp" in tools_enabled; an
  // explicit `-terraform_mcp` there turns it off.
  if (!resolveToolSelection(payload).enabled("terraform_mcp")) return { kind: "disabled" };
  if (!dockerAvailable()) {
    return {
      kind: "docker_missing",
      note:
        "terraform_mcp requested but docker is not available on this runner — " +
        "continuing without Terraform Registry MCP (module/provider knowledge falls " +
        "back to the registry HTTP lookups in terraform_version_currency)",
    };
  }
  return { kind: "available", command: "docker", args: [...TERRAFORM_MCP_DOCKER_ARGS] };
}
