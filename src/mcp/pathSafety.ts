import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve an agent-supplied path against `cwd` and confine it to that workspace.
 *
 * Returns the absolute path when it stays inside `cwd`; throws otherwise. Blocks
 * both `..` traversal and absolute paths that point outside `cwd` (including a
 * different drive on Windows, where `relative` returns an absolute path).
 *
 * Terramend treats the agent as semi-trusted (attacker-controlled PR content can
 * prompt-inject it), so any tool that reads or writes a file path the agent
 * controls — read_findings, terraform_emit_sarif, terraform_module_interface —
 * must confine that path to the workspace. Without it the agent has an arbitrary
 * file read (findings) or write (SARIF) primitive on the runner.
 */
export function resolveWithinCwd(cwd: string, userPath: string): string {
  const base = resolve(cwd);
  const target = resolve(base, userPath);
  const rel = relative(base, target);
  // rel === "" means target IS the workspace root; a child path neither starts
  // with ".." nor is absolute. Anything else escaped the workspace.
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return target;
  }
  throw new Error(
    `path '${userPath}' escapes the workspace; only paths inside the working directory are allowed.`,
  );
}
