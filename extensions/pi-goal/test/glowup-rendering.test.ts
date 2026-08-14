import { initTheme, ToolExecutionComponent, defineTool } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  setCapabilities,
  TuiAltScreen,
  TuiMainScreen,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import glowupExtension from "@zigai/pi-glowup";
import { withGlowupRendering } from "@zigai/pi-glowup/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createGoalGlowupRendering,
  getGoalGlowupRendering,
  updateGoalGlowupRendering,
} from "../src/glowup-rendering.js";
import { VirtualTerminal } from "./support/virtual-terminal.js";

type ExtensionHandler = (...args: unknown[]) => unknown;
type GlowupConsumerApi = {
  readonly on: (eventName: string, handler: unknown) => void;
};
type GlowupInstaller = (api: GlowupConsumerApi) => Promise<void>;

function isExtensionHandler(value: unknown): value is ExtensionHandler {
  return typeof value === "function";
}

function isGlowupInstaller(value: unknown): value is GlowupInstaller {
  return typeof value === "function";
}

class GlowupConsumerHarness {
  private readonly handlers = new Map<string, ExtensionHandler[]>();
  private readonly api: GlowupConsumerApi;

  constructor() {
    const boundary = {
      on: (eventName: string, handler: unknown): void => {
        if (!isExtensionHandler(handler))
          throw new TypeError(`${eventName} handler must be callable`);
        const eventHandlers = this.handlers.get(eventName) ?? [];
        eventHandlers.push(handler);
        this.handlers.set(eventName, eventHandlers);
      },
    };
    this.api = boundary;
  }

  async install(): Promise<void> {
    const installer: unknown = glowupExtension;
    if (!isGlowupInstaller(installer)) throw new TypeError("Glowup extension must be callable");
    await installer(this.api);
  }

  async shutdown(): Promise<void> {
    for (const handler of this.handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown", reason: "quit" }, {});
    }
  }
}

class LinesComponent implements Component {
  constructor(private readonly lines: readonly string[]) {}

  render(width: number): string[] {
    void width;
    return [...this.lines];
  }

  invalidate(): void {}
}

const createGoalDefinition = withGlowupRendering(
  defineTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a goal.",
    parameters: Type.Object({ objective: Type.String() }),
    async execute() {
      return { content: [{ type: "text" as const, text: "unused" }], details: {} };
    },
  }),
  createGoalGlowupRendering,
);

const updateGoalDefinition = withGlowupRendering(
  defineTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Update a goal.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
    }),
    async execute() {
      return { content: [{ type: "text" as const, text: "unused" }], details: {} };
    },
  }),
  updateGoalGlowupRendering,
);

const getGoalDefinition = withGlowupRendering(
  defineTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Get a goal.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "unused" }], details: {} };
    },
  }),
  getGoalGlowupRendering,
);

function goalResult(objective: string, status: "active" | "complete" = "active") {
  const goal = {
    goalId: "goal-tui",
    objective,
    status,
    minimumActiveSeconds: null,
    maximumActiveSeconds: null,
    tokensUsed: 125_000,
    timeUsedSeconds: 125,
    createdAt: 1,
    updatedAt: 2,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ goal }) }],
    details: { goal },
    isError: false,
  };
}

const originalCapabilities = getCapabilities();
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const agentDirectory = mkdtempSync(join(tmpdir(), "pi-goal-tui-"));
const consumer = new GlowupConsumerHarness();
let activeTerminal: VirtualTerminal | undefined;
let activeTui: TUI | undefined;

