import type { ToolExecutionInstance } from "./context.ts";

export type ExplorationRenderContext = {
    readonly toolCallId: string;
    readonly invalidate: () => void;
    readonly isPartial?: boolean;
    readonly argsComplete?: boolean;
};

export type ExplorationGroupDecision =
    | {
          readonly kind: "owner";
          readonly actions: ReadonlyArray<string>;
          readonly active: boolean;
      }
    | {
          readonly kind: "child";
      };

const DEFAULT_MAX_RETAINED_TOOL_CALLS = 300;

type ExplorationGroup = {
    readonly ownerToolCallId: string;
    readonly actionsByToolCallId: Map<string, string>;
    readonly activeByToolCallId: Map<string, boolean>;
    readonly orderedToolCallIds: string[];
    ownerInvalidate: (() => void) | undefined;
};

/** Transcript entry and content offsets; stable until the session branch is reset. */
export type ExplorationSourcePosition = readonly [entry: number, content: number];

export type ExplorationGroupStoreStats = {
    readonly groups: number;
    readonly toolCalls: number;
    readonly pendingBoundaries: number;
};

export class ExplorationGroupStore {
    private activeGroup: ExplorationGroup | undefined;
    private readonly groupsByToolCallId = new Map<string, ExplorationGroup>();
    private readonly groupsInInsertionOrder: ExplorationGroup[] = [];
    private observedRows = new WeakSet<ToolExecutionInstance>();
    private readonly pendingBoundaries = new Map<string, "event" | "row">();
    private latestSourcePosition: ExplorationSourcePosition | undefined;
    private readonly groupStartToolCallIds = new Set<string>();
    private readonly maxRetainedToolCalls: number;

    constructor(
        maxRetainedToolCalls = DEFAULT_MAX_RETAINED_TOOL_CALLS,
        private readonly sourcePosition?: (
            toolCallId: string,
        ) => ExplorationSourcePosition | undefined,
    ) {
        this.maxRetainedToolCalls = Math.max(1, Math.floor(maxRetainedToolCalls));
    }

    register(context: ExplorationRenderContext, action: string): ExplorationGroupDecision {
        const existingGroup = this.groupsByToolCallId.get(context.toolCallId);
        if (existingGroup) {
            if (existingGroup.ownerToolCallId === context.toolCallId) {
                existingGroup.ownerInvalidate = context.invalidate;
            }

            const entryChanged = this.updateEntry(existingGroup, context, action);
            if (entryChanged && existingGroup.ownerToolCallId !== context.toolCallId) {
                existingGroup.ownerInvalidate?.();
            }

            this.trimRetainedGroups();

            return this.decisionFor(context.toolCallId, existingGroup);
        }

        this.advanceSourcePosition(context.toolCallId);

        if (this.groupStartToolCallIds.has(context.toolCallId)) {
            this.closeActiveGroup();
        }

        const group = this.activeGroup ?? this.createGroup(context);
        this.groupsByToolCallId.set(context.toolCallId, group);

        const entryChanged = this.updateEntry(group, context, action);
        if (entryChanged && group.ownerToolCallId !== context.toolCallId) {
            group.ownerInvalidate?.();
        }

        this.trimRetainedGroups();

        return this.decisionFor(context.toolCallId, group);
    }

    closeActiveGroup(): void {
        if (this.activeGroup !== undefined) {
            this.activeGroup.ownerInvalidate = undefined;
        }

        this.activeGroup = undefined;
    }

    /** Observe every row when its arguments or result become ready, including generic and preserved external rows. */
    observeRow(row: ToolExecutionInstance, toolCallId: string, exploration: boolean): void {
        if (this.observedRows.has(row)) return;

        this.observedRows.add(row);

        if (exploration) {
            this.advanceSourcePosition(toolCallId);
            return;
        }

        this.observeBoundary(toolCallId, "row");
    }

    /** The execution-start event is the sole live boundary event source. */
    registerBoundary(toolCallId: string): void {
        this.observeBoundary(toolCallId, "event");
    }

