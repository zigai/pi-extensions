import { TreeSelectorComponent, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { getKeybindings, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { patchTreeHeaderText, type TreeHeaderPatchTarget } from "./patch-tree-header.ts";
import { calculatePreviewLayout, getPreviewText, padToWidth } from "./preview.ts";
import {
    getPersistedMaxVisibleLines,
    getPersistedMode,
    getPersistedPreviewEnabled,
    getPersistedPreviewFullHeight,
    isTreeTimestampMode,
    persistMode,
    persistPreviewEnabled,
} from "./settings.ts";
import { formatEntryTimestamp, cycleMode, type TreeTimestampMode } from "./timestamps.ts";
import {
    setTreePreviewEnabled,
    setTreeTimestampMode,
    TREE_PREVIEW_ENABLED_KEY,
    TREE_TIMESTAMP_MODE_KEY,
    type TreeListInstance,
} from "./tree-state.ts";
import type { TreeNode } from "./tree-node.ts";

export const PATCH_KEY = Symbol.for("zigai.pi.tree-timestamps.patched");
const PREVIEW_TOGGLE_KEY = "P";
const TREE_PATCH_STATE = Symbol.for("zigai.pi-tree.patch-state");

type TreePatchState = {
    getTheme: () => TreeTheme | undefined;
    getPersistedMode: () => TreeTimestampMode;
    getPersistedPreviewEnabled: () => boolean;
    getPersistedMaxVisibleLines: () => number | null;
    getPersistedPreviewFullHeight: () => boolean;
    persistMode: (mode: TreeTimestampMode) => void;
    persistPreviewEnabled: (enabled: boolean) => void;
};

type TreePatchSettings = Omit<TreePatchState, "getTheme">;

type TreeTheme = {
    fg(role: string, text: string): string;
    bg(role: string, text: string): string;
    bold(text: string): string;
};

type TreeThemeProbe = {
    readonly fg?: unknown;
    readonly bg?: unknown;
    readonly bold?: unknown;
};

type TreeListPrototype = {
    getEntryDisplayText?: NonNullable<TreeListInstance["getEntryDisplayText"]>;
    getStatusLabels: NonNullable<TreeListInstance["getStatusLabels"]>;
    handleInput: NonNullable<TreeListInstance["handleInput"]>;
    render?: (width: number) => string[];
};

type TreeSelectorConstructor = new (
    entries: SessionTreeNode[],
    selectedId: string | null,
    height: number,
    onSelect: () => undefined,
    onCancel: () => undefined,
    onLabel: () => undefined,
    initialSelectedId: undefined,
    initialFilterMode: undefined,
) => object;

type TreeSelectorInstance = InstanceType<TreeSelectorConstructor>;

// oxlint-disable-next-line antislop/no-unknown-returns -- Pi's private method is untyped; every returned value is validated before use.
type UntrustedGetTreeList = (this: TreeSelectorInstance) => unknown;

type TreeSelectorPrototype = {
    addChild?: TreeHeaderPatchTarget["addChild"];
    getTreeList: UntrustedGetTreeList;
};

type PatchTreeSelectorOptions = {
    readonly treeSelectorComponent?: TreeSelectorConstructor;
    readonly theme: () => TreeTheme | undefined;
    readonly patchTreeHeaderText?: (prototype: TreeHeaderPatchTarget) => void;
    readonly settings?: TreePatchSettings;
};

function defaultTreePatchSettings(): TreePatchSettings {
    return {
        getPersistedMode,
        getPersistedPreviewEnabled,
        getPersistedMaxVisibleLines,
        getPersistedPreviewFullHeight,
        persistMode,
        persistPreviewEnabled,
    };
}

function isObjectIdentity(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

type CallableProperty<Key extends PropertyKey> = {
    [Property in Key]: (...args: never[]) => void;
};

function isCallableProperty<Value extends object, Key extends PropertyKey>(
    value: Value,
    key: Key,
): value is Value & CallableProperty<Key>;
function isCallableProperty<Value extends object, Key extends PropertyKey>(
    value: Value,
    key: Key,
    allowAbsent: true,
): value is Value & Partial<CallableProperty<Key>>;
function isCallableProperty<Value extends object, Key extends PropertyKey>(
    value: Value,
    key: Key,
    allowAbsent = false,
): value is Value & Partial<CallableProperty<Key>> {
    let owner: object = value;

    for (;;) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor !== undefined) return typeof descriptor.value === "function";

        const parent: unknown = Object.getPrototypeOf(owner);
        if (!isObjectIdentity(parent)) return allowAbsent;

        owner = parent;
    }
}

function isTreeTheme(value: unknown): value is TreeTheme {
    if (!isObjectIdentity(value)) return false;

    // SAFETY: Pi's theme is a Proxy whose methods are intentionally absent from `in` and
    // own-property checks. Reading only these three unknown properties is the observable seam.
    const theme = value as TreeThemeProbe;
    try {
        return (
            typeof theme.fg === "function" &&
            typeof theme.bg === "function" &&
            typeof theme.bold === "function"
        );
    } catch {
        // Pi's lazy proxy throws before its theme controller initializes it.
        return false;
    }
}

function isTreeSelectorPrototype(value: unknown): value is TreeSelectorPrototype {
    if (!isObjectIdentity(value)) return false;
    return isCallableProperty(value, "getTreeList");
}

function isTreeHeaderPatchTarget(
    value: TreeSelectorPrototype,
): value is TreeSelectorPrototype & TreeHeaderPatchTarget {
    return isCallableProperty(value, "addChild");
}

function isTreeListPrototype(value: unknown): value is TreeListPrototype {
    if (!isObjectIdentity(value)) return false;
    return (
        isCallableProperty(value, "handleInput") &&
        isCallableProperty(value, "getStatusLabels") &&
        isCallableProperty(value, "getEntryDisplayText", true) &&
        isCallableProperty(value, "render", true)
    );
}

function isTreePatchState(value: unknown): value is TreePatchState {
    if (!isObjectIdentity(value)) return false;
    return (
        isCallableProperty(value, "getTheme") &&
        isCallableProperty(value, "getPersistedMode") &&
        isCallableProperty(value, "getPersistedPreviewEnabled") &&
        isCallableProperty(value, "getPersistedMaxVisibleLines") &&
        isCallableProperty(value, "getPersistedPreviewFullHeight") &&
        isCallableProperty(value, "persistMode") &&
        isCallableProperty(value, "persistPreviewEnabled")
    );
}

function setTreePatchState(settings: TreePatchState): TreePatchState {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, TREE_PATCH_STATE);
    if (descriptor !== undefined && isTreePatchState(descriptor.value)) {
        const existing = descriptor.value;
        Object.assign(existing, settings);
        return existing;
    }

    const patchState: TreePatchState = { ...settings };
    Object.defineProperty(globalThis, TREE_PATCH_STATE, {
        configurable: true,
        value: patchState,
        writable: true,
    });

    return patchState;
}

