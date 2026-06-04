import { describe, expect, it } from "vitest";
import { parseConftestOutput } from "#app/mcp/policy";

describe("parseConftestOutput", () => {
  it("returns a clean pass for empty/malformed input", () => {
    expect(parseConftestOutput("")).toEqual({ passed: true, failures: [], warnings: [], tested: 0 });
    expect(parseConftestOutput("not json")).toEqual({ passed: true, failures: [], warnings: [], tested: 0 });
    expect(parseConftestOutput("{}")).toEqual({ passed: true, failures: [], warnings: [], tested: 0 });
  });

  it("counts successes and reports zero failures as passed", () => {
    const out = parseConftestOutput(
      JSON.stringify([{ filename: "plan.json", namespace: "main", successes: 3, failures: [], warnings: [] }])
    );
    expect(out.passed).toBe(true);
    expect(out.tested).toBe(3);
    expect(out.failures).toHaveLength(0);
  });

  it("captures failures with file + level and fails the gate", () => {
    const out = parseConftestOutput(
      JSON.stringify([
        {
          filename: "plan.json",
          successes: 1,
          failures: [{ msg: "S3 bucket must be encrypted" }],
          warnings: [{ msg: "consider tagging" }],
        },
      ])
    );
    expect(out.passed).toBe(false);
    expect(out.failures).toEqual([{ msg: "S3 bucket must be encrypted", file: "plan.json", level: "failure" }]);
    expect(out.warnings).toEqual([{ msg: "consider tagging", file: "plan.json", level: "warning" }]);
    // 1 success + 1 failure + 1 warning
    expect(out.tested).toBe(3);
  });

  it("warnings alone do not fail the gate", () => {
    const out = parseConftestOutput(
      JSON.stringify([{ filename: "plan.json", warnings: [{ msg: "w" }] }])
    );
    expect(out.passed).toBe(true);
    expect(out.warnings).toHaveLength(1);
  });

  it("aggregates failures across multiple files", () => {
    const out = parseConftestOutput(
      JSON.stringify([
        { filename: "a.json", failures: [{ msg: "x" }] },
        { filename: "b.json", failures: [{ msg: "y" }] },
      ])
    );
    expect(out.passed).toBe(false);
    expect(out.failures.map((f) => f.file)).toEqual(["a.json", "b.json"]);
  });

  it("defaults a missing failure message and filename", () => {
    const out = parseConftestOutput(JSON.stringify([{ failures: [{}] }]));
    expect(out.failures[0]).toEqual({ msg: "policy violation", file: "(plan)", level: "failure" });
  });
});
