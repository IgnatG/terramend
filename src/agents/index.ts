import { claude } from "#app/agents/claude";
// v2 harness — adapted to opencode-ai >=1.14.x SDK-v2 / Effect-ts CLI rewrite.
// The legacy v1 module (`./opencode.ts`) is kept around for reference + fast
// revert; the active runner is the v2 module below.
import { opencode } from "#app/agents/opencode_v2";
import type { Agent } from "#app/agents/shared";

export type { Agent, AgentUsage } from "#app/agents/shared";

export const agents = { claude, opencode } satisfies Record<string, Agent>;
