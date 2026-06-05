import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_PATHS, globToRegex, isPathAllowed } from "#app/mcp/guardrails";

describe("globToRegex", () => {
  it("matches **/*.tf at any depth", () => {
    const re = globToRegex("**/*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("main.tfvars")).toBe(false);
    expect(re.test("src/app.ts")).toBe(false);
  });

  it("matches a directory subtree with **", () => {
    const re = globToRegex("modules/**");
    expect(re.test("modules/net/vpc.tf")).toBe(true);
    expect(re.test("modules/x")).toBe(true);
    expect(re.test("other/x.tf")).toBe(false);
  });

  it("single * stays within a path segment", () => {
    const re = globToRegex("*.tf");
    expect(re.test("main.tf")).toBe(true);
    expect(re.test("modules/main.tf")).toBe(false);
  });
});

describe("isPathAllowed (default Terraform allow-list)", () => {
  const globs = [...DEFAULT_ALLOWED_PATHS];

  it("allows .tf and .tfvars at any depth", () => {
    expect(isPathAllowed("main.tf", globs)).toBe(true);
    expect(isPathAllowed("modules/net/vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("envs/prod.tfvars", globs)).toBe(true);
  });

  it("rejects anything that isn't Terraform", () => {
    expect(isPathAllowed(".github/workflows/ci.yml", globs)).toBe(false);
    expect(isPathAllowed("src/index.ts", globs)).toBe(false);
    expect(isPathAllowed("README.md", globs)).toBe(false);
  });

  it("normalizes windows separators and leading ./", () => {
    expect(isPathAllowed("modules\\net\\vpc.tf", globs)).toBe(true);
    expect(isPathAllowed("./main.tf", globs)).toBe(true);
  });
});
