import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defineTypedCommand, installTypedCommandUx, registerTypedCommand } from "pi-typed-args/pi";

import { createGoalCreationPrompt } from "./goal-creation-prompt.js";
import { formatGoalSummary } from "./format.js";
import type { GoalStartTurnStrategy } from "./recovery-machine.js";
import { compactContinuationPrompt, continuationPrompt } from "./prompts.js";
import { adjustGoal, goalsEquivalent, replaceGoal, updateGoalStatus } from "./state.js";
import {
  CUSTOM_ENTRY_TYPE,
  type GoalEntrySource,
  type GoalTimeConstraints,
  type ThreadGoal,
} from "./types.js";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  getGoalForAdjustment(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  getGoalStartTurnStrategy(): GoalStartTurnStrategy;
  resumeGoalWithContinuation(
    goalId: string,
    source: GoalEntrySource,
    ctx: GoalCommandContext,
  ): { ok: boolean; message: string; goal: ThreadGoal | null };
}

export type GoalCommandArguments = {
  task?: string | undefined;
  raw?: boolean | undefined;
  minimumTimeMinutes?: number | undefined;
  maximumTimeMinutes?: number | undefined;
  adjustExisting?: boolean | undefined;
  adjustedObjective?: string | undefined;
};

export type GoalCommandPi = Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">;

export interface GoalCommandContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

function queueGoalTurn(
  pi: GoalCommandPi,
  goal: ThreadGoal,
  kind: "command_start" | "command_resume",
): void {
  pi.sendMessage(
    {
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { kind, goalId: goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function queueGoalUserTurn(pi: GoalCommandPi, goal: ThreadGoal): void {
  pi.sendUserMessage(compactContinuationPrompt(goal), { deliverAs: "followUp" });
}

function constraintsFromArguments(args: GoalCommandArguments): GoalTimeConstraints {
  return {
    minimumActiveSeconds:
      args.minimumTimeMinutes === undefined ? null : args.minimumTimeMinutes * 60,
    maximumActiveSeconds:
      args.maximumTimeMinutes === undefined ? null : args.maximumTimeMinutes * 60,
  };
}

function hasTimeConstraints(args: GoalCommandArguments): boolean {
  return args.minimumTimeMinutes !== undefined || args.maximumTimeMinutes !== undefined;
}

async function confirmReplacement(
  host: CommandHost,
  task: string,
  ctx: GoalCommandContext,
): Promise<boolean> {
  const current = host.getGoal();
  if (current === null || current.status === "complete") {
    return true;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "An existing non-complete goal cannot be replaced without confirmation.",
      "error",
    );
    return false;
  }
  const shouldReplace = await ctx.ui.confirm(
    "Replace goal?",
    `Current goal:\n${current.objective}\n\nNew task:\n${task}`,
  );
  if (!shouldReplace) {
    ctx.ui.notify("Goal unchanged.");
  }
  return shouldReplace;
}

function handleManagementCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  command: "pause" | "resume",
  ctx: GoalCommandContext,
): void {
  const current = host.getGoal();
  if (
    command === "resume" &&
    current?.status === "active" &&
    host.getGoalStartTurnStrategy() === "userFollowUp"
  ) {
    queueGoalUserTurn(pi, current);
    ctx.ui.notify("Goal already active; queued a continuation.");
    return;
  }

  if (command === "resume" && (current?.status === "paused" || current?.status === "blocked")) {
    const result = host.resumeGoalWithContinuation(current.goalId, "command", ctx);
    ctx.ui.notify(result.message, result.ok ? undefined : "warning");
    return;
  }

  const result = updateGoalStatus(current, command === "pause" ? "paused" : "active");
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
}

async function createRawGoal(
  pi: GoalCommandPi,
  host: CommandHost,
  objective: string,
  args: GoalCommandArguments,
  ctx: GoalCommandContext,
): Promise<void> {
  if (!(await confirmReplacement(host, objective, ctx))) {
    return;
  }
  const result = replaceGoal(objective, constraintsFromArguments(args));
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, result.goal);
  } else {
    queueGoalTurn(pi, result.goal, "command_start");
  }
}

async function requestGeneratedGoal(
  pi: GoalCommandPi,
  host: CommandHost,
  task: string,
  args: GoalCommandArguments,
  ctx: GoalCommandContext,
): Promise<void> {
  if (!(await confirmReplacement(host, task, ctx))) {
    return;
  }
  const rendered = createGoalCreationPrompt(
    {
      task,
      ...(args.minimumTimeMinutes === undefined
        ? {}
        : { minimumTimeMinutes: args.minimumTimeMinutes }),
      ...(args.maximumTimeMinutes === undefined
        ? {}
        : { maximumTimeMinutes: args.maximumTimeMinutes }),
    },
    ctx,
    host.getGoal(),
  );
  if (!rendered.ok) {
    ctx.ui.notify(rendered.message, "error");
    return;
  }
  pi.sendUserMessage(rendered.prompt, { deliverAs: "followUp" });
}

