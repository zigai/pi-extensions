export type ExplorationRenderContext = {
    readonly toolCallId: string;
    readonly invalidate: () => void;
};

export type ExplorationGroupDecision =
    | {
          readonly kind: "owner";
          readonly actions: ReadonlyArray<string>;
      }
    | {
          readonly kind: "child";
      };

const DEFAULT_MAX_RETAINED_TOOL_CALLS = 300;

type ExplorationGroup = {
    readonly ownerToolCallId: string;
    readonly actionsByToolCallId: Map<string, string>;
    readonly orderedToolCallIds: string[];
    ownerInvalidate: (() => void) | undefined;
};

export class ExplorationGroupStore {
    private activeGroup: ExplorationGroup | undefined;
    private readonly groupsByToolCallId = new Map<string, ExplorationGroup>();
    private readonly groupsInInsertionOrder: ExplorationGroup[] = [];
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
            const actionChanged = this.updateAction(existingGroup, context.toolCallId, action);
            if (actionChanged && existingGroup.ownerToolCallId !== context.toolCallId) {
                existingGroup.ownerInvalidate?.();
            }
            this.trimRetainedGroups();
            return this.decisionFor(context.toolCallId, existingGroup);
        }

        const group = this.activeGroup ?? this.createGroup(context);
        this.groupsByToolCallId.set(context.toolCallId, group);
        const actionChanged = this.updateAction(group, context.toolCallId, action);

        if (actionChanged && group.ownerToolCallId !== context.toolCallId) {
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

    clear(): void {
        this.activeGroup = undefined;
        this.groupsByToolCallId.clear();
        this.groupsInInsertionOrder.length = 0;
    }

    private createGroup(context: ExplorationRenderContext): ExplorationGroup {
        const group: ExplorationGroup = {
            ownerToolCallId: context.toolCallId,
            actionsByToolCallId: new Map(),
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

    private updateAction(group: ExplorationGroup, toolCallId: string, action: string): boolean {
        const previousAction = group.actionsByToolCallId.get(toolCallId);
        if (previousAction === action) {
            return false;
        }

        if (previousAction === undefined) {
            group.orderedToolCallIds.push(toolCallId);
        }
        group.actionsByToolCallId.set(toolCallId, action);
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
        return { kind: "owner", actions };
    }
}
