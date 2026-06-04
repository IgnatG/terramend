import { existsSync } from "node:fs";
import { join } from "node:path";
import { detect } from "package-manager-detector";
import { resolveCommand } from "package-manager-detector/commands";
import { log } from "../utils/cli.ts";
import { ensurePackageManager, resolvePackageManagerSpec } from "../utils/packageManager.ts";
import { spawn } from "../utils/subprocess.ts";
import type { NodePackageManager, NodePrepResult, PrepDefinition, PrepOptions } from "./types.ts";

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await spawn({
    cmd: "which",
    args: [command],
    env: { PATH: process.env.PATH || "" },
  });
  return result.exitCode === 0;
}

// fallback installers for managers corepack doesn't ship shims for.
// pnpm and yarn are handled by `ensurePackageManager` (corepack); bun and
// deno fall through to here because corepack ignores them.
async function installFallback(
  name: NodePackageManager,
  installSpec: string
): Promise<string | null> {
  if (name === "npm") return null;
  log.info(`» installing ${installSpec} via npm install -g (corepack does not manage ${name})`);
  const args =
    name === "deno"
      ? ["-c", "curl -fsSL https://deno.land/install.sh | sh"]
      : ["install", "-g", installSpec];
  const cmd = name === "deno" ? "sh" : "npm";
  const result = await spawn({
    cmd,
    args,
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  if (result.exitCode !== 0) {
    return result.stderr || `failed to install ${name}`;
  }
  if (name === "deno") {
    const denoPath = join(process.env.HOME || "", ".deno", "bin");
    process.env.PATH = `${denoPath}:${process.env.PATH}`;
  }
  log.info(`» installed ${name}`);
  return null;
}

export const installNodeDependencies: PrepDefinition = {
  name: "installNodeDependencies",

  shouldRun: () => {
    const packageJsonPath = join(process.cwd(), "package.json");
    return existsSync(packageJsonPath);
  },

  run: async (options: PrepOptions): Promise<NodePrepResult> => {
    // prefer the project's declared spec (devEngines.packageManager wins over
    // packageManager). fall back to lockfile detection when nothing is declared.
    // restrict detect() to the lockfile strategy: `detected` here doubles as
    // the lockfile-presence gate below, and the default strategy set also
    // returns positives off `packageManager`/`devEngines` fields (which would
    // mask the very case we're trying to detect — declared manager but no
    // lockfile committed).
    const declared = await resolvePackageManagerSpec(process.cwd());
    const detected = await detect({ cwd: process.cwd(), strategies: ["lockfile"] });

    const packageManager: NodePackageManager =
      declared?.name ?? (detected?.name as NodePackageManager) ?? "npm";
    const agent = detected?.agent ?? packageManager;

    if (declared) {
      log.info(
        `» using ${packageManager}@${declared.version} from package.json (${declared.source})`
      );
    } else if (detected) {
      log.info(`» detected package manager: ${packageManager} (${agent})`);
    } else {
      log.info(`» no package manager declared, defaulting to npm`);
    }

    // provisioning: corepack for pnpm/yarn, legacy npm-install-g for bun/deno.
    // when shell is disabled we can't run installers (they execute code), so
    // we require the binary to already be on PATH.
    if (!(await isCommandAvailable(packageManager))) {
      if (options.ignoreScripts) {
        return {
          language: "node",
          packageManager,
          dependenciesInstalled: false,
          issues: [
            `${packageManager} is not available and cannot be installed when shell is disabled (would execute code)`,
          ],
        };
      }

      let provisioned = false;
      if (declared)
        provisioned = await ensurePackageManager({ spec: declared, binDir: options.binDir });
      if (!provisioned) {
        const fallbackSpec = declared ? `${declared.name}@${declared.version}` : packageManager;
        const installError = await installFallback(packageManager, fallbackSpec);
        if (installError) {
          return {
            language: "node",
            packageManager,
            dependenciesInstalled: false,
            issues: [installError],
          };
        }
      }
    } else if (declared) {
      // PATH already has the binary — but it may be the wrong version.
      // ensurePackageManager is idempotent (caches on `--version` match) so
      // this is cheap when main.ts already activated it.
      await ensurePackageManager({ spec: declared, binDir: options.binDir });
    }

    // frozen-lockfile install only. eager prep is non-mutating by contract:
    // we run it before the agent starts and any artifact it leaves in the
    // tree (e.g. a generated `package-lock.json`) trips the dirty-tree
    // post-run gate and produces a spurious PR. `frozen` commands
    // (`npm ci`, `pnpm install --frozen-lockfile`, etc.) were assumed to
    // fail cleanly without a lockfile — that assumption is false for
    // pnpm 11.1.1 against a no-deps `package.json` (it silently writes an
    // empty `pnpm-lock.yaml` despite the flag). gate on `detect()` having
    // found a lockfile; it walks up the tree (so monorepo subpackages
    // resolve to the workspace-root lockfile) and recognizes every
    // manager's accepted lockfile variants (`bun.lockb` + `bun.lock`,
    // `npm-shrinkwrap.json` + `package-lock.json`, etc.). when none is
    // present, the project either has no installable dependencies or
    // opts into install via a `setup` lifecycle hook
    // (`action/utils/lifecycle.ts`); either way, eager prep should skip.
    if (!detected) {
      log.info(
        `» skipping ${packageManager} install: no lockfile found (would otherwise risk lockfile drift)`
      );
      return { language: "node", packageManager, dependenciesInstalled: false, issues: [] };
    }

    const resolved = resolveCommand(agent, "frozen", []);
    if (!resolved) {
      return {
        language: "node",
        packageManager,
        dependenciesInstalled: false,
        issues: [`no frozen-install command available for ${agent}`],
      };
    }

    // SECURITY: when shell is disabled, suppress lifecycle scripts to prevent
    // agents from injecting arbitrary code execution via package.json scripts
    if (options.ignoreScripts) {
      resolved.args.push("--ignore-scripts");
      log.info("» --ignore-scripts enabled (shell disabled)");
    }

    const fullCommand = `${resolved.command} ${resolved.args.join(" ")}`;
    log.info(`» running: ${fullCommand}`);
    const result = await spawn({
      cmd: resolved.command,
      args: resolved.args,
      env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
    });

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) {
      log.startGroup(`${fullCommand} output`);
      log.info(output);
      log.endGroup();
    }

    if (result.exitCode !== 0) {
      const errorMessage = output || `exited with code ${result.exitCode}`;
      return {
        language: "node",
        packageManager,
        dependenciesInstalled: false,
        issues: [`\`${fullCommand}\` failed:\n${errorMessage}`],
      };
    }

    return {
      language: "node",
      packageManager,
      dependenciesInstalled: true,
      issues: [],
    };
  },
};
