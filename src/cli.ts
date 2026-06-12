import { basename } from "node:path";
import arg from "arg";
import pc from "picocolors";
import { runCli as runGhaCli } from "#app/commands/gha";
import { runMcpCli } from "#app/commands/mcp";

const VERSION = process.env.CLI_VERSION ?? "0.0.0";
const bin = basename(process.argv[1] || "");
const PROG = bin === "pf" || bin === "terramend" ? bin : "terramend";
const rawArgs = process.argv.slice(2);

function printMainUsage(stream: typeof console.log): void {
  stream(`usage: ${PROG} <command>\n`);
  stream("commands:");
  stream("  gha         run the github action runtime flow (used by action.yml)");
  stream("  mcp         start the local MCP server (stdio) with read-only terraform tools");
  stream("");
  stream("global options:");
  stream("  -h, --help      show help");
  stream("  -v, --version   show version");
}

function parseGlobalArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--version": Boolean,
      "-h": "--help",
      "-v": "--version",
    },
    {
      argv: args,
      stopAtPositional: true,
    },
  );
}

function exitWithUsageError(message: string): never {
  console.error(`${message}\n`);
  printMainUsage(console.error);
  process.exit(1);
}

async function run(): Promise<void> {
  let globalParsed: ReturnType<typeof parseGlobalArgs>;
  try {
    globalParsed = parseGlobalArgs(rawArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitWithUsageError(message);
  }

  if (globalParsed["--version"]) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = globalParsed._[0];
  const commandArgs = globalParsed._.slice(1);

  if (!command) {
    if (globalParsed["--help"]) {
      console.log(`${pc.bold("terramend")} v${VERSION}\n`);
      printMainUsage(console.log);
      process.exit(0);
    }
    printMainUsage(console.log);
    process.exit(0);
  }

  if (command === "gha") {
    await runGhaCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (command === "mcp") {
    await runMcpCli({
      args: commandArgs,
      prog: PROG,
      showHelp: globalParsed["--help"] === true,
    });
    return;
  }

  if (globalParsed["--help"]) {
    printMainUsage(console.log);
    process.exit(0);
  }

  console.error(`unknown command: ${pc.bold(command)}\n`);
  printMainUsage(console.error);
  process.exit(1);
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}
