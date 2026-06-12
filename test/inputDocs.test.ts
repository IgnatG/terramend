import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderActionInputDocs } from "../scripts/generate-input-docs.ts";

// Drift guard for docs/action-inputs.md: the file is generated from action.yml,
// so any manifest change (new input, default change, description edit) must
// ship with a regenerated doc.
// Failing here means: run `pnpm docs:inputs` and commit the result.
describe("docs/action-inputs.md", () => {
  it("matches a fresh render of action.yml", () => {
    const committed = readFileSync(new URL("../docs/action-inputs.md", import.meta.url), "utf-8")
      // normalize CRLF so a Windows checkout (or core.autocrlf) can't fail the diff
      .replaceAll("\r\n", "\n");
    expect(
      committed,
      "docs/action-inputs.md is stale — regenerate with `pnpm docs:inputs` and commit it.",
    ).toBe(renderActionInputDocs());
  });
});
