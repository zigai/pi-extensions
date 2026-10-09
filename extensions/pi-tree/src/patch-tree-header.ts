import { keyText } from "@earendil-works/pi-coding-agent";

const TREE_TITLE_PATCH_KEY = Symbol.for("zigai.pi.tree-timestamps.title-patched");
const PREVIEW_TOGGLE_HINT = "shift+p";
const TREE_TITLE_TEXT = "  Session Tree";
const LEGACY_TREE_HELP_TEXT = "↑/↓: move.";

type ComponentLike = {
    text?: unknown;
    invalidate(): void;
    render(width: number): string[];
};

type AddChild = (this: TreeHeaderPatchTarget, component: ComponentLike) => void;

export type TreeHeaderPatchTarget = {
    addChild: AddChild;
};

type TreeHeaderPatchRecord = {
    readonly originalAddChild: AddChild;
    readonly patchedAddChild: AddChild;
    readonly prototype: TreeHeaderPatchTarget;
};

function isAddChild(value: unknown): value is AddChild {
    return typeof value === "function";
}

function isTreeHeaderPatchTargetValue(value: unknown): value is TreeHeaderPatchTarget {
    if (typeof value !== "object" || value === null) return false;
    return isAddChild(Object.getOwnPropertyDescriptor(value, "addChild")?.value);
}

function isTreeHeaderPatchRecord(value: unknown): value is TreeHeaderPatchRecord {
    if (typeof value !== "object" || value === null) return false;
    return (
        isAddChild(Object.getOwnPropertyDescriptor(value, "originalAddChild")?.value) &&
        isAddChild(Object.getOwnPropertyDescriptor(value, "patchedAddChild")?.value) &&
        isTreeHeaderPatchTargetValue(Object.getOwnPropertyDescriptor(value, "prototype")?.value)
    );
}

function getTreeHeaderPatch(): TreeHeaderPatchRecord | true | undefined {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, TREE_TITLE_PATCH_KEY);
    if (descriptor === undefined) return undefined;
    if (descriptor.value === true) return true;
    if (isTreeHeaderPatchRecord(descriptor.value)) return descriptor.value;
    return undefined;
}

function setTreeHeaderPatch(value: TreeHeaderPatchRecord | undefined): void {
    if (value === undefined) {
        Reflect.deleteProperty(globalThis, TREE_TITLE_PATCH_KEY);
        return;
    }

    Object.defineProperty(globalThis, TREE_TITLE_PATCH_KEY, {
        configurable: true,
        value,
        writable: true,
    });
}

function formatTreeHelpKey(key: string): string {
    return key
        .replaceAll("ctrl+left/alt+left", "ctrl/alt+←")
        .replaceAll("ctrl+right/alt+right", "ctrl/alt+→")
        .replaceAll("left", "←")
        .replaceAll("right", "→")
        .replaceAll("up", "↑")
        .replaceAll("down", "↓");
}

function treeHelpKey(keybinding: Parameters<typeof keyText>[0]): string {
    return formatTreeHelpKey(keyText(keybinding));
}

function getTreeHelpText(): string {
    return [
        "↑/↓: move",
        "←/→: page",
        `${treeHelpKey("app.tree.foldOrUp")}: fold/up`,
        `${treeHelpKey("app.tree.unfoldOrDown")}: unfold/down`,
        `${treeHelpKey("app.tree.editLabel")}: label`,
        `${treeHelpKey("app.tree.filter.cycleForward")}: filter`,
        `${treeHelpKey("app.tree.toggleLabelTimestamp")}: time`,
        `${PREVIEW_TOGGLE_HINT}: preview`,
    ].join("  •  ");
}

function hasText(component: ComponentLike): component is ComponentLike & { text: string } {
    return typeof component.text === "string";
}

function componentText(component: ComponentLike): string | undefined {
    if (!hasText(component)) return undefined;
    return component.text;
}

function isTreeTitle(component: ComponentLike): boolean {
    return componentText(component)?.includes(TREE_TITLE_TEXT) === true;
}

function updateLegacyTreeHelp(component: ComponentLike): void {
    if (!hasText(component) || !component.text.includes(LEGACY_TREE_HELP_TEXT)) return;

    component.text = `  ${getTreeHelpText()}`;
}

/** Patches only TreeSelectorComponent children, leaving global Text rendering untouched. */
export function patchTreeHeaderText(prototype: TreeHeaderPatchTarget): void {
    if (getTreeHeaderPatch() !== undefined) return;

    const originalAddChild = prototype.addChild;
    const patchedAddChild: AddChild = function patchedTreeSelectorAddChild(component): void {
        if (isTreeTitle(component)) return;

        updateLegacyTreeHelp(component);
        originalAddChild.call(this, component);
    };

    prototype.addChild = patchedAddChild;
    setTreeHeaderPatch({ originalAddChild, patchedAddChild, prototype });
}

/** Restores the TreeSelectorComponent child renderer when the extension unloads. */
export function restoreTreeHeaderText(): void {
    const patch = getTreeHeaderPatch();
    if (patch === undefined || patch === true) return;

    if (patch.prototype.addChild === patch.patchedAddChild) {
        patch.prototype.addChild = patch.originalAddChild;
    }

    setTreeHeaderPatch(undefined);
}
