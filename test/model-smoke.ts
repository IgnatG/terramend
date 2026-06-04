/**
 * model-smoke: per-alias resolution + auth check that bypasses the Lintel
 * harness. resolves a model alias to its concrete provider/model + agent CLI,
 * invokes the CLI directly with a trivial "reply OK" prompt, and asserts the
 * provider replied. validates exactly the surface that changes when models.ts
 * changes — alias → resolve mapping, agent classification, env-var wiring —
 * without booting Docker, MCP, or the full agent runtime.
 *
 * tool-calling correctness is a property of the underlying model, not the
 * alias; the `providers-live` job runs the full harness smoke once per
 * provider (one standard-tier model each), which is enough.
 *
 * usage:
 *   node action/test/model-smoke.ts --slug openai/gpt
 *   LINTEL_MODEL=openai/gpt node action/test/model-smoke.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "dotenv";
import { modelAliases, resolveCliModel } from "../src/models.ts";
import { installFromNpmTarball } from "../src/utils/install.ts";
import { getDevDependencyVersion } from "../src/utils/version.ts";

config({ path: join(import.meta.dirname, "..", ".env") });
config({ path: join(import.meta.dirname, "..", "..", ".env") });

const PROMPT = "Reply with exactly OK and nothing else.";
const MATCH = /\bOK\b/i;
// xai is the slowest provider in the matrix — winning xai/grok-4.3 jobs land
// at 42-67s wall time (vs 23-41s for every other provider), brushing a 60s
// ceiling and intermittently crossing it. 120s gives ~2x headroom on the
// slowest provider observed in CI, with no downside on the fast-path
// providers since the timer only fires on actual hangs.
const TIMEOUT_MS = 120_000;

function parseSlug(): string {
  const argIdx = process.argv.indexOf("--slug");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1];
  if (process.env.LINTEL_MODEL) return process.env.LINTEL_MODEL;
  throw new Error("model-smoke: pass --slug <alias> or set LINTEL_MODEL");
}

type Plan =
  | { agent: "opencode"; cliPath: string; args: string[] }
  | { agent: "claude"; cliPath: string; args: string[] };

async function plan(slug: string): Promise<Plan> {
  const alias = modelAliases.find((a) => a.slug === slug);
  if (!alias) throw new Error(`model-smoke: unknown alias "${slug}"`);
  if (alias.routing) {
    throw new Error(
      `model-smoke: ${slug} is a routing slug (no fixed model). pass an explicit Bedrock model ID via LINTEL_MODEL or the workflow env block.`
    );
  }

  // walk the fallback chain so deprecated aliases (those with `fallback` set,
  // e.g. opencode/mimo-v2-pro-free → opencode/big-pickle) hit their replacement
  // instead of the dead resolve target. mirrors production via resolveCliModel.
  const cliModel = resolveCliModel(slug);
  if (!cliModel) throw new Error(`model-smoke: fallback chain for "${slug}" is broken or cyclic`);

  // anthropic/* aliases run through claude-code in production; everything else
  // (openai, google, xai, deepseek, moonshot, opencode, openrouter) runs through
  // opencode. mirrors the inline classification in list-aliases.ts toMatrixEntry().
  if (slug.startsWith("anthropic/")) {
    const cliPath = await installFromNpmTarball({
      packageName: "@anthropic-ai/claude-code",
      version: getDevDependencyVersion("@anthropic-ai/claude-code"),
      // 2.1.113+ ships a native binary (bin/claude.exe) wired up from
      // platform-specific optionalDependencies by the package postinstall;
      // installDependencies runs that postinstall. mirrors opencode below.
      executablePath: "bin/claude.exe",
      installDependencies: true,
    });
    // claude expects a bare model id (e.g. "claude-sonnet-4-6"), not "anthropic/claude-sonnet-4-6"
    const bareModel = cliModel.split("/").slice(1).join("/");
    // mirror production: claude.ts always passes `--effort high` (resolveEffort).
    // newer Opus (4.8+) rejects the CLI's default `thinking.type.enabled` shape
    // with a 400 and requires the adaptive-thinking API that `--effort` selects.
    return {
      agent: "claude",
      cliPath,
      args: ["-p", PROMPT, "--model", bareModel, "--effort", "high"],
    };
  }

  const cliPath = await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    // v1.14+: postinstall.mjs renames the platform-specific binary to
    // `bin/opencode.exe` for every OS — see action/agents/opencode_v2.ts.
    executablePath: "bin/opencode.exe",
    installDependencies: true,
  });
  return {
    agent: "opencode",
    cliPath,
    args: ["run", "--model", cliModel, PROMPT],
  };
}

type SpawnResult = { ok: boolean; output: string; reason: string };

function runCli(p: Plan, env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  // both claude (2.1.113+) and opencode ship native binaries now, so we invoke
  // the resolved executable directly.
  const command = p.cliPath;

  return new Promise((resolve) => {
    const child = spawn(command, p.args, { env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = stdout + (stderr ? `\n---stderr---\n${stderr}` : "");
      if (signal === "SIGKILL") {
        resolve({ ok: false, output, reason: `timed out after ${TIMEOUT_MS / 1000}s` });
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, output, reason: `exit ${code}` });
        return;
      }
      if (!MATCH.test(stdout)) {
        resolve({ ok: false, output, reason: "no OK in stdout" });
        return;
      }
      resolve({ ok: true, output, reason: "ok" });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: stderr, reason: `spawn error: ${err.message}` });
    });
  });
}

async function main(): Promise<void> {
  const slug = parseSlug();
  const tempDir = mkdtempSync(join(tmpdir(), "model-smoke-"));
  const homeDir = join(tempDir, "home");

  // installFromNpmTarball reads LINTEL_TEMP_DIR from process.env, not from
  // the spawn env, so we mutate process.env up-front. HOME/XDG_CONFIG_HOME are
  // redirected to keep the agent CLIs from picking up the dev user's config.
  process.env.LINTEL_TEMP_DIR = tempDir;
  process.env.HOME = homeDir;
  process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
  // opencode reads GOOGLE_GENERATIVE_AI_API_KEY for gemini; mirror the harness fallback.
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && process.env.GEMINI_API_KEY) {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = process.env.GEMINI_API_KEY;
  }

  console.log(`» model-smoke ${slug}`);
  const p = await plan(slug);
  console.log(`» agent=${p.agent} cmd=${[p.cliPath, ...p.args].join(" ")}`);

  const result = await runCli(p, process.env);
  if (result.ok) {
    console.log(`✓ ${slug} (${p.agent})`);
    process.exit(0);
  }

  console.error(`✗ ${slug} (${p.agent}): ${result.reason}`);
  if (result.output) console.error(result.output);
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
