import { describe, expect, it } from "vitest";
import {
  ALL_TOOL_IDS,
  isLicenseGated,
  isPermissive,
  LICENSE_GATED_TOOLS,
  TOOL_LICENSES,
  type ToolId,
} from "#app/utils/toolLicensing";

describe("TOOL_LICENSES catalogue", () => {
  it("classifies every tool with a self-consistent id", () => {
    for (const id of ALL_TOOL_IDS) {
      const t = TOOL_LICENSES[id];
      expect(t.id).toBe(id);
      expect(t.name).toBeTruthy();
      expect(t.license).toBeTruthy();
      expect(["permissive", "copyleft", "source-available"]).toContain(t.class);
    }
  });

  it("treats only MIT/Apache/BSD-style licences as permissive", () => {
    expect(isPermissive("permissive")).toBe(true);
    expect(isPermissive("copyleft")).toBe(false);
    expect(isPermissive("source-available")).toBe(false);
  });
});

describe("isLicenseGated", () => {
  it("gates non-permissive optional tools (tflint, terraform_mcp)", () => {
    expect(isLicenseGated("tflint")).toBe(true);
    expect(isLicenseGated("terraform_mcp")).toBe(true);
  });

  it("does not gate permissive tools (trivy, checkov, gitleaks)", () => {
    expect(isLicenseGated("trivy")).toBe(false);
    expect(isLicenseGated("checkov")).toBe(false);
    expect(isLicenseGated("gitleaks")).toBe(false);
  });

  it("exempts the required substrate even though Terraform is BUSL", () => {
    expect(TOOL_LICENSES.terraform.class).toBe("source-available");
    expect(TOOL_LICENSES.terraform.required).toBe(true);
    // required ⇒ never gated, so a Terraform fixer always has Terraform.
    expect(isLicenseGated("terraform")).toBe(false);
  });

  it("LICENSE_GATED_TOOLS is exactly the gated set", () => {
    const expected = ALL_TOOL_IDS.filter((id: ToolId) => isLicenseGated(id));
    expect([...LICENSE_GATED_TOOLS].sort()).toEqual([...expected].sort());
    // and it matches the documented gated tools.
    expect([...LICENSE_GATED_TOOLS].sort()).toEqual(["terraform_mcp", "tflint"]);
  });
});
