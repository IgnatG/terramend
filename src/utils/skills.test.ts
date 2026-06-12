import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installBundledSkills } from "#app/utils/skills";

vi.mock("#app/utils/cli", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { log } from "#app/utils/cli";

const successMock = vi.mocked(log.success);

const TEMP = mkdtempSync(join(tmpdir(), "terramend-skills-"));

afterAll(() => {
  rmSync(TEMP, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installBundledSkills", () => {
  it("writes every bundled skill into all agent auto-scan dirs under HOME", () => {
    const home = join(TEMP, "home");
    installBundledSkills({ home });

    const targets = [".opencode/skills", ".claude/skills", ".agents/skills"].map((dir) =>
      join(home, dir, "terraform-best-practices", "SKILL.md"),
    );
    const contents = targets.map((path) => readFileSync(path, "utf8"));
    for (const content of contents) {
      expect(content.length).toBeGreaterThan(0);
      expect(content).toBe(contents[0]);
    }
    expect(successMock).toHaveBeenCalledWith(expect.stringContaining("terraform-best-practices"));
  });
});