    private observeBoundary(toolCallId: string, source: "row" | "event"): void {
        const pending = this.pendingBoundaries.get(toolCallId);
        if (pending !== undefined) {
            if (pending !== source) {
                this.pendingBoundaries.delete(toolCallId);
            }

            return;
        }

        // Source order is authoritative even after >maxRetainedToolCalls unmatched
        // events/rows. In particular, a historical row first observed late must not
        // close a newer live group. Row identity alone cannot establish that fact.
        const advanced = this.advanceSourcePosition(toolCallId);
        if (advanced === false) return;

        if (advanced === undefined) {
            // Detached/synthetic rows may have no transcript source yet. This is only
            // a bounded handoff, not a permanent second index of the session's IDs.
            this.pendingBoundaries.set(toolCallId, source);

            while (this.pendingBoundaries.size > this.maxRetainedToolCalls) {
                const oldest = this.pendingBoundaries.keys().next();
                if (oldest.done === true) break;

                this.pendingBoundaries.delete(oldest.value);
            }
        }

        this.closeActiveGroup();
    }

    private advanceSourcePosition(toolCallId: string): boolean | undefined {
        const position = this.sourcePosition?.(toolCallId);
        if (position === undefined) return undefined;

        const latest = this.latestSourcePosition;
        if (
            latest !== undefined &&
            (position[0] < latest[0] || (position[0] === latest[0] && position[1] <= latest[1]))
        )
            return false;

        this.latestSourcePosition = position;
        return true;
    }

    /** Marks the first exploration call in a historical assistant tool-call run. */
    registerGroupStart(toolCallId: string): void {
        this.groupStartToolCallIds.add(toolCallId);

        while (this.groupStartToolCallIds.size > this.maxRetainedToolCalls) {
            const oldest = this.groupStartToolCallIds.values().next();
            if (oldest.done === true) break;

            this.groupStartToolCallIds.delete(oldest.value);
        }
    }

    clear(): void {
        this.activeGroup = undefined;
        this.groupsByToolCallId.clear();
        this.groupsInInsertionOrder.length = 0;
        this.observedRows = new WeakSet<ToolExecutionInstance>();
        this.pendingBoundaries.clear();
        this.latestSourcePosition = undefined;
        this.groupStartToolCallIds.clear();
    }

    stats(): ExplorationGroupStoreStats {
        return {
            groups: this.groupsInInsertionOrder.length,
            toolCalls: this.groupsByToolCallId.size,
            pendingBoundaries: this.pendingBoundaries.size,
        };
    }

    private createGroup(context: ExplorationRenderContext): ExplorationGroup {
        const group: ExplorationGroup = {
            ownerToolCallId: context.toolCallId,
            actionsByToolCallId: new Map(),
            activeByToolCallId: new Map(),
            orderedToolCallIds: [],
            ownerInvalidate: context.invalidate,
        };
        this.activeGroup = group;
        this.groupsInInsertionOrder.push(group);

        return group;
    }

    private trimRetainedGroups(): void {
        while (this.groupsByToolCallId.size > this.maxRetainedToolCalls) {
            const evictedGroup = this.groupsInInsertionOrder.find(
                (group) => group !== this.activeGroup,
            );
            if (evictedGroup === undefined) {
                return;
            }

            this.evictGroup(evictedGroup);
        }
    }

    private evictGroup(group: ExplorationGroup): void {
        group.ownerInvalidate = undefined;

        for (const toolCallId of group.actionsByToolCallId.keys()) {
            this.groupsByToolCallId.delete(toolCallId);
        }

        const groupIndex = this.groupsInInsertionOrder.indexOf(group);
        if (groupIndex >= 0) {
            this.groupsInInsertionOrder.splice(groupIndex, 1);
        }
    }

    private updateEntry(
        group: ExplorationGroup,
        context: ExplorationRenderContext,
        action: string,
    ): boolean {
        const previousAction = group.actionsByToolCallId.get(context.toolCallId);
        const active = context.isPartial === true || context.argsComplete === false;
        const previousActive = group.activeByToolCallId.get(context.toolCallId);
        if (previousAction === action && previousActive === active) {
            return false;
        }

        if (previousAction === undefined) {
            group.orderedToolCallIds.push(context.toolCallId);
        }

        group.actionsByToolCallId.set(context.toolCallId, action);
        group.activeByToolCallId.set(context.toolCallId, active);

        return true;
    }

    private decisionFor(toolCallId: string, group: ExplorationGroup): ExplorationGroupDecision {
        if (group.ownerToolCallId !== toolCallId) {
            return { kind: "child" };
        }

        const actions = group.orderedToolCallIds.flatMap((orderedToolCallId) => {
            const action = group.actionsByToolCallId.get(orderedToolCallId);
            return action === undefined ? [] : [action];
        });

        return {
            kind: "owner",
            actions,
            active: group.orderedToolCallIds.some(
                (orderedToolCallId) => group.activeByToolCallId.get(orderedToolCallId) === true,
            ),
        };
    }
}
