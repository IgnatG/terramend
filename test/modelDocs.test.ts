import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderModelDocs } from "../scripts/generate-model-docs.ts";

// Drift guard for docs/models.md: the file is generated from the alias
// registry in src/models.ts, so any catalog change (new model, preferred
// flip, resolve bump, deprecation) must ship with a regenerated doc.
// Failing here means: run `pnpm docs:models` and commit the result.
describe("docs/models.md", () => {
  it("matches a fresh render of the model catalog", () => {
    const committed = readFileSync(new URL("../docs/models.md", import.meta.url), "utf-8")
      // normalize CRLF so a Windows checkout (or core.autocrlf) can't fail the diff
      .replaceAll("\r\n", "\n");
    expect(
      committed,
      "docs/models.md is stale — regenerate with `pnpm docs:models` and commit it.",
    ).toBe(renderModelDocs());
  });
});
