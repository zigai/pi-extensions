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

type ExplorationGroup = {
    readonly ownerToolCallId: string;
    readonly actionsByToolCallId: Map<string, string>;
    readonly orderedToolCallIds: string[];
    ownerInvalidate: (() => void) | undefined;
};

export class ExplorationGroupStore {
    private activeGroup: ExplorationGroup | undefined;
    private readonly groupsByToolCallId = new Map<string, ExplorationGroup>();

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
            return this.decisionFor(context.toolCallId, existingGroup);
        }

        const group = this.activeGroup ?? this.createGroup(context);
        this.groupsByToolCallId.set(context.toolCallId, group);
        const actionChanged = this.updateAction(group, context.toolCallId, action);

        if (actionChanged && group.ownerToolCallId !== context.toolCallId) {
            group.ownerInvalidate?.();
        }

        return this.decisionFor(context.toolCallId, group);
    }

    closeActiveGroup(): void {
        this.activeGroup = undefined;
    }

    clear(): void {
        this.activeGroup = undefined;
        this.groupsByToolCallId.clear();
    }

    private createGroup(context: ExplorationRenderContext): ExplorationGroup {
        const group: ExplorationGroup = {
            ownerToolCallId: context.toolCallId,
            actionsByToolCallId: new Map(),
            orderedToolCallIds: [],
            ownerInvalidate: context.invalidate,
        };
        this.activeGroup = group;
        return group;
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
