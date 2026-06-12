/**
 * `terramend mcp` — the LOCAL stdio MCP server (P2.1).
 *
 * Exposes terramend's read-only Terraform intelligence (scan, validate, verify,
 * plan, currency, modules, provider schema, roots) to MCP clients — Claude Code,
 * Cursor, Windsurf — over stdio, scoped to a working directory.
 *
 * Security boundary: this surface must stay GITHUB-FREE and WRITE-FREE. It is
 * built from `LocalToolContext` (no octokit, no tokens, no event payload), so a
 * tool that pushes, comments, or opens PRs cannot even type-check here. The
 * one file-writing exception is `terraform_emit_sarif`, which writes a report
 * the USER asked for into the workspace — not repo state.
 *
 * stdout discipline: stdout is the JSON-RPC channel. The caller MUST call
 * `setLogSink("stderr")` before `startLocalMcpServer` (the `mcp` CLI command
 * does) so tool diagnostics land on stderr.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastMCP, type Tool } from "fastmcp";
import { terramendMcpName } from "#app/external";
import type { LocalToolContext } from "#app/mcp/localContext";
import { ModuleExtractionCandidatesTool } from "#app/mcp/moduleExtraction";
import {
  ListModulesTool,
  TerraformModuleGraphTool,
  TerraformModuleInterfaceTool,
} from "#app/mcp/modules";
import { TerraformModuleTestsTool } from "#app/mcp/moduleTests";
import { TerraformProviderSchemaTool } from "#app/mcp/providerSchema";
import { TerraformRootsTool } from "#app/mcp/roots";
import {
  InfracostDiffTool,
  ReadFindingsTool,
  TerraformEmitSarifTool,
  TerraformPlanTool,
  TerraformScanTool,
  TerraformValidateTool,
  TerraformVerifyRemediationTool,
  TerraformVersionCurrencyTool,
} from "#app/mcp/terraform";
import { initToolState } from "#app/toolState";
import { log } from "#app/utils/cli";

export interface LocalMcpOptions {
  /** absolute workspace directory the tools operate on. */
  cwd: string;
  severityThreshold?: "critical" | "high" | "medium" | "low" | "info" | undefined;
  scanScope?: "full" | "diff" | undefined;
  /** newline/comma-separated approved module list (same as the action input). */
  moduleCatalogue?: string | undefined;
}

/** build the cwd-scoped context the read-only tools run against. */
export function buildLocalContext(options: LocalMcpOptions): LocalToolContext {
  return {
    payload: {
      cwd: options.cwd,
      scanScope: options.scanScope,
      severityThreshold: options.severityThreshold,
      autonomyThreshold: undefined,
      costIncreaseBlockUsd: undefined,
      moduleCatalogue: options.moduleCatalogue,
    },
    toolState: initToolState({ progressComment: undefined }),
    tmpdir: mkdtempSync(join(tmpdir(), "terramend-mcp-")),
  };
}

/**
 * The local tool set. Append-only review rule: anything added here must be
 * read-only w.r.t. the repo and runnable without GitHub context — the
 * `localServer.test.ts` snapshot exists to make additions deliberate.
 */
export function buildLocalTools(ctx: LocalToolContext): Tool<any, any>[] {
  return [
    TerraformScanTool(ctx),
    TerraformValidateTool(ctx),
    TerraformVerifyRemediationTool(ctx),
    TerraformPlanTool(ctx),
    TerraformVersionCurrencyTool(ctx),
    InfracostDiffTool(ctx),
    ReadFindingsTool(ctx),
    TerraformEmitSarifTool(ctx),
    ListModulesTool(ctx),
    TerraformModuleGraphTool(ctx),
    TerraformModuleInterfaceTool(ctx),
    TerraformModuleTestsTool(ctx),
    ModuleExtractionCandidatesTool(ctx),
    TerraformProviderSchemaTool(ctx),
    TerraformRootsTool(ctx),
  ];
}

/** the bundled CLI version when it looks like semver (esbuild injects
 * CLI_VERSION at build time); a dev run without it reports 0.0.0. */
function cliVersion(): `${number}.${number}.${number}` {
  const raw = process.env.CLI_VERSION;
  if (raw !== undefined && /^\d+\.\d+\.\d+$/.test(raw)) {
    return raw as `${number}.${number}.${number}`;
  }
  return "0.0.0";
}

export async function startLocalMcpServer(
  options: LocalMcpOptions,
): Promise<{ stop: () => Promise<void> }> {
  const ctx = buildLocalContext(options);
  const server = new FastMCP({
    name: terramendMcpName,
    version: cliVersion(),
    instructions:
      "Read-only Terraform best-practice intelligence for the workspace at " +
      `${options.cwd}. Start with terraform_scan (findings) or terraform_module_graph ` +
      "(structure); verify any fix you make with terraform_validate and prove cleared " +
      "concerns with terraform_verify_remediation. This server never holds cloud or " +
      "GitHub credentials and cannot push, comment, or open PRs.",
  });
  for (const tool of buildLocalTools(ctx)) {
    server.addTool(tool);
  }
  await server.start({ transportType: "stdio" });
  log.info(`» terramend mcp: stdio server ready (cwd: ${options.cwd})`);
  return {
    stop: async () => {
      await server.stop();
    },
  };
}
