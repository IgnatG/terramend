import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "#app/utils/cli";

/**
 * skills bundled with the action runtime. the SKILL.md files live in
 * `action/skills/<name>/SKILL.md` and are read at runtime — no esbuild loader,
 * no codegen. this matters because the preview / oss path runs `cli.ts` from
 * source (see `runCli.ts#runLocalCli`) where esbuild loaders don't apply.
 */
const BUNDLED_SKILL_NAMES = ["terraform-best-practices"] as const;

/**
 * resolve the on-disk path of a bundled SKILL.md by checking the two locations
 * the file may live in:
 *   - source mode (`runLocalCli`): `<actionRoot>/skills/<name>/SKILL.md`,
 *     reached as `../skills/...` from `utils/skills.ts`.
 *   - bundled mode (npx published package): `<distDir>/skills/<name>/SKILL.md`,
 *     reached as `./skills/...` from `dist/cli.mjs`.
 *
 * the bundled-mode copy is produced by an esbuild post-build step in
 * `esbuild.config.js`.
 */
function resolveSkillPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "skills", name, "SKILL.md"),
    join(here, "skills", name, "SKILL.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`bundled skill not found: ${name} (looked in ${candidates.join(", ")})`);
}

/**
 * each agent has its own auto-scan dir under HOME. we write to all of them so
 * the same `installBundledSkills` call works regardless of which agent is
 * running, without coupling skills.ts to agent identity.
 *
 * verified empirically (PR #565):
 *   - OpenCode registers skills from `$HOME/.agents/skills/` and `.opencode/skills/`.
 *   - Claude Code only registers skills from `$HOME/.claude/skills/` —
 *     it does NOT scan `.agents/skills/`, so writing only there leaves the
 *     skill on disk but invisible to Claude's `Skill` tool.
 */
const SKILL_TARGET_DIRS = [".opencode/skills", ".claude/skills", ".agents/skills"] as const;

/**
 * write all bundled skills into the fake HOME so OpenCode / Claude Code discover
 * them via their auto-scan directories.
 *
 * called once per agent run from each agent's `run()`. cheap (small file
 * writes), no network, idempotent.
 */
export function installBundledSkills(params: { home: string }): void {
  for (const name of BUNDLED_SKILL_NAMES) {
    const content = readFileSync(resolveSkillPath(name), "utf8");
    for (const targetDir of SKILL_TARGET_DIRS) {
      const skillDir = join(params.home, targetDir, name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), content);
    }
  }
  log.success(`installed bundled skills: ${BUNDLED_SKILL_NAMES.join(", ")}`);
}
