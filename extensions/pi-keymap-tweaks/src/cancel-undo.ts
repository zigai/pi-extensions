import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
    AgentSession,
    CustomEditor,
    InteractiveMode,
    type SessionEntry,
    type SessionHeader,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { installKeyedLinkedMethodPatch } from "@zigai/pi-extension-internals";

const EDITOR_INPUT_MARKER = Symbol.for("zigai.pi-keymap-tweaks.cancel-undo-editor-input");
const RESTORE_QUEUE_MARKER = Symbol.for("zigai.pi-keymap-tweaks.cancel-undo-restore");
const PROMPT_RECORD_MARKER = Symbol.for("zigai.pi-keymap-tweaks.cancel-undo-prompt");

type InteractiveModeView = {
    readonly session?: unknown;
    readonly compactionQueuedMessages?: unknown;
    readonly chatContainer?: unknown;
    readonly editor?: unknown;
    readonly ui?: unknown;
    readonly renderInitialMessages?: unknown;
    readonly showError?: unknown;
};

type UndoHost = {
    readonly session: AgentSession;
    readonly chatContainer: { clear(): void };
    readonly editor: { getText(): string; setText(text: string): void };
    readonly ui: { requestRender(): void };
    renderInitialMessages(): void;
    showError(message: string): void;
};

type SessionManagerView = {
    readonly persist?: unknown;
    readonly flushed?: unknown;
    readonly fileEntries?: unknown;
    readonly byId?: unknown;
    readonly labelsById?: unknown;
    readonly labelTimestampsById?: unknown;
};

type SessionFileState = {
    readonly persist: boolean;
    flushed: boolean;
    readonly fileEntries: unknown[];
    readonly byId: Map<unknown, unknown>;
    readonly labelsById: Map<unknown, unknown>;
    readonly labelTimestampsById: Map<unknown, unknown>;
};

type PromptRecord = {
    readonly text: string;
    readonly at: number;
};

type RestoreOptions = { readonly abort?: boolean } | undefined;

type FreshTurn = {
    readonly userEntry: SessionEntry;
    readonly previousConversationAt: number;
};

type RestoreHost = {
    restoreQueuedMessagesToEditor(this: RestoreHost, options?: RestoreOptions): number;
};

type InputHost = { handleInput(this: InputHost, data: string): void };
type PromptOptions = Parameters<AgentSession["prompt"]>[1];

type PromptHost = {
    prompt(this: PromptHost, text: string, options?: PromptOptions): Promise<void>;
};

export type CancelUndoHandle = {
    update(enabled: boolean): void;
    dispose(): void;
};

const promptRecords = new WeakMap<AgentSession, PromptRecord>();
const undoInFlight = new WeakSet<AgentSession>();

let editorInputDepth = 0;

function isClearable(value: unknown): value is UndoHost["chatContainer"] {
    return (
        typeof value === "object" &&
        value !== null &&
        "clear" in value &&
        typeof value.clear === "function"
    );
}

function isTextEditor(value: unknown): value is UndoHost["editor"] {
    return (
        typeof value === "object" &&
        value !== null &&
        "getText" in value &&
        typeof value.getText === "function" &&
        "setText" in value &&
        typeof value.setText === "function"
    );
}

function isRenderer(value: unknown): value is UndoHost["ui"] {
    return (
        typeof value === "object" &&
        value !== null &&
        "requestRender" in value &&
        typeof value.requestRender === "function"
    );
}

function isUndoHost(value: unknown): value is UndoHost {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only the optional private members in the view;
    // each one is checked below.
    const view = value as InteractiveModeView;

    return (
        view.session instanceof AgentSession &&
        Array.isArray(view.compactionQueuedMessages) &&
        view.compactionQueuedMessages.length === 0 &&
        isClearable(view.chatContainer) &&
        isTextEditor(view.editor) &&
        isRenderer(view.ui) &&
        typeof view.renderInitialMessages === "function" &&
        typeof view.showError === "function"
    );
}

function isSessionFileState(value: unknown): value is SessionFileState {
    if (typeof value !== "object" || value === null) return false;

    // SAFETY: The object guard permits reading only the optional private members in the view;
    // each one is checked below.
    const view = value as SessionManagerView;

    return (
        typeof view.persist === "boolean" &&
        typeof view.flushed === "boolean" &&
        Array.isArray(view.fileEntries) &&
        view.byId instanceof Map &&
        view.labelsById instanceof Map &&
        view.labelTimestampsById instanceof Map
    );
}