function applyConfiguredMaxVisibleLinesFromState(
    treeList: TreeListInstance,
    patchState: TreePatchState,
): void {
    const configured = patchState.getPersistedMaxVisibleLines();
    if (configured === null) {
        return;
    }

    treeList.maxVisibleLines = configured;
}

function getTreeTimestampModeFromState(
    treeList: TreeListInstance,
    patchState: TreePatchState,
): TreeTimestampMode {
    const current = treeList[TREE_TIMESTAMP_MODE_KEY];
    if (isTreeTimestampMode(current)) {
        treeList.showLabelTimestamps = false;
        return current;
    }

    const initialMode = patchState.getPersistedMode();
    setTreeTimestampMode(treeList, initialMode);

    return initialMode;
}

function getTreePreviewEnabledFromState(
    treeList: TreeListInstance,
    patchState: TreePatchState,
): boolean {
    const current = treeList[TREE_PREVIEW_ENABLED_KEY];
    if (current !== undefined) {
        return current;
    }

    const initialEnabled = patchState.getPersistedPreviewEnabled();
    setTreePreviewEnabled(treeList, initialEnabled);

    return initialEnabled;
}

export async function patchTreeSelector(options: PatchTreeSelectorOptions): Promise<void> {
    const patchState = setTreePatchState({
        ...(options.settings ?? defaultTreePatchSettings()),
        getTheme: options.theme,
    });
    const patchHeaderText = options.patchTreeHeaderText ?? patchTreeHeaderText;
    const SelectorComponent = options.treeSelectorComponent ?? TreeSelectorComponent;

    if (!isTreeTheme(patchState.getTheme())) return;

    if (Object.getOwnPropertyDescriptor(globalThis, PATCH_KEY)?.value === true) return;

    const selector = new SelectorComponent(
        [],
        null,
        24,
        () => undefined,
        () => undefined,
        () => undefined,
        undefined,
        undefined,
    );
    const selectorPrototypeValue: unknown = Object.getPrototypeOf(selector);
    if (!isTreeSelectorPrototype(selectorPrototypeValue)) return;

    const selectorPrototype = selectorPrototypeValue;
    const originalGetTreeList = selectorPrototype.getTreeList;
    const treeListValue = originalGetTreeList.call(selector);
    if (!isObjectIdentity(treeListValue)) return;

    const treeListPrototypeValue: unknown = Object.getPrototypeOf(treeListValue);
    if (!isTreeListPrototype(treeListPrototypeValue)) return;

    const treeListPrototype = treeListPrototypeValue;

    if (isTreeHeaderPatchTarget(selectorPrototype)) {
        patchHeaderText(selectorPrototype);
    }

    selectorPrototype.getTreeList = function patchedGetTreeList(this: TreeSelectorInstance) {
        const treeListInstance = originalGetTreeList.call(this);
        const configured = patchState.getPersistedMaxVisibleLines();
        if (configured !== null && isObjectIdentity(treeListInstance)) {
            Object.assign(treeListInstance, { maxVisibleLines: configured });
        }

        return treeListInstance;
    };

    const originalHandleInput = treeListPrototype.handleInput;
    const originalGetStatusLabels = treeListPrototype.getStatusLabels;
    const originalGetEntryDisplayText = treeListPrototype.getEntryDisplayText;
    const originalRender = treeListPrototype.render;

    treeListPrototype.handleInput = function patchedHandleInput(
        this: TreeListInstance,
        keyData: string,
    ) {
        applyConfiguredMaxVisibleLinesFromState(this, patchState);

        const kb = getKeybindings();
        if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
            const nextMode = cycleMode(getTreeTimestampModeFromState(this, patchState));
            setTreeTimestampMode(this, nextMode);
            patchState.persistMode(nextMode);
            return;
        }

        if (keyData === PREVIEW_TOGGLE_KEY) {
            const nextEnabled = !getTreePreviewEnabledFromState(this, patchState);
            setTreePreviewEnabled(this, nextEnabled);
            patchState.persistPreviewEnabled(nextEnabled);
            return;
        }

        return originalHandleInput.call(this, keyData);
    };

    treeListPrototype.getStatusLabels = function patchedGetStatusLabels(
        this: TreeListInstance,
    ): string {
        const currentMode = getTreeTimestampModeFromState(this, patchState);
        const originalLabelTimestampFlag = this.showLabelTimestamps;
        this.showLabelTimestamps = false;

        const nativeLabels = originalGetStatusLabels.call(this);

        this.showLabelTimestamps = originalLabelTimestampFlag;

        const filterLabelByStatus = new Map<string, string>([
            ["[no-tools]", "No Tools"],
            ["[user]", "User"],
            ["[labeled]", "Labeled"],
            ["[all]", "All"],
        ]);

        let filterLabel = "Default";
        for (const [statusLabel, label] of filterLabelByStatus) {
            if (nativeLabels.includes(statusLabel)) {
                filterLabel = label;
                break;
            }
        }

        const timeLabelByMode = {
            off: "Off",
            relative: "Relative",
            absolute: "Absolute",
        } satisfies Record<TreeTimestampMode, string>;
        let previewLabel = "Off";
        if (getTreePreviewEnabledFromState(this, patchState)) {
            previewLabel = "On";
        }

        return `  Filter: ${filterLabel} | Time: ${timeLabelByMode[currentMode]} | Preview: ${previewLabel}`;
    };

    if (typeof originalRender === "function") {
        treeListPrototype.render = function patchedRender(
            this: TreeListInstance,
            width: number,
        ): string[] {
            const layout = calculatePreviewLayout(width);
            applyConfiguredMaxVisibleLinesFromState(this, patchState);

            if (!getTreePreviewEnabledFromState(this, patchState) || layout === null) {
                return originalRender.call(this, width);
            }

            const filteredNodes = this.filteredNodes ?? [];
            if (filteredNodes.length === 0) {
                return originalRender.call(this, width);
            }

            const candidateTheme = patchState.getTheme();
            if (!isTreeTheme(candidateTheme)) return originalRender.call(this, width);

            const theme = candidateTheme;
            const selectedIndex = this.selectedIndex ?? 0;
            const maxVisibleLines = this.maxVisibleLines ?? filteredNodes.length;
            const startIndex = Math.max(
                0,
                Math.min(
                    selectedIndex - Math.floor(maxVisibleLines / 2),
                    filteredNodes.length - maxVisibleLines,
                ),
            );
            const endIndex = Math.min(startIndex + maxVisibleLines, filteredNodes.length);
            const selectedNode = filteredNodes[selectedIndex]?.node;
            const previewText = theme.fg("muted", getPreviewText(selectedNode));
            const previewLines = wrapTextWithAnsi(previewText, layout.rightWidth);
            const lines: string[] = [];
            const treeRowCount = Math.max(0, endIndex - startIndex);
            let rowCount = maxVisibleLines;
            if (!patchState.getPersistedPreviewFullHeight()) {
                rowCount = Math.max(treeRowCount, Math.min(maxVisibleLines, previewLines.length));
            }

            for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
                const index = startIndex + rowIndex;
                const flatNode = filteredNodes.at(index);
                let leftLine = "";

                if (flatNode !== undefined) {
                    const entry = flatNode.node.entry;
                    const isSelected = index === selectedIndex;
                    let cursor = "  ";
                    if (isSelected) {
                        cursor = theme.fg("accent", "› ");
                    }

                    let displayIndent = flatNode.indent;
                    if (this.multipleRoots === true) {
                        displayIndent = Math.max(0, flatNode.indent - 1);
                    }

                    let connector = "";
                    if (flatNode.showConnector && !flatNode.isVirtualRootChild) {
                        connector = "├─ ";
                        if (flatNode.isLast) {
                            connector = "└─ ";
                        }
                    }

                    let connectorPosition = -1;
                    if (connector.length > 0) {
                        connectorPosition = displayIndent - 1;
                    }

                    const totalChars = displayIndent * 3;
                    const prefixChars: string[] = [];
                    const isFolded = this.foldedNodes?.has(entry.id) === true;

                    for (let charIndex = 0; charIndex < totalChars; charIndex += 1) {
                        const level = Math.floor(charIndex / 3);
                        const posInLevel = charIndex % 3;
                        const gutter = flatNode.gutters.find((item) => item.position === level);
                        if (gutter !== undefined) {
                            let gutterChar = " ";
                            if (posInLevel === 0 && gutter.show) {
                                gutterChar = "│";
                            }

                            prefixChars.push(gutterChar);
                        } else if (connector.length > 0 && level === connectorPosition) {
                            if (posInLevel === 0) {
                                let connectorChar = "├";
                                if (flatNode.isLast) {
                                    connectorChar = "└";
                                }

                                prefixChars.push(connectorChar);
                            } else if (posInLevel === 1) {
                                const foldable = this.isFoldable?.(entry.id) === true;
                                let foldChar = "─";
                                if (foldable) {
                                    foldChar = "⊟";
                                }

                                if (isFolded) {
                                    foldChar = "⊞";
                                }

                                prefixChars.push(foldChar);
                            } else {
                                prefixChars.push(" ");
                            }
                        } else {
                            prefixChars.push(" ");
                        }
                    }

                    const prefix = prefixChars.join("");
                    const showsFoldInConnector =
                        flatNode.showConnector && !flatNode.isVirtualRootChild;
                    let foldMarker = "";
                    if (isFolded && !showsFoldInConnector) {
                        foldMarker = theme.fg("accent", "⊞ ");
                    }

                    const isOnActivePath = this.activePathIds?.has(entry.id) === true;
                    let pathMarker = "";
                    if (isOnActivePath) {
                        pathMarker = theme.fg("accent", "• ");
                    }

                    let label = "";
                    if (flatNode.node.label !== undefined && flatNode.node.label.length > 0) {
                        label = theme.fg("warning", `[${flatNode.node.label}] `);
                    }

                    let labelTimestamp = "";
                    if (
                        this.showLabelTimestamps === true &&
                        flatNode.node.label !== undefined &&
                        flatNode.node.labelTimestamp !== undefined
                    ) {
                        labelTimestamp = theme.fg(
                            "muted",
                            `${this.formatLabelTimestamp?.(flatNode.node.labelTimestamp) ?? ""} `,
                        );
                    }

                    const content = this.getEntryDisplayText?.(flatNode.node, isSelected) ?? "";
                    leftLine =
                        cursor +
                        theme.fg("dim", prefix) +
                        foldMarker +
                        pathMarker +
                        label +
                        labelTimestamp +
                        content;
                    leftLine = padToWidth(leftLine, layout.leftWidth);
                    if (isSelected) {
                        leftLine = theme.bg("selectedBg", leftLine);
                    }
                } else {
                    leftLine = padToWidth("", layout.leftWidth);
                }

                const previewLine = truncateToWidth(
                    previewLines[rowIndex] ?? "",
                    layout.rightWidth,
                );
                lines.push(
                    `${leftLine}${theme.fg("dim", " │ ")}${padToWidth(previewLine, layout.rightWidth)}`,
                );
            }

            const status = theme.fg(
                "muted",
                `  (${selectedIndex + 1}/${filteredNodes.length})${this.getStatusLabels?.() ?? ""}`,
            );
            lines.push(truncateToWidth(status, width));

            return lines;
        };
    }

    if (typeof originalGetEntryDisplayText === "function") {
        treeListPrototype.getEntryDisplayText = function patchedGetEntryDisplayText(
            this: TreeListInstance,
            node: TreeNode,
            isSelected: boolean,
        ): string {
            const content = originalGetEntryDisplayText.call(this, node, isSelected);
            const currentMode = getTreeTimestampModeFromState(this, patchState);
            if (currentMode === "off") return content;

            const formatted = formatEntryTimestamp(node.entry.timestamp, currentMode);
            if (formatted.length === 0) return content;

            const candidateTheme = patchState.getTheme();
            if (!isTreeTheme(candidateTheme)) return content;

            const theme = candidateTheme;
            const prefix = theme.fg("muted", `${formatted} `);
            let renderedPrefix = prefix;
            if (isSelected) {
                renderedPrefix = theme.bold(prefix);
            }

            return renderedPrefix + content;
        };
    }

    Reflect.set(globalThis, PATCH_KEY, true);
}
