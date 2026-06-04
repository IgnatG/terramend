/**
 * Startup log formatting for the resolver pipeline. Computes the
 * "model / agent / push / shell / timeout" block that main.ts prints
 * after resolving the agent + model + payload.
 */

import { log } from "#app/utils/cli";
import type { ResolvedPayload } from "#app/utils/payload";
import { TIMEOUT_DISABLED } from "#app/utils/time";

function resolveTimeoutForLog(timeout: string | undefined): string {
  if (!timeout) return "1h (default)";
  if (timeout === TIMEOUT_DISABLED) return "none (disabled)";
  return timeout;
}

function resolveModelForLog(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
}): string {
  const envModel = process.env.TERRAMEND_MODEL?.trim();
  if (envModel) return `${envModel} (override via TERRAMEND_MODEL)`;
  if (ctx.resolvedModel && ctx.payload.model && ctx.payload.model !== ctx.resolvedModel) {
    return `${ctx.resolvedModel} (resolved from ${ctx.payload.model})`;
  }
  if (ctx.resolvedModel) return ctx.resolvedModel;
  if (ctx.payload.model) return `${ctx.payload.model} (unresolved)`;
  return "auto";
}

function resolveAgentForLog(ctx: { agentName: string; resolvedModel: string | undefined }): string {
  const envAgent = process.env.TERRAMEND_AGENT?.trim();
  if (envAgent && envAgent === ctx.agentName) {
    return `${ctx.agentName} (override via TERRAMEND_AGENT)`;
  }
  if (ctx.agentName === "claude" && ctx.resolvedModel) {
    return `${ctx.agentName} (auto-selected for ${ctx.resolvedModel})`;
  }
  return ctx.agentName;
}

/**
 * Emit the startup block ("» model / agent / push / shell / timeout") after
 * the agent and model are resolved. Single side-effect; no return.
 */
export function logRunStartup(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
  agentName: string;
}): void {
  log.info(
    `» model:   ${resolveModelForLog({ payload: ctx.payload, resolvedModel: ctx.resolvedModel })}`
  );
  log.info(
    `» agent:   ${resolveAgentForLog({ agentName: ctx.agentName, resolvedModel: ctx.resolvedModel })}`
  );
  log.info(`» push:    ${ctx.payload.push}`);
  log.info(`» shell:   ${ctx.payload.shell}`);
  log.info(`» timeout: ${resolveTimeoutForLog(ctx.payload.timeout)}`);
}
