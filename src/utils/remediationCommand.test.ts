import { describe, expect, it } from "vitest";
import { parseRemediationCommand } from "#app/utils/remediationCommand";

describe("parseRemediationCommand (§3.12)", () => {
  it("returns null when the body has no mention", () => {
    expect(parseRemediationCommand("please fix #abc123")).toBeNull();
    expect(parseRemediationCommand(undefined)).toBeNull();
  });

  it("parses `fix #<id>` and `fix <id>` into a concern command (lowercased)", () => {
    expect(parseRemediationCommand("@terramend fix #3a9f1c2")).toEqual({
      kind: "concern",
      concernRef: "3a9f1c2",
    });
    expect(parseRemediationCommand("@terramend fix ABCDEF12")).toEqual({
      kind: "concern",
      concernRef: "abcdef12",
    });
  });

  it("parses `fix all <sev>-severity` and `fix all <sev>`", () => {
    expect(parseRemediationCommand("@terramend fix all high-severity")).toEqual({
      kind: "severity",
      severity: "high",
    });
    expect(parseRemediationCommand("@terramend fix all low")).toEqual({
      kind: "severity",
      severity: "low",
    });
  });

  it("parses `fix <sev>-severity` without `all`", () => {
    expect(parseRemediationCommand("@terramend fix critical-severity")).toEqual({
      kind: "severity",
      severity: "critical",
    });
  });

  it("parses `fix all` as everything", () => {
    expect(parseRemediationCommand("@terramend fix all")).toEqual({ kind: "all" });
  });

  it("parses a file target", () => {
    expect(parseRemediationCommand("@terramend fix modules/net/main.tf")).toEqual({
      kind: "file",
      file: "modules/net/main.tf",
    });
    expect(parseRemediationCommand("@terramend fix prod.tfvars")).toEqual({
      kind: "file",
      file: "prod.tfvars",
    });
  });

  it("tolerates surrounding prose and the [bot] suffix", () => {
    expect(
      parseRemediationCommand("hey @terramend[bot] please fix all medium-severity thanks"),
    ).toEqual({
      kind: "severity",
      severity: "medium",
    });
  });

  it("returns null for a mention that isn't a fix command", () => {
    expect(parseRemediationCommand("@terramend what's the status?")).toBeNull();
  });

  it("prefers `fix all <sev>` over a bare file/concern interpretation", () => {
    // "all" is a keyword, not a file/concern — must not be read as kind:file.
    expect(parseRemediationCommand("@terramend fix all")).toEqual({ kind: "all" });
  });

  it("does NOT read prose 'fix all the bugs' as the fix-all command", () => {
    // regression: a non-severity word after "all" is prose, not a command.
    expect(parseRemediationCommand("@terramend please fix all the bugs")).toBeNull();
    expect(parseRemediationCommand("@terramend fix all outstanding issues")).toBeNull();
  });

  it("classifies a hex-named .tf file as a file, not a concern id", () => {
    // regression: `deadbeef.tf` stem is all-hex but it's a filename.
    expect(parseRemediationCommand("@terramend fix deadbeef.tf")).toEqual({
      kind: "file",
      file: "deadbeef.tf",
    });
    expect(parseRemediationCommand("@terramend fix 0badf00d.tfvars")).toEqual({
      kind: "file",
      file: "0badf00d.tfvars",
    });
  });

  it("still reads a bare hex id (no extension) as a concern", () => {
    expect(parseRemediationCommand("@terramend fix #deadbeef please")).toEqual({
      kind: "concern",
      concernRef: "deadbeef",
    });
  });
});
