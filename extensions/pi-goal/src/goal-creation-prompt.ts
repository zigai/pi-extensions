import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadGoalSettings } from "./goal-settings.js";
import { escapeXmlText } from "./prompts.js";
import type { ThreadGoal } from "./types.js";

const BUNDLED_PROMPT_PATH = fileURLToPath(new URL("../prompts/create-goal.md", import.meta.url));

const TEMPLATE_ATTRIBUTE_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g;
const KNOWN_TEMPLATE_ATTRIBUTES = new Set([
  "constraints",
  "currentGoal",
  "cwd",
  "maximumTimeMinutes",
  "minimumTimeMinutes",
  "task",
]);
const REQUIRED_TEMPLATE_ATTRIBUTES = ["task", "constraints"] as const;

export type GoalCreationPromptInput = {
  task: string;
  minimumTimeMinutes?: number;
  maximumTimeMinutes?: number;
};

export type GoalCreationPromptResult =
  | { ok: true; prompt: string; templatePath: string }
  | { ok: false; message: string };

function constraintsText(input: GoalCreationPromptInput): string {
  const lines: string[] = [];
  if (input.minimumTimeMinutes !== undefined) {
    lines.push(
      `- Minimum active time: ${input.minimumTimeMinutes} minute${input.minimumTimeMinutes === 1 ? "" : "s"}.`,
      `- Pass minimum_time_minutes=${input.minimumTimeMinutes} to create_goal.`,
    );
  }
  if (input.maximumTimeMinutes !== undefined) {
    lines.push(
      `- Maximum active time: ${input.maximumTimeMinutes} minute${input.maximumTimeMinutes === 1 ? "" : "s"}.`,
      `- Pass maximum_time_minutes=${input.maximumTimeMinutes} to create_goal.`,
    );
  }
  if (lines.length === 0) {
    lines.push("- No active-time constraints requested.");
  }
  return lines.join("\n");
}

function currentGoalText(goal: ThreadGoal | null): string {
  if (goal === null) {
    return "none";
  }
  return `${goal.status}: ${goal.objective}`;
}

export function renderGoalCreationTemplate(
  template: string,
  input: GoalCreationPromptInput,
  context: { cwd: string; currentGoal: ThreadGoal | null },
): GoalCreationPromptResult {
  const attributes = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_ATTRIBUTE_PATTERN)) {
    const attribute = match[1];
    if (attribute !== undefined) {
      attributes.add(attribute);
    }
  }
  const unknown = [...attributes].filter((attribute) => !KNOWN_TEMPLATE_ATTRIBUTES.has(attribute));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `Unknown goal prompt attribute${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    };
  }
  const missing = REQUIRED_TEMPLATE_ATTRIBUTES.filter((attribute) => !attributes.has(attribute));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `Goal prompt template must include ${missing.map((item) => `{{${item}}}`).join(" and ")}.`,
    };
  }

  const values: Record<string, string> = {
    constraints: escapeXmlText(constraintsText(input)),
    currentGoal: escapeXmlText(currentGoalText(context.currentGoal)),
    cwd: escapeXmlText(context.cwd),
    maximumTimeMinutes:
      input.maximumTimeMinutes === undefined ? "unset" : String(input.maximumTimeMinutes),
    minimumTimeMinutes:
      input.minimumTimeMinutes === undefined ? "unset" : String(input.minimumTimeMinutes),
    task: escapeXmlText(input.task.trim()),
  };
  const prompt = template.replace(
    TEMPLATE_ATTRIBUTE_PATTERN,
    (_match, attribute: string) => values[attribute] ?? "",
  );
  return { ok: true, prompt, templatePath: "" };
}

/** Resolve settings, read the selected template on every invocation, and render its attributes. */
export function createGoalCreationPrompt(
  input: GoalCreationPromptInput,
  ctx: Pick<ExtensionCommandContext, "cwd" | "isProjectTrusted">,
  currentGoal: ThreadGoal | null,
  agentDir?: string,
): GoalCreationPromptResult {
  const loaded = loadGoalSettings(ctx, agentDir);
  if (!loaded.ok) {
    return { ok: false, message: loaded.message };
  }
  try {
    const templatePath = loaded.settings.creationPromptPath ?? BUNDLED_PROMPT_PATH;
    const template = readFileSync(templatePath, "utf8");
    const result = renderGoalCreationTemplate(template, input, {
      cwd: ctx.cwd,
      currentGoal,
    });
    if (!result.ok) {
      return result;
    }
    return { ok: true, prompt: result.prompt, templatePath };
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : "Unknown prompt configuration error.";
    return { ok: false, message: `Could not create goal prompt: ${message}` };
  }
}