beforeAll(async () => {
  const settingsDirectory = join(agentDirectory, "extension-settings");
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(
    join(settingsDirectory, "pi-glowup.json"),
    JSON.stringify({ toolLabels: { mode: "lifecycle" } }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  await consumer.install();
});

beforeEach(() => {
  initTheme("dark");
  setCapabilities({ ...originalCapabilities, trueColor: true });
});

afterEach(async () => {
  activeTui?.stop();
  await activeTerminal?.settle(0);
  activeTerminal?.dispose();
  activeTui = undefined;
  activeTerminal = undefined;
  setCapabilities(originalCapabilities);
});

afterAll(async () => {
  await consumer.shutdown();
  setCapabilities(originalCapabilities);
  rmSync(agentDirectory, { recursive: true, force: true });
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});

const variants = [
  {
    mode: "main screen",
    columns: 68,
    createTui: (terminal: VirtualTerminal): TUI => new TuiMainScreen(terminal),
  },
  {
    mode: "alternate screen",
    columns: 56,
    createTui: (terminal: VirtualTerminal): TUI => new TuiAltScreen(terminal),
  },
] as const;

describe.each(variants)("goal tool rendering through Pi's $mode TUI", ({ columns, createTui }) => {
  it("clears stale rows when a streaming create objective shrinks and completes safely", async () => {
    const terminal = new VirtualTerminal(columns, 24);
    const tui = createTui(terminal);
    tui.setClearOnShrink(true);
    const tool = new ToolExecutionComponent(
      "create_goal",
      "create-goal-tui",
      {},
      undefined,
      createGoalDefinition,
      tui,
      process.cwd(),
    );
    tui.addChild(new LinesComponent(["BEFORE_CREATE_SENTINEL"]));
    tui.addChild(tool);
    tui.addChild(new LinesComponent(["AFTER_CREATE_SENTINEL"]));
    activeTerminal = terminal;
    activeTui = tui;
    tui.start();
    await terminal.settle();
    expect(terminal.screenText()).toContain("Creating Goal");
    expect(terminal.screenText()).not.toContain("undefined");
    tool.markExecutionStarted();

    const staleObjectiveTail = "UNIQUE_STALE_OBJECTIVE_TAIL";
    const longObjective =
      "Obsolete objective intentionally long enough to wrap across rows in both terminal modes before " +
      staleObjectiveTail;
    tool.updateArgs({ objective: longObjective });
    tui.requestRender();
    await terminal.settle();
    expect(terminal.screenText()).toContain(staleObjectiveTail);
    expect(terminal.screenText()).toContain("Creating Goal");

    const safeObjective = "Safe objective \u001b]2;GOAL_CONTROL\u0007";
    tool.updateArgs({ objective: safeObjective });
    tui.requestRender();
    await terminal.settle();
    expect(terminal.screenText()).toContain("Safe objective ␛]2;GOAL_CONTROL␇");
    expect(terminal.screenText()).not.toContain(staleObjectiveTail);
    expect(terminal.rawWrites()).not.toContain("\u001b]2;GOAL_CONTROL\u0007");

    tool.setArgsComplete();
    tool.updateResult(goalResult("Obsolete result text"), true);
    tui.requestRender();
    await terminal.settle();
    const pendingResult = terminal.screenText();
    expect(pendingResult).toContain("Creating Goal");
    expect(pendingResult).not.toContain("Created Goal");
    expect(pendingResult).toContain("active: Obsolete result text");
    expect(pendingResult).not.toContain("Delivered objective");

    tool.updateResult(goalResult("Delivered objective"), false);
    tui.requestRender();
    await terminal.settle();
    const completed = terminal.screenText();
    expect(completed).toContain("Created Goal");
    expect(completed).not.toContain("Creating Goal");
    expect(completed).toContain("active: Delivered objective (125K tok, 2m)");
    expect(completed).not.toContain("Obsolete objective");
    expect(completed).not.toContain("Obsolete result text");
    expect(completed).not.toContain(staleObjectiveTail);
    expect(completed).not.toContain('"goal":');
    terminal.assertUnique(
      "Created Goal",
      "active: Delivered objective",
      "BEFORE_CREATE_SENTINEL",
      "AFTER_CREATE_SENTINEL",
    );

    terminal.resize(48, 24);
    tui.requestRender();
    await terminal.settle();
    terminal.assertGeometry();
    terminal.assertNeutralRow("BEFORE_CREATE_SENTINEL");
    terminal.assertNeutralRow("AFTER_CREATE_SENTINEL");
  });

  it("renders incomplete, pending, and successful update phases as unique blocks", async () => {
    const terminal = new VirtualTerminal(columns, 20);
    const tui = createTui(terminal);
    const tool = new ToolExecutionComponent(
      "update_goal",
      "update-goal-tui",
      {},
      undefined,
      updateGoalDefinition,
      tui,
      process.cwd(),
    );
    tui.addChild(new LinesComponent(["BEFORE_UPDATE_SENTINEL"]));
    tui.addChild(tool);
    tui.addChild(new LinesComponent(["AFTER_UPDATE_SENTINEL"]));
    activeTerminal = terminal;
    activeTui = tui;
    tui.start();
    await terminal.settle();
    expect(terminal.screenText()).toContain("Updating Goal");

    tool.markExecutionStarted();
    tool.updateArgs({ status: "complete" });
    tui.requestRender();
    await terminal.settle();
    expect(terminal.screenText()).toContain("Completing Goal");

    tool.setArgsComplete();
    tool.updateResult(goalResult("Finishing objective", "complete"), true);
    tui.requestRender();
    await terminal.settle();
    const pendingResult = terminal.screenText();
    expect(pendingResult).toContain("Completing Goal");
    expect(pendingResult).not.toContain("Completed Goal");
    expect(pendingResult).toContain("complete: Finishing objective (125K tok, 2m)");
    expect(pendingResult).not.toContain("Finished objective");

    tool.updateResult(goalResult("Finished objective", "complete"), false);
    tui.requestRender();
    await terminal.settle();
    const completedResult = terminal.screenText();
    expect(completedResult).toContain("Completed Goal");
    expect(completedResult).not.toContain("Completing Goal");
    expect(completedResult).not.toContain("Finishing objective");
    terminal.assertUnique(
      "Completed Goal",
      "complete: Finished objective",
      "BEFORE_UPDATE_SENTINEL",
      "AFTER_UPDATE_SENTINEL",
    );
    terminal.assertGeometry();
    terminal.assertNeutralRow("BEFORE_UPDATE_SENTINEL");
    terminal.assertNeutralRow("AFTER_UPDATE_SENTINEL");
  });

  it("restores JSON-only results and safely falls back for errors", async () => {
    const terminal = new VirtualTerminal(columns, 24);
    const tui = createTui(terminal);
    tui.setClearOnShrink(true);
    const restored = goalResult("Restored objective");
    const restoredTool = new ToolExecutionComponent(
      "get_goal",
      "restored-get-goal-tui",
      {},
      undefined,
      getGoalDefinition,
      tui,
      process.cwd(),
    );
    restoredTool.updateResult({ content: restored.content, isError: false });

    const failedTool = new ToolExecutionComponent(
      "update_goal",
      "failed-update-goal-tui",
      { status: "blocked" },
      undefined,
      updateGoalDefinition,
      tui,
      process.cwd(),
    );
    failedTool.setArgsComplete();
    failedTool.updateResult({
      content: [{ type: "text", text: "Goal unavailable \u001b]2;ERROR_CONTROL\u0007" }],
      isError: true,
    });

    tui.addChild(new LinesComponent(["BEFORE_RESTORE_SENTINEL"]));
    tui.addChild(restoredTool);
    tui.addChild(failedTool);
    tui.addChild(new LinesComponent(["AFTER_RESTORE_SENTINEL"]));
    activeTerminal = terminal;
    activeTui = tui;
    tui.start();
    await terminal.settle();
    const screen = terminal.screenText();
    expect(screen).toContain("Checked Goal");
    expect(screen).toContain("active: Restored objective (125K tok, 2m)");
    expect(screen).toContain("Goal unavailable ␛]2;ERROR_CONTROL␇");
    expect(screen).not.toContain('"goal":');
    expect(terminal.rawWrites()).not.toContain("\u001b]2;ERROR_CONTROL\u0007");
    terminal.assertUnique(
      "Checked Goal",
      "active: Restored objective",
      "Goal unavailable",
      "BEFORE_RESTORE_SENTINEL",
      "AFTER_RESTORE_SENTINEL",
    );
    terminal.assertGeometry();
    terminal.assertNeutralRow("BEFORE_RESTORE_SENTINEL");
    terminal.assertNeutralRow("AFTER_RESTORE_SENTINEL");
  });
});
