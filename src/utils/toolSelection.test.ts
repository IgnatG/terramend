import { describe, expect, it } from "vitest";
import {
  parseToolSelection,
  resolveToolSelection,
  scannerToolId,
  type ToolSelectionFlags,
} from "#app/utils/toolSelection";

describe("parseToolSelection", () => {
  it("returns undefined for an unset / blank input", () => {
    expect(parseToolSelection(undefined)).toBeUndefined();
    expect(parseToolSelection("   ")).toBeUndefined();
  });

  it("reads the all / none bases", () => {
    expect(parseToolSelection("all")?.base).toBe("all");
    expect(parseToolSelection("none")?.base).toBe("none");
    expect(parseToolSelection("*")?.base).toBe("all");
  });

  it("parses +/-/bare overrides, comma or newline separated", () => {
    const d = parseToolSelection("trivy, -tflint\n+gitleaks");
    expect(d?.explicit.get("trivy")).toBe(true);
    expect(d?.explicit.get("tflint")).toBe(false);
    expect(d?.explicit.get("gitleaks")).toBe(true);
  });

  it("canonicalises aliases (tf, terraform-mcp-server, opa)", () => {
    const d = parseToolSelection("tf, terraform-mcp-server, opa");
    expect(d?.explicit.get("terraform")).toBe(true);
    expect(d?.explicit.get("terraform_mcp")).toBe(true);
    expect(d?.explicit.get("conftest")).toBe(true);
  });

  it("collects unrecognised tokens instead of failing", () => {
    const d = parseToolSelection("trivy, banana");
    expect(d?.explicit.get("trivy")).toBe(true);
    expect(d?.unknown).toEqual(["banana"]);
  });
});

describe("resolveToolSelection — default (no tools_enabled)", () => {
  const sel = resolveToolSelection({});

  it("enables permissive scanners and the required substrate", () => {
    expect(sel.enabled("terraform")).toBe(true);
    expect(sel.enabled("trivy")).toBe(true);
    expect(sel.enabled("checkov")).toBe(true);
    expect(sel.enabled("infracost")).toBe(true);
    expect(sel.enabled("conftest")).toBe(true);
  });

  it("gates non-permissive tools off with a licence-named reason", () => {
    expect(sel.enabled("tflint")).toBe(false);
    expect(sel.offReason("tflint")).toMatch(/licence-gated.*tflint/i);
    expect(sel.enabled("terraform_mcp")).toBe(false);
    expect(sel.gated).toEqual(expect.arrayContaining(["tflint", "terraform_mcp"]));
  });

  it("keeps the flag-opt-in extras off until their input is set", () => {
    expect(sel.enabled("gitleaks")).toBe(false);
    expect(sel.enabled("terratest")).toBe(false);
  });
});

describe("resolveToolSelection — dedicated booleans still opt in", () => {
  it("gitleaks: true enables it", () => {
    expect(resolveToolSelection({ gitleaks: true }).enabled("gitleaks")).toBe(true);
  });

  it("terraform_mcp: true is the licence opt-in for the gated server", () => {
    const sel = resolveToolSelection({ terraformMcp: true });
    expect(sel.enabled("terraform_mcp")).toBe(true);
    expect(sel.gated).not.toContain("terraform_mcp");
  });

  it("terratest: true enables the scaffold", () => {
    expect(resolveToolSelection({ terratest: true }).enabled("terratest")).toBe(true);
  });
});

describe("resolveToolSelection — tools_enabled overrides", () => {
  const resolve = (raw: string, flags: ToolSelectionFlags = {}) =>
    resolveToolSelection({ ...flags, toolsEnabled: parseToolSelection(raw) });

  it("naming a gated tool is the explicit licence opt-in", () => {
    expect(resolve("tflint").enabled("tflint")).toBe(true);
  });

  it("an explicit disable always wins, even over its dedicated flag", () => {
    const sel = resolve("-gitleaks", { gitleaks: true });
    expect(sel.enabled("gitleaks")).toBe(false);
    expect(sel.disabled).toContain("gitleaks");
  });

  it("an explicit disable wins over the all base", () => {
    const sel = resolve("all, -trivy");
    expect(sel.enabled("trivy")).toBe(false);
    expect(sel.enabled("tflint")).toBe(true); // all enables the gated tool too
  });

  it("base all accepts every tool (incl. gated + flag-opt-in)", () => {
    const sel = resolve("all");
    expect(sel.enabled("tflint")).toBe(true);
    expect(sel.enabled("terraform_mcp")).toBe(true);
    expect(sel.enabled("gitleaks")).toBe(true);
    expect(sel.gated).toEqual([]);
  });

  it("base none enables nothing but the substrate + the explicitly/flag-added", () => {
    const sel = resolve("none, +trivy");
    expect(sel.enabled("terraform")).toBe(true); // required, always on
    expect(sel.enabled("trivy")).toBe(true);
    expect(sel.enabled("checkov")).toBe(false);
    expect(sel.enabled("tflint")).toBe(false);
  });

  it("the required substrate cannot be disabled", () => {
    expect(resolve("-terraform").enabled("terraform")).toBe(true);
    expect(resolve("none").enabled("terraform")).toBe(true);
  });

  it("surfaces unknown tokens for a warning", () => {
    expect(resolve("trivy, nope").unknownTokens).toEqual(["nope"]);
  });
});

describe("scannerToolId", () => {
  it("maps scanner sources to their tool id", () => {
    expect(scannerToolId("terraform-fmt")).toBe("terraform");
    expect(scannerToolId("terraform-validate")).toBe("terraform");
    expect(scannerToolId("tflint")).toBe("tflint");
    expect(scannerToolId("trivy")).toBe("trivy");
    expect(scannerToolId("checkov")).toBe("checkov");
  });

  it("returns null for the reviewer pseudo-source the gate never governs", () => {
    expect(scannerToolId("reviewer")).toBeNull();
  });
});
