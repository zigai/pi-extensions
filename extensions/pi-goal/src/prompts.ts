import { formatBudget, formatDuration } from "./format.js";
import type { ThreadGoal } from "./types.js";

export const TOOL_PROMPT_GUIDELINES = [
  "Use get_goal when you need to inspect the current long-running user objective.",
  "Use create_goal when the user asks you to start tracking a concrete objective; do not create a second goal while one already exists.",
  "Use update_goal with status complete only after the objective has actually been achieved and no required work remains.",
  "When a goal is active, keep working through clear low-risk next steps instead of stopping at a plan.",
];

export function continuationPrompt(goal: ThreadGoal): string {
  return [
    "Continue working on the active goal.",
    "",
    `Objective: ${goal.objective}`,
    `Usage: ${formatBudget(goal)}, ${formatDuration(goal.usage.activeSeconds)} active`,
    "",
    "Do the next clear low-risk step. If the objective is complete, call update_goal with status complete and report the final usage.",
  ].join("\n");
}

export function budgetLimitPrompt(goal: ThreadGoal): string {
  return [
    "The active goal has reached its token budget.",
    "",
    `Objective: ${goal.objective}`,
    `Usage: ${formatBudget(goal)}, ${formatDuration(goal.usage.activeSeconds)} active`,
    "",
    "Stop after the current safe checkpoint. Summarize what is done, what remains, and ask the user before continuing.",
  ].join("\n");
}