function hasVisibleContent(message: AgentMessage): boolean {
    if (message.role !== "assistant") return true;

    return message.content.some((block) => {
        if (block.type === "text") return block.text.trim() !== "";
        if (block.type === "thinking") return block.thinking.trim() !== "";

        return true;
    });
}

function hasImage(message: AgentMessage): boolean {
    if (message.role !== "user" || !Array.isArray(message.content)) return false;

    return message.content.some((block) => block.type === "image");
}

function isUserMessage(entry: SessionEntry): boolean {
    return entry.type === "message" && entry.message.role === "user";
}

function isConversationEntry(entry: SessionEntry): boolean {
    return entry.type === "message" || entry.type === "custom_message";
}

function isEmptyAbortedReply(entry: SessionEntry): boolean {
    if (entry.type !== "message") return true;

    const message = entry.message;
    return (
        message.role === "assistant" &&
        message.stopReason === "aborted" &&
        !hasVisibleContent(message)
    );
}

function findFreshTurn(branch: readonly SessionEntry[]): FreshTurn | undefined {
    let userIndex = -1;

    branch.forEach((entry, index) => {
        if (isUserMessage(entry)) userIndex = index;
    });

    if (userIndex === -1) return undefined;

    const userEntry = branch.at(userIndex);
    if (userEntry?.type !== "message" || hasImage(userEntry.message)) return undefined;
    if (!branch.slice(userIndex + 1).every(isEmptyAbortedReply)) return undefined;

    const previous = branch.slice(0, userIndex).reverse().find(isConversationEntry);
    let previousConversationAt = Number.NEGATIVE_INFINITY;
    if (previous !== undefined) previousConversationAt = Date.parse(previous.timestamp);

    return { userEntry, previousConversationAt };
}

function hasResponseStarted(session: AgentSession): boolean {
    const state = session.agent.state;
    if (state.pendingToolCalls.size > 0) return true;

    const streaming = state.streamingMessage;
    return streaming !== undefined && hasVisibleContent(streaming);
}

function findUndoableTurn(session: AgentSession): FreshTurn | undefined {
    if (!session.isStreaming || session.pendingMessageCount > 0) return undefined;
    if (hasResponseStarted(session)) return undefined;

    return findFreshTurn(session.sessionManager.getBranch());
}

function submittedText(
    session: AgentSession,
    turn: FreshTurn,
    fallback: string | undefined,
): string | undefined {
    const record = promptRecords.get(session);
    const userAt = Date.parse(turn.userEntry.timestamp);
    if (record !== undefined && record.at <= userAt && record.at >= turn.previousConversationAt) {
        return record.text;
    }

    return fallback;
}

