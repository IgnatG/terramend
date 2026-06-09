import { claude } from "#app/agents/claude";
// In-process OpenCode harness, adapted to opencode-ai >=1.14.x SDK-v2 /
// Effect-ts CLI rewrite. (The legacy CLI-subprocess harness was removed; see
// git history if a revert is ever needed.)
import { opencode } from "#app/agents/opencode";
import type { Agent } from "#app/agents/shared";

export type { Agent, AgentUsage } from "#app/agents/shared";

export const agents = { claude, opencode } satisfies Record<string, Agent>;
