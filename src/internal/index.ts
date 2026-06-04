/**
 * Internal entrypoint for the root app.
 * Re-exports shared types, values, and utilities needed by the Next.js app.
 */

export type {
  AuthorPermission,
  ModelAlias,
  ModelProvider,
  Payload,
  PayloadEvent,
  ProviderConfig,
  PushPermission,
  ShellPermission,
  ToolPermission,
  WriteablePayload,
} from "../external.ts";
export {
  DEFAULT_PROXY_MODEL,
  getAutoSelectHintModel,
  getModelEnvVars,
  getModelManagedCredentials,
  getModelProvider,
  getProviderDisplayName,
  modelAliases,
  parseModel,
  providers,
  lintelMcpName,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelSlug,
  resolveOpenRouterModel,
} from "../external.ts";
export type { Mode } from "../modes.ts";
export { modes } from "../modes.ts";
export type {
  BuildLintelFooterParams,
  WorkflowRunFooterInfo,
} from "../utils/buildLintelFooter.ts";
export {
  buildLintelFooter,
  LINTEL_DIVIDER,
  stripExistingFooter,
} from "../utils/buildLintelFooter.ts";
export type { CodexAuthBody } from "../utils/codexOAuth.ts";
export {
  decodeJwtExpMs,
  OAuthInvalidGrantError,
  parseCodexAuthBody,
  refreshCodexAuthBody,
  stringifyCodexAuthBody,
} from "../utils/codexOAuth.ts";
export type { ResourceUsage, UsageSummary } from "../utils/github.ts";
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "../utils/leapingComment.ts";
export { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "../utils/learningsTruncate.ts";
export type {
  CreateProgressCommentTarget,
  ProgressComment,
  ProgressCommentType,
} from "../utils/progressComment.ts";
export {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  getProgressComment,
  updateProgressComment,
} from "../utils/progressComment.ts";
export {
  isValidTimeString,
  parseTimeString,
  TIMEOUT_DISABLED,
} from "../utils/time.ts";