function writeEntries(file: string, entries: readonly (SessionHeader | SessionEntry)[]): void {
    const temporary = `${file}.${process.pid}.tmp`;

    writeFileSync(temporary, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    renameSync(temporary, file);
}

function hasConversation(entries: readonly SessionEntry[]): boolean {
    return entries.some(
        (entry) =>
            entry.type === "message" &&
            (entry.message.role === "user" || entry.message.role === "assistant"),
    );
}

/**
 * Removes the undone turn from the session file. The turn must be the trailing entries of the
 * session, all descending from the user message; otherwise it stays as an abandoned branch.
 */
function pruneUndoneTurn(manager: SessionManager, userEntryId: string): void {
    const header = manager.getHeader();
    const entries = manager.getEntries();
    const start = entries.findIndex((entry) => entry.id === userEntryId);
    if (header === null || start === -1) return;

    const removedIds = new Set<string>();
    for (const entry of entries.slice(start)) {
        const descends = entry.parentId !== null && removedIds.has(entry.parentId);
        if (entry.id !== userEntryId && !descends) return;

        removedIds.add(entry.id);
    }

    const state: unknown = manager;
    if (!isSessionFileState(state)) return;

    const { fileEntries, byId, labelsById, labelTimestampsById } = state;
    const matchesGetters =
        fileEntries.length === entries.length + 1 &&
        fileEntries[0] === header &&
        entries.every((entry, index) => fileEntries[index + 1] === entry);
    if (!matchesGetters) return;

    const remaining = entries.slice(0, start);

    fileEntries.splice(start + 1);

    for (const id of removedIds) {
        byId.delete(id);
        labelsById.delete(id);
        labelTimestampsById.delete(id);
    }

    const file = manager.getSessionFile();
    if (!state.persist || !state.flushed || file === undefined) return;

    if (hasConversation(remaining)) {
        writeEntries(file, [header, ...remaining]);
        return;
    }

    if (existsSync(file)) unlinkSync(file);
    state.flushed = false;
}

function joinEditorText(restored: string, current: string): string {
    return [restored, current].filter((text) => text.trim().length > 0).join("\n\n");
}

async function undoTurn(host: UndoHost, turn: FreshTurn): Promise<void> {
    const session = host.session;
    await session.abort();
    const current = findFreshTurn(session.sessionManager.getBranch());
    if (current?.userEntry.id !== turn.userEntry.id) return;

    const result = await session.navigateTree(turn.userEntry.id);
    if (result.cancelled) return;

    pruneUndoneTurn(session.sessionManager, turn.userEntry.id);

    host.chatContainer.clear();
    host.renderInitialMessages();

    const restored = submittedText(session, turn, result.editorText);
    if (restored !== undefined)
        host.editor.setText(joinEditorText(restored, host.editor.getText()));

    host.ui.requestRender();
}

function startUndo(host: UndoHost, turn: FreshTurn): void {
    undoInFlight.add(host.session);

    void undoTurn(host, turn)
        .catch((cause: unknown) => {
            let message = String(cause);
            if (cause instanceof Error) message = cause.message;

            host.showError(`Could not undo the cancelled prompt: ${message}`);
        })
        .finally(() => {
            undoInFlight.delete(host.session);
        });
}

function isInputHost(value: unknown): value is InputHost {
    return (
        typeof value === "object" &&
        value !== null &&
        "handleInput" in value &&
        typeof value.handleInput === "function"
    );
}

function isRestoreHost(value: unknown): value is RestoreHost {
    return (
        typeof value === "object" &&
        value !== null &&
        "restoreQueuedMessagesToEditor" in value &&
        typeof value.restoreQueuedMessagesToEditor === "function"
    );
}

function isPromptHost(value: unknown): value is PromptHost {
    return (
        typeof value === "object" &&
        value !== null &&
        "prompt" in value &&
        typeof value.prompt === "function"
    );
}

function isInteractivePrompt(options: PromptOptions): boolean {
    if (options === undefined) return true;

    return (
        (options.source === undefined || options.source === "interactive") &&
        options.images === undefined &&
        options.streamingBehavior === undefined
    );
}

/**
 * Makes cancelling from the editor undo a prompt whose response has not shown any output yet:
 * the turn leaves the session and its text returns to the editor.
 */
export function installCancelUndo(enabled: boolean): CancelUndoHandle {
    const editor: unknown = CustomEditor.prototype;
    const interactiveMode: unknown = InteractiveMode.prototype;
    const session: unknown = AgentSession.prototype;
    if (!isInputHost(editor) || !isRestoreHost(interactiveMode) || !isPromptHost(session)) {
        return { update(): void {}, dispose(): void {} };
    }

    const inputPatch = installKeyedLinkedMethodPatch(
        editor,
        "handleInput",
        EDITOR_INPUT_MARKER,
        enabled,
        (predecessor) =>
            function (this: InputHost, data: string): void {
                editorInputDepth += 1;

                try {
                    predecessor.call(this, data);
                } finally {
                    editorInputDepth -= 1;
                }
            },
    );

    const restorePatch = installKeyedLinkedMethodPatch(
        interactiveMode,
        "restoreQueuedMessagesToEditor",
        RESTORE_QUEUE_MARKER,
        enabled,
        (predecessor, isEnabled) =>
            function (this: RestoreHost, options?: RestoreOptions): number {
                if (options?.abort !== true || editorInputDepth === 0 || !isEnabled()) {
                    return predecessor.call(this, options);
                }

                if (!isUndoHost(this)) return predecessor.call(this, options);
                if (undoInFlight.has(this.session)) return 0;

                const turn = findUndoableTurn(this.session);
                if (turn === undefined) return predecessor.call(this, options);

                startUndo(this, turn);

                return 0;
            },
    );

    const promptPatch = installKeyedLinkedMethodPatch(
        session,
        "prompt",
        PROMPT_RECORD_MARKER,
        enabled,
        (predecessor) =>
            async function (
                this: PromptHost,
                text: string,
                options?: PromptOptions,
            ): Promise<void> {
                if (this instanceof AgentSession && isInteractivePrompt(options)) {
                    promptRecords.set(this, { text, at: Date.now() });
                }

                await predecessor.call(this, text, options);
            },
    );

    const patches = [inputPatch, restorePatch, promptPatch];

    return {
        update(next): void {
            for (const patch of patches) patch.update(next);
        },
        dispose(): void {
            for (let index = patches.length - 1; index >= 0; index -= 1) patches[index]?.dispose();
        },
    };
}
