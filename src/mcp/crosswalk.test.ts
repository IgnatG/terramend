import { describe, expect, it } from "vitest";
import {
  buildCrosswalkReport,
  ComplianceCrosswalkTool,
  mapConcernToControls,
} from "#app/mcp/crosswalk";
import type { ToolContext } from "#app/mcp/server";

describe("mapConcernToControls", () => {
  it("maps an encryption concern to encryption controls", () => {
    const { themes, controls } = mapConcernToControls({
      rule_id: "trivy:AVD-AWS-0088",
      evidence: "S3 bucket does not have server-side encryption enabled",
    });
    expect(themes).toContain("encryption-at-rest");
    expect(controls.some((c) => c.framework === "CIS Controls v8")).toBe(true);
    expect(controls.some((c) => c.framework === "NHS DSPT")).toBe(true);
  });

  it("maps a public-access concern to firewall/network controls", () => {
    const { themes, controls } = mapConcernToControls({
      rule_id: "checkov:CKV_AWS_260",
      evidence: "Security group allows ingress from 0.0.0.0/0 to port 22",
    });
    expect(themes).toContain("public-exposure");
    expect(controls.some((c) => c.framework === "Cyber Essentials")).toBe(true);
  });

  it("dedupes identical control refs across matched themes", () => {
    // matches both encryption-in-transit (tls) and public-exposure (public)
    const { controls } = mapConcernToControls({
      rule_id: "x",
      evidence: "public endpoint without TLS",
    });
    const keys = controls.map((c) => `${c.framework}|${c.control}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns empty for an unmappable concern (honest, not forced)", () => {
    const { themes, controls } = mapConcernToControls({
      rule_id: "terraform-fmt:format",
      evidence: "file is not canonically formatted",
    });
    expect(themes).toEqual([]);
    expect(controls).toEqual([]);
  });
});

describe("buildCrosswalkReport", () => {
  it("builds per-concern entries, a by-framework index, and an unmapped list", () => {
    const report = buildCrosswalkReport([
      { id: "aaa", rule_id: "trivy:AVD-AWS-0088", evidence: "bucket not encrypted at rest" },
      { id: "bbb", rule_id: "terraform-fmt:format", evidence: "not formatted" },
    ]);
    expect(report.entries.map((e) => e.concern_id)).toEqual(["aaa"]);
    expect(report.unmapped_concern_ids).toEqual(["bbb"]);
    expect(Object.keys(report.by_framework).length).toBeGreaterThan(0);
    // version + review date are carried for reproducibility.
    expect(report.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("by_framework controls are deduped and sorted", () => {
    const report = buildCrosswalkReport([
      { id: "a", rule_id: "r1", evidence: "encrypt at rest" },
      { id: "b", rule_id: "r2", evidence: "encryption kms missing" },
    ]);
    for (const controls of Object.values(report.by_framework)) {
      const ids = controls.map((c) => c.control);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids]).toEqual([...ids].sort());
    }
  });

  it("is deterministic for the same input", () => {
    const input = [{ id: "a", rule_id: "r", evidence: "public ingress without encryption" }];
    expect(buildCrosswalkReport(input)).toEqual(buildCrosswalkReport(input));
  });
});

describe("ComplianceCrosswalkTool", () => {
  it("wraps the report in the ok envelope with the indicative-crosswalk note", async () => {
    const tool = ComplianceCrosswalkTool({} as unknown as ToolContext);
    const exec = tool.execute as (
      p: unknown,
      c: unknown,
    ) => Promise<{ content: [{ type: "text"; text: string }]; isError?: boolean }>;
    const result = await exec(
      {
        concerns: [
          { id: "a", rule_id: "trivy:AVD-AWS-0088", evidence: "bucket lacks encryption" },
          { id: "z", rule_id: "none", evidence: "completely unrelated text" },
        ],
      },
      {},
    );

    const text = result.content[0].text;
    expect(result.isError).toBeUndefined();
    expect(text).toContain("ok: true");
    expect(text).toContain("concern_id: a");
    expect(text).toContain("unmapped_concern_ids[1]: z");
    expect(text).toContain("Indicative crosswalk");
    expect(text).toContain("not an audit verdict");
  });
});
