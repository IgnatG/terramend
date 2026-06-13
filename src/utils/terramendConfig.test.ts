import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTerramendConfig, parseTerramendConfig } from "#app/utils/terramendConfig";

describe("parseTerramendConfig", () => {
  it("reads scalar values verbatim", () => {
    const { values, warnings } = parseTerramendConfig(
      ["scan_scope: diff", "severity_threshold: high", "module_catalogue: ./modules/net"].join(
        "\n",
      ),
    );
    expect(values).toEqual({
      scan_scope: "diff",
      severity_threshold: "high",
      module_catalogue: "./modules/net",
    });
    expect(warnings).toEqual([]);
  });

  it("joins list values with newlines (so the input parsers split them)", () => {
    const { values } = parseTerramendConfig(
      [
        "tools_enabled:",
        "  - trivy",
        "  - -tflint",
        "protected_paths:",
        "  - prod/**",
        "  - '**/state/**'",
      ].join("\n"),
    );
    expect(values.tools_enabled).toBe("trivy\n-tflint");
    expect(values.protected_paths).toBe("prod/**\n**/state/**");
  });

  it("warns and skips an unrecognised key", () => {
    const { values, warnings } = parseTerramendConfig("nope: 1\ntools_enabled: trivy");
    expect(values).toEqual({ tools_enabled: "trivy" });
    expect(warnings).toEqual([expect.stringContaining('unrecognised key "nope"')]);
  });

  it("warns and skips a value of the wrong shape (a mapping)", () => {
    const { values, warnings } = parseTerramendConfig("tools_enabled:\n  a: 1");
    expect(values).toEqual({});
    expect(warnings).toEqual([expect.stringContaining("expected a string or a list")]);
  });

  it("ignores blank list entries, dropping the key when nothing remains", () => {
    const { values } = parseTerramendConfig("allowed_paths:\n  - ''\n  - '   '");
    expect(values.allowed_paths).toBeUndefined();
  });

  it("treats an empty / comment-only file as a valid no-op", () => {
    expect(parseTerramendConfig("# just a comment\n")).toEqual({ values: {}, warnings: [] });
    expect(parseTerramendConfig("")).toEqual({ values: {}, warnings: [] });
  });

  it("warns on malformed YAML instead of throwing", () => {
    const { values, warnings } = parseTerramendConfig("tools_enabled: [unterminated");
    expect(values).toEqual({});
    expect(warnings).toEqual([expect.stringContaining("not valid YAML")]);
  });

  it("warns when the document is a list, not a mapping", () => {
    const { values, warnings } = parseTerramendConfig("- trivy\n- checkov");
    expect(values).toEqual({});
    expect(warnings).toEqual([expect.stringContaining("must be a YAML mapping")]);
  });
});

describe("loadTerramendConfig", () => {
  const dirs: string[] = [];
  const makeDir = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "terramend-cfg-"));
    dirs.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads a .terramend.yml from the given dir", () => {
    const dir = makeDir({ ".terramend.yml": "tools_enabled: tflint\nscan_scope: diff" });
    expect(loadTerramendConfig(dir)).toEqual({ tools_enabled: "tflint", scan_scope: "diff" });
  });

  it("falls back to the .yaml spelling", () => {
    const dir = makeDir({ ".terramend.yaml": "severity_threshold: high" });
    expect(loadTerramendConfig(dir)).toEqual({ severity_threshold: "high" });
  });

  it("returns {} when no config file is present", () => {
    const dir = makeDir({ "main.tf": "" });
    expect(loadTerramendConfig(dir)).toEqual({});
  });
});
