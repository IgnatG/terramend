import { stripExistingFooter } from "#app/utils/buildTerramendFooter";

/**
 * The prefix text for the initial "leaping into action" comment.
 * Used to detect whether a progress comment is still in its initial state
 * and hasn't been updated with real progress or error messages.
 *
 * Lives in `utils/` (not `mcp/`) so it can be re-exported via `terramend/internal`
 * without dragging the MCP server's transitive imports into the Next.js app's
 * type-check graph.
 */
export const LEAPING_INTO_ACTION_PREFIX = "Leaping into action";

export function isLeapingIntoActionCommentBody(body: string): boolean {
  const content = stripExistingFooter(body).trimStart();
  const firstLine = content.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
  return new RegExp(`(^|\\s)${LEAPING_INTO_ACTION_PREFIX}(\\.\\.\\.)?$`).test(firstLine);
}
