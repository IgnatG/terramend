import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import arg from "arg";
import { startLocalMcpServer } from "#app/mcp/localServer";
import { setLogSink } from "#app/utils/log";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type SeverityFlag = (typeof SEVERITIES)[number];

const SCAN_SCOPES = ["full", "diff"] as const;
type ScanScopeFlag = (typeof SCAN_SCOPES)[number];

function isSeverity(value: string): value is SeverityFlag {
  return (SEVERITIES as readonly string[]).includes(value);
}

function isScanScope(value: string): value is ScanScopeFlag {
  return (SCAN_SCOPES as readonly string[]).includes(value);
}

interface McpCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

function printMcpUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} mcp [options]\n`);
  params.stream("start the local MCP server (stdio) exposing terramend's read-only");
  params.stream("terraform tools — scan, validate, verify, plan, version currency,");
  params.stream("modules, provider schema, roots — to MCP clients like Claude Code,");
  params.stream("Cursor, or Windsurf. example registration:");
  params.stream("  claude mcp add terramend -- npx -y terramend mcp");
  params.stream("");
  params.stream("options:");
  params.stream("  --cwd <dir>                   workspace to operate on (default: current dir)");
  params.stream(`  --severity-threshold <sev>    minimum severity (${SEVERITIES.join("|")})`);
  params.stream("  --scan-scope <scope>          full (default) or diff (vs base branch)");
  params.stream("  --module-catalogue <list>     approved modules to prefer (comma/newline-sep)");
  params.stream("  -h, --help                    show help");
}

function parseMcpArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--cwd": String,
      "--severity-threshold": String,
      "--scan-scope": String,
      "--module-catalogue": String,
      "-h": "--help",
    },
    { argv: args },
  );
}

export async function runMcpCli(params: McpCliParams): Promise<void> {
  if (params.showHelp) {
    printMcpUsage({ stream: console.log, prog: params.prog });
    return;
  }

  let parsed: ReturnType<typeof parseMcpArgs>;
  try {
    parsed = parseMcpArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printMcpUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printMcpUsage({ stream: console.log, prog: params.prog });
    return;
  }

  if (parsed._.length > 0) {
    console.error(`unexpected positional arguments for mcp: ${parsed._.join(" ")}\n`);
    printMcpUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  const rawCwd = parsed["--cwd"];
  let cwd = process.cwd();
  if (rawCwd) {
    cwd = isAbsolute(rawCwd) ? rawCwd : resolve(process.cwd(), rawCwd);
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    console.error(`--cwd is not a directory: ${cwd}`);
    process.exit(1);
  }

  const severityRaw = parsed["--severity-threshold"];
  if (severityRaw !== undefined && !isSeverity(severityRaw)) {
    console.error(
      `invalid --severity-threshold: ${severityRaw} (expected ${SEVERITIES.join("|")})`,
    );
    process.exit(1);
  }
  const scopeRaw = parsed["--scan-scope"];
  if (scopeRaw !== undefined && !isScanScope(scopeRaw)) {
    console.error(`invalid --scan-scope: ${scopeRaw} (expected ${SCAN_SCOPES.join("|")})`);
    process.exit(1);
  }

  // stdout is the JSON-RPC channel from here on — every diagnostic goes to stderr.
  setLogSink("stderr");

  const server = await startLocalMcpServer({
    cwd,
    severityThreshold: severityRaw,
    scanScope: scopeRaw,
    moduleCatalogue: parsed["--module-catalogue"],
  });

  const shutdown = (): void => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
