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
} from "#app/external";
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
  terramendMcpName,
  resolveCliModel,
  resolveDisplayAlias,
  resolveModelSlug,
  resolveOpenRouterModel,
} from "#app/external";
export type { Mode } from "#app/modes";
export { modes } from "#app/modes";
export type { BuildTerramendFooterParams } from "#app/utils/buildTerramendFooter";
export {
  buildTerramendFooter,
  TERRAMEND_DIVIDER,
  stripExistingFooter,
} from "#app/utils/buildTerramendFooter";
export type { CodexAuthBody } from "#app/utils/codexOAuth";
export {
  decodeJwtExpMs,
  OAuthInvalidGrantError,
  parseCodexAuthBody,
  refreshCodexAuthBody,
  stringifyCodexAuthBody,
} from "#app/utils/codexOAuth";
export type { ResourceUsage, UsageSummary } from "#app/utils/github";
export {
  isLeapingIntoActionCommentBody,
  LEAPING_INTO_ACTION_PREFIX,
} from "#app/utils/leapingComment";
export { MAX_LEARNINGS_LENGTH, truncateAtLineBoundary } from "#app/utils/learningsTruncate";
export type {
  CreateProgressCommentTarget,
  ProgressComment,
  ProgressCommentType,
} from "#app/utils/progressComment";
export {
  createLeapingProgressComment,
  deleteProgressCommentApi,
  getProgressComment,
  updateProgressComment,
} from "#app/utils/progressComment";
export {
  isValidTimeString,
  parseTimeString,
  TIMEOUT_DISABLED,
} from "#app/utils/time";
