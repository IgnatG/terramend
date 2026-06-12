import { describe, expect, it } from "vitest";
import { parseRemediationCommand, STRATEGY_REPLY_HINT } from "#app/utils/remediationCommand";

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

describe("parseRemediationCommand — bulk remediation (§37)", () => {
  it("parses `fix rule <rule-id>` into a rule command, preserving case", () => {
    expect(parseRemediationCommand("@terramend fix rule CKV_AWS_23")).toEqual({
      kind: "rule",
      ruleId: "CKV_AWS_23",
    });
    expect(parseRemediationCommand("@terramend fix rule terraform_required_version")).toEqual({
      kind: "rule",
      ruleId: "terraform_required_version",
    });
  });

  it("parses `fix all rule <rule-id>` and namespaced rule ids", () => {
    expect(parseRemediationCommand("hey @terramend fix all rule CKV2_AWS_6 please")).toEqual({
      kind: "rule",
      ruleId: "CKV2_AWS_6",
    });
    expect(parseRemediationCommand("@terramend fix rule trivy:AVD-AWS-0130")).toEqual({
      kind: "rule",
      ruleId: "trivy:AVD-AWS-0130",
    });
  });

  it("does not mistake the `rule` sweep for a severity / file / concern command", () => {
    // a rule id is not hex, not a severity word, not a *.tf file.
    const cmd = parseRemediationCommand("@terramend fix rule CKV_AWS_8");
    expect(cmd).toEqual({ kind: "rule", ruleId: "CKV_AWS_8" });
    // prose 'the rule about X' has a word between fix and rule → not a command.
    expect(parseRemediationCommand("@terramend please fix the rule about tags")).toBeNull();
  });
});

describe("parseRemediationCommand — strategy selection (§26)", () => {
  it("attaches a strategy label to a `fix #<id>` command (letter, upper-normalised)", () => {
    expect(parseRemediationCommand("@terramend fix #3a9f1c2 with strategy B")).toEqual({
      kind: "concern",
      concernRef: "3a9f1c2",
      strategy: "B",
    });
    expect(parseRemediationCommand("@terramend fix #3a9f1c2 using strategy a")).toEqual({
      kind: "concern",
      concernRef: "3a9f1c2",
      strategy: "A",
    });
  });

  it("accepts `option` / `approach` and a digit label", () => {
    expect(parseRemediationCommand("@terramend fix #deadbeef option 2")).toEqual({
      kind: "concern",
      concernRef: "deadbeef",
      strategy: "2",
    });
    expect(parseRemediationCommand("@terramend fix #deadbeef approach C")).toEqual({
      kind: "concern",
      concernRef: "deadbeef",
      strategy: "C",
    });
  });

  it("leaves strategy unset on a plain `fix #<id>`", () => {
    const result = parseRemediationCommand("@terramend fix #3a9f1c2");
    expect(result).toEqual({ kind: "concern", concernRef: "3a9f1c2" });
    expect((result as { strategy?: string }).strategy).toBeUndefined();
  });

  it("reads a bare strategy reply (concern comes from the thread)", () => {
    expect(parseRemediationCommand("@terramend strategy B")).toEqual({
      kind: "strategy",
      strategy: "B",
    });
    expect(parseRemediationCommand("@terramend let's go with option 3")).toEqual({
      kind: "strategy",
      strategy: "3",
    });
  });

  it("keeps an explicit #<id> when a strategy reply names one without `fix`", () => {
    expect(parseRemediationCommand("@terramend apply strategy A to #deadbeef")).toEqual({
      kind: "concern",
      concernRef: "deadbeef",
      strategy: "A",
    });
  });

  it("does not read prose as a strategy pick", () => {
    expect(parseRemediationCommand("@terramend this is a solid strategy overall")).toBeNull();
    expect(parseRemediationCommand("@terramend what's the best approach here?")).toBeNull();
  });

  it("round-trips the canonical reply hint through the parser", () => {
    const replied = STRATEGY_REPLY_HINT.replace("<concern-id>", "3a9f1c2").replace("<A|B|C>", "B");
    expect(parseRemediationCommand(replied)).toEqual({
      kind: "concern",
      concernRef: "3a9f1c2",
      strategy: "B",
    });
  });
});
