/**
 * Library entry point for npm package
 * This exports the main function for programmatic usage
 */

export type { Agent, AgentResult, AgentRunContext } from "./agents/shared.ts";
export {
  type Inputs as ExecutionInputs,
  type MainResult,
  main,
} from "./main.ts";