function adjustExistingGoal(
  pi: GoalCommandPi,
  host: CommandHost,
  args: GoalCommandArguments,
  ctx: GoalCommandContext,
): void {
  const current = host.getGoalForAdjustment();
  if (!current) {
    ctx.ui.notify("No goal exists to adjust.", "warning");
    return;
  }
  const objective = args.adjustedObjective?.trim() || current.objective;
  const result = adjustGoal(current, objective);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }
  if (goalsEquivalent(current, result.goal)) {
    ctx.ui.notify(result.message);
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
  if (result.goal.status !== "active") {
    return;
  }
  if (host.getGoalStartTurnStrategy() === "userFollowUp") {
    queueGoalUserTurn(pi, result.goal);
  } else {
    queueGoalTurn(pi, result.goal, "command_start");
  }
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: GoalCommandArguments,
  ctx: GoalCommandContext,
): Promise<void> {
  if (args.adjustExisting === true) {
    if (args.raw === true || hasTimeConstraints(args)) {
      ctx.ui.notify(
        "Exact wording and time constraints apply only when creating a goal.",
        "warning",
      );
      return;
    }
    adjustExistingGoal(pi, host, args, ctx);
    return;
  }

  const task = args.task?.trim() ?? "";
  if (task.length === 0) {
    if (args.raw === true || hasTimeConstraints(args)) {
      ctx.ui.notify("A task or raw objective is required for these options.", "warning");
      return;
    }
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  if (args.raw !== true && (task === "pause" || task === "resume")) {
    if (hasTimeConstraints(args)) {
      ctx.ui.notify("Goal options apply only when creating a goal.", "warning");
      return;
    }
    handleManagementCommand(pi, host, task, ctx);
    return;
  }

  if (args.raw === true) {
    await createRawGoal(pi, host, task, args, ctx);
    return;
  }

  await requestGeneratedGoal(pi, host, task, args, ctx);
}

export function registerGoalCommand(pi: ExtensionAPI, host: CommandHost): void {
  installTypedCommandUx(pi, { formTrigger: "double-tab" });

  const command = defineTypedCommand({
    name: "goal",
    description: "Create, inspect, pause, resume, or adjust a goal.",
    formTitle: "Goal",
    ghostText: "describe a goal · -r for raw · double Tab for options",
    inlineHelp: "hidden",
    args: {
      task: {
        type: "string",
        position: 0,
        rest: true,
        title: "Objective",
        placeholder: "Describe the goal",
        description: "Describe the outcome to accomplish.",
        ui: {
          widget: "textarea",
          rows: 5,
          visibleWhen: (values) => values.adjustExisting !== true,
          requiredWhen: (values) => values.adjustExisting !== true,
        },
      },
      raw: {
        type: "boolean",
        aliases: ["r"],
        title: "Raw goal",
        description: "Check to use the entered text exactly, without model expansion.",
        ui: {
          widget: "toggle",
          visibleWhen: (values) => values.adjustExisting !== true,
        },
      },
      minimumTimeMinutes: {
        type: "number",
        integer: true,
        min: 1,
        formOnly: true,
        title: "Min. duration",
        description: "Minimum active time, in minutes.",
        ui: {
          widget: "number",
          visibleWhen: (values) => values.adjustExisting !== true,
        },
      },
      maximumTimeMinutes: {
        type: "number",
        integer: true,
        min: 1,
        formOnly: true,
        title: "Max. duration",
        description: "Maximum active time, in minutes.",
        ui: {
          widget: "number",
          visibleWhen: (values) => values.adjustExisting !== true,
        },
      },
      currentObjective: {
        type: "string",
        formOnly: true,
        ui: {
          widget: "computed",
          hidden: true,
          compute: () => host.getGoal()?.objective,
        },
      },
      adjustExisting: {
        type: "boolean",
        formOnly: true,
        title: "Adjust current goal",
        description: "Edit the current goal without resetting its status or usage.",
        ui: {
          widget: "toggle",
          visibleWhen: () => {
            const goal = host.getGoal();
            return goal !== null && goal.status !== "complete" && goal.status !== "timeLimited";
          },
        },
      },
      adjustedObjective: {
        type: "string",
        formOnly: true,
        title: "Updated objective",
        description: "Rewrite the outcome to accomplish.",
        ui: {
          widget: "textarea",
          rows: 5,
          copyFrom: "currentObjective",
          visibleWhen: (values) => values.adjustExisting === true,
          requiredWhen: (values) => values.adjustExisting === true,
        },
      },
    },
    refine(args) {
      const issues: Array<{
        code: string;
        message: string;
        path: string[];
        relatedPaths?: string[][];
      }> = [];
      if (
        args.minimumTimeMinutes !== undefined &&
        args.maximumTimeMinutes !== undefined &&
        args.minimumTimeMinutes > args.maximumTimeMinutes
      ) {
        issues.push({
          code: "goal.time-range.invalid",
          message: "Minimum active time must not exceed maximum active time.",
          path: ["minimumTimeMinutes"],
          relatedPaths: [["maximumTimeMinutes"]],
        });
      }
      if (
        args.adjustExisting === true &&
        (args.raw === true ||
          args.minimumTimeMinutes !== undefined ||
          args.maximumTimeMinutes !== undefined)
      ) {
        issues.push({
          code: "goal.adjust.creation-options",
          message: "Exact wording and time constraints apply only when creating a goal.",
          path: ["adjustExisting"],
          relatedPaths: [
            ...(args.raw === true ? [["raw"]] : []),
            ...(args.minimumTimeMinutes === undefined ? [] : [["minimumTimeMinutes"]]),
            ...(args.maximumTimeMinutes === undefined ? [] : [["maximumTimeMinutes"]]),
          ],
        });
      }

      if (
        args.adjustExisting === true &&
        (args.adjustedObjective === undefined || args.adjustedObjective.trim().length === 0)
      ) {
        issues.push({
          code: "goal.adjust.objective-required",
          message: "An updated objective is required when adjusting the current goal.",
          path: ["adjustedObjective"],
        });
      }
      return issues;
    },
    async run(args, ctx) {
      await handleGoalCommand(pi, host, args, ctx);
    },
  });

  registerTypedCommand(pi, command);
}
