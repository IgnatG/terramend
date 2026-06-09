import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The agent integration matrices (the old `agents` / `agnostic` CI jobs) were
// removed from .github/workflows/test.yml — they need real LLM budget and the
// hosted token-exchange backend, so they now run locally via `pnpm runtest`
// rather than in CI. What survives is the one invariant the local harness still
// depends on: test names must be unique across the crossagent/, agnostic/, and
// adhoc/ dirs, since run.ts loads all three and resolves a name filter against
// the union (a collision would silently run the wrong test).

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
      names.push(match[1]);
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
