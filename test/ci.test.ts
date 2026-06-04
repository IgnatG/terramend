import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agents } from "#app/agents/index";
import type { WorkflowPermissions } from "#app/external";
import { providers } from "#app/models";

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionDir = join(__dirname, "..");

// terramend ships a single test workflow (standalone repo — there is no parent
// "root" workflow; the action's CI lives here). This test keeps that workflow's
// matrices in lockstep with the test/ source dirs and the agents/providers maps,
// so a new test file or provider can't be silently left out of CI.
const workflow = parse(
  readFileSync(join(actionDir, ".github/workflows/test.yml"), "utf-8")
) as Workflow;

type WorkflowJob = {
  "runs-on": string;
  "timeout-minutes"?: number;
  permissions?: WorkflowPermissions;
  strategy?: { "fail-fast": boolean; matrix: Record<string, unknown> };
  env?: Record<string, string>;
  steps?: unknown[];
};

type Workflow = {
  name: string;
  jobs: Record<string, WorkflowJob>;
};

// Extract the `name: "..."` declared by each test module in a test/ subdir.
// Matches a real top-level property only (not a JSDoc `* name:` comment), so a
// deliberately-disabled test (e.g. vertex-claude, whose name lives in a comment
// while it's commented out of the matrix) stays out of both sides in lockstep.
function getTestNamesFromDir(dir: string): string[] {
  const dirPath = join(__dirname, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const names: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const match = content.match(/^\s+name:\s*"([^"]+)"/m);
    if (match) {
      names.push(match[1]);
    }
  }

  return names.sort();
}

function getEnvVarNames(job: WorkflowJob): string[] {
  return Object.keys(job.env ?? {}).sort();
}

const expectedAgents = Object.keys(agents).sort();
const crossagentTests = getTestNamesFromDir("crossagent");
const agnosticTests = getTestNamesFromDir("agnostic");
const adhocTests = getTestNamesFromDir("adhoc");

// all provider API key names + managed credentials (e.g. Codex auth blob)
// + GITHUB_TOKEN + model overrides
const expectedAgentEnvVars = [
  "GITHUB_TOKEN",
  ...new Set(
    Object.values(providers).flatMap((p) => [...p.envVars, ...(p.managedCredentials ?? [])])
  ),
  "TERRAMEND_MODEL",
].sort();

const expectedAgnosticEnvVars = ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"].sort();

describe("ci workflow consistency", () => {
  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });

  describe("cross-agent (agents) job", () => {
    const job = workflow.jobs.agents;

    it("agent matrix matches the agents map", () => {
      expect((job.strategy?.matrix.agent as string[])?.slice().sort()).toEqual(expectedAgents);
    });

    it("test matrix matches the crossagent/ directory", () => {
      expect((job.strategy?.matrix.test as string[])?.slice().sort()).toEqual(crossagentTests);
    });

    it("env vars cover all provider API keys", () => {
      expect(getEnvVarNames(job)).toEqual(expectedAgentEnvVars);
    });

    it("fail-fast is enabled (bail early — this matrix spends real LLM API budget)", () => {
      expect(job.strategy?.["fail-fast"]).toBe(true);
    });
  });

  describe("agnostic job", () => {
    const job = workflow.jobs.agnostic;

    it("test matrix matches the agnostic/ directory", () => {
      expect((job.strategy?.matrix.test as string[])?.slice().sort()).toEqual(agnosticTests);
    });

    it("env vars are correct for agnostic tests", () => {
      expect(getEnvVarNames(job)).toEqual(expectedAgnosticEnvVars);
    });

    it("fail-fast is enabled", () => {
      expect(job.strategy?.["fail-fast"]).toBe(true);
    });
  });
});
