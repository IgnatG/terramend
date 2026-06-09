import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agents as agentRegistry } from "#app/agents/index";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The agent integration matrices are secret- and LLM-budget-dependent, so the
// full set runs via `pnpm runtest`, not on every PR. A security-focused subset
// is restored to CI in .github/workflows/security-tests.yml (manual dispatch +
// push to main) — see AUDIT.md H-1.
//
// Two invariants this file guards (both network-free, so they gate every PR):
//   1. Test names are unique across the crossagent/, agnostic/, and adhoc/ dirs,
//      since run.ts loads all three and resolves a name filter against the union
//      (a collision would silently run the wrong test).
//   2. Every `test:`/`agent:` name in security-tests.yml resolves to a real test
//      / agent in the harness — so a rename or deletion can't silently leave the
//      security workflow pointing at a ghost (which the runner would report as
//      "no test runs after filtering", failing for an opaque reason).

// Extract the `name: "..."` declared by each test module in a test/ subdir.
// Matches a real top-level property only (not a JSDoc `* name:` comment), so a
// deliberately-disabled test whose name lives in a comment stays out.
function getTestNamesFromDir(dir: string): string[] {
  const dirPath = join(__dirname, dir);
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const names: string[] = [];

  for (const file of files) {
    const content = readFileSync(join(dirPath, file), "utf-8");
    const match = content.match(/^\s+name:\s*"([^"]+)"/m);
    if (match) {
      names.push(match[1]!);
    }
  }

  return names.sort();
}

const crossagentTests = getTestNamesFromDir("crossagent");
const agnosticTests = getTestNamesFromDir("agnostic");
const adhocTests = getTestNamesFromDir("adhoc");

describe("test harness consistency", () => {
  it("no duplicate test names across directories", () => {
    const allNames = [...crossagentTests, ...agnosticTests, ...adhocTests];
    const duplicates = allNames.filter((name, idx) => allNames.indexOf(name) !== idx);
    expect(duplicates).toEqual([]);
  });
});

describe("security-tests.yml workflow wiring", () => {
  const workflow = readFileSync(
    join(__dirname, "..", ".github", "workflows", "security-tests.yml"),
    "utf-8",
  );

  // Pull the values out of every inline matrix array (`key: [a, b, c]`) for the
  // given key. The workflow uses the inline form for both `test:` and `agent:`.
  function inlineMatrixValues(key: string): string[] {
    const re = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]+)\\]`, "gm");
    const values: string[] = [];
    let match: RegExpExecArray | null = re.exec(workflow);
    while (match !== null) {
      values.push(
        ...match[1]!
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      );
      match = re.exec(workflow);
    }
    return values;
  }

  const harnessTestNames = new Set([...crossagentTests, ...agnosticTests, ...adhocTests]);
  const registeredAgents = new Set(Object.keys(agentRegistry));

  it("every matrix `test:` name resolves to a real harness test", () => {
    const workflowTests = inlineMatrixValues("test");
    // parser sanity: if we extracted nothing, the assertion below would pass
    // vacuously and the guard would be silently dead.
    expect(workflowTests.length).toBeGreaterThan(0);
    const unknown = workflowTests.filter((t) => !harnessTestNames.has(t));
    expect(unknown).toEqual([]);
  });

  it("every matrix `agent:` is a registered agent", () => {
    const workflowAgents = inlineMatrixValues("agent");
    expect(workflowAgents.length).toBeGreaterThan(0);
    const unknown = workflowAgents.filter((a) => !registeredAgents.has(a));
    expect(unknown).toEqual([]);
  });
});
