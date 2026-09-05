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

export type ExplorationGroupStoreStats = {
    readonly groups: number;
    readonly toolCalls: number;
};

export class ExplorationGroupStore {
    private activeGroup: ExplorationGroup | undefined;
    private readonly groupsByToolCallId = new Map<string, ExplorationGroup>();
    private readonly groupsInInsertionOrder: ExplorationGroup[] = [];
    private readonly boundaryToolCallIds = new Set<string>();
    private readonly groupStartToolCallIds = new Set<string>();
    private readonly maxRetainedToolCalls: number;

    constructor(maxRetainedToolCalls = DEFAULT_MAX_RETAINED_TOOL_CALLS) {
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

    /**
     * Closes the active group the first time a non-exploration tool call is observed.
     *
     * Tool components are rendered repeatedly as Pi redraws the transcript. Remembering
     * the boundary by call ID prevents an older component from closing a newer group on
     * every repaint.
     */
    registerBoundary(toolCallId: string): void {
        if (this.boundaryToolCallIds.has(toolCallId)) {
            return;
        }
        this.boundaryToolCallIds.add(toolCallId);
        this.closeActiveGroup();
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
        this.boundaryToolCallIds.clear();
        this.groupStartToolCallIds.clear();
    }

    stats(): ExplorationGroupStoreStats {
        return {
            groups: this.groupsInInsertionOrder.length,
            toolCalls: this.groupsByToolCallId.size,
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
        while (this.retainedToolCallCount() > this.maxRetainedToolCalls) {
            const evictedGroup = this.groupsInInsertionOrder.find(
                (group) => group !== this.activeGroup,
            );
            if (evictedGroup === undefined) {
                return;
            }
            this.evictGroup(evictedGroup);
        }
    }

    private retainedToolCallCount(): number {
        let retainedToolCalls = 0;
        for (const group of this.groupsInInsertionOrder) {
            retainedToolCalls += group.actionsByToolCallId.size;
        }
        return retainedToolCalls;
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
