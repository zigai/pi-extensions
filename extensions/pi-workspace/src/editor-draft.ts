import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import type { EditorComponent } from "@earendil-works/pi-tui";

const cursorSchema = Type.Object({
    lines: Type.Array(Type.String(), { minItems: 1 }),
    cursorLine: Type.Integer({ minimum: 0 }),
    cursorCol: Type.Integer({ minimum: 0 }),
});
const pasteEntriesSchema = Type.Array(Type.Tuple([Type.Integer({ minimum: 0 }), Type.String()]));
const documentSchema = Type.Object({
    state: cursorSchema,
    pastes: pasteEntriesSchema,
    pasteCounter: Type.Integer({ minimum: 0 }),
});

const pointSchema = Type.Object({
    line: Type.Integer({ minimum: 0 }),
    col: Type.Integer({ minimum: 0 }),
});

export const editorDraftSchema = Type.Object({
    selection: Type.Union([Type.Object({ anchor: pointSchema, focus: pointSchema }), Type.Null()]),
    document: documentSchema,
    undo: Type.Array(documentSchema),
    history: Type.Array(Type.String()),
    historyIndex: Type.Integer(),
    historyDraft: Type.Union([cursorSchema, Type.Null()]),
    killRing: Type.Array(Type.String()),
    lastAction: Type.Union([Type.String(), Type.Null()]),
    jumpMode: Type.Union([Type.String(), Type.Null()]),
    preferredVisualCol: Type.Union([Type.Number(), Type.Null()]),
    snappedFromCursorCol: Type.Union([Type.Number(), Type.Null()]),
    scrollOffset: Type.Number(),
    pasteBuffer: Type.String(),
    isInPaste: Type.Boolean(),
});

export type EditorDraft = StaticDecode<typeof editorDraftSchema>;

export type EditorDraftAdapter = {
    capture(): EditorDraft;
    restore(draft: EditorDraft): void;
    dispose(): void;
};

const adapterKey = Symbol.for("zigai.pi-workspace.editor-draft-adapter");
const adapterSchema = Type.Object({
    capture: Type.Function([], editorDraftSchema),
    restore: Type.Function([editorDraftSchema], Type.Void()),
    dispose: Type.Function([], Type.Void()),
});

const nativeEditorSchema = Type.Object({
    state: cursorSchema,
    pasteCounter: Type.Integer({ minimum: 0 }),
    undoStack: Type.Object({
        stack: Type.Array(
            Type.Object({ state: cursorSchema, pasteCounter: Type.Integer({ minimum: 0 }) }),
        ),
    }),
    history: Type.Array(Type.String()),
    historyIndex: Type.Integer(),
    historyDraft: Type.Union([cursorSchema, Type.Null()]),
    killRing: Type.Object({ ring: Type.Array(Type.String()) }),
    lastAction: Type.Union([Type.String(), Type.Null()]),
    jumpMode: Type.Union([Type.String(), Type.Null()]),
    preferredVisualCol: Type.Union([Type.Number(), Type.Null()]),
    snappedFromCursorCol: Type.Union([Type.Number(), Type.Null()]),
    scrollOffset: Type.Number(),
    pasteBuffer: Type.String(),
    isInPaste: Type.Boolean(),
    cancelAutocomplete: Type.Function([], Type.Void()),
});

const pasteMapParser = {
    parse(value: unknown): StaticDecode<typeof pasteEntriesSchema> {
        if (!(value instanceof Map)) throw new Error("Editor paste storage is unsupported");
        return Value.Decode(pasteEntriesSchema, [...value.entries()]);
    },
};

export function attachEditorDraftAdapter(
    editor: EditorComponent,
    adapter: EditorDraftAdapter,
): void {
    Object.defineProperty(editor, adapterKey, { configurable: true, value: adapter });
}

export function getEditorDraftAdapter(editor: EditorComponent): EditorDraftAdapter {
    const attached: unknown = Object.getOwnPropertyDescriptor(editor, adapterKey)?.value;
    if (attached !== undefined) {
        if (!Value.Check(adapterSchema, attached))
            throw new Error("Editor draft adapter is incompatible");

        return {
            capture: () => Value.Decode(editorDraftSchema, structuredClone(attached.capture())),
            restore: (draft) => {
                attached.restore(Value.Decode(editorDraftSchema, structuredClone(draft)));
            },
            dispose: () => {
                attached.dispose();
            },
        };
    }

    if (!Value.Check(nativeEditorSchema, editor) || !("pastes" in editor))
        throw new Error("Editor backend cannot preserve draft state");

    const native = editor;
    pasteMapParser.parse(native.pastes);

    return {
        capture: (): EditorDraft => {
            const undo = native.undoStack.stack.map((snapshot) => {
                if (!("pastes" in snapshot))
                    throw new Error("Editor undo paste storage is unsupported");

                return {
                    state: snapshot.state,
                    pasteCounter: snapshot.pasteCounter,
                    pastes: pasteMapParser.parse(snapshot.pastes),
                };
            });

            return structuredClone({
                selection: null,
                document: {
                    state: native.state,
                    pasteCounter: native.pasteCounter,
                    pastes: pasteMapParser.parse(native.pastes),
                },
                undo,
                history: native.history,
                historyIndex: native.historyIndex,
                historyDraft: native.historyDraft,
                killRing: native.killRing.ring,
                lastAction: native.lastAction,
                jumpMode: native.jumpMode,
                preferredVisualCol: native.preferredVisualCol,
                snappedFromCursorCol: native.snappedFromCursorCol,
                scrollOffset: native.scrollOffset,
                pasteBuffer: native.pasteBuffer,
                isInPaste: native.isInPaste,
            });
        },
        restore: (draft): void => {
            const copy = Value.Decode(editorDraftSchema, structuredClone(draft));
            if (copy.selection !== null)
                throw new Error("Native editor does not support draft selection handoff");

            if (
                copy.document.state.cursorLine >= copy.document.state.lines.length ||
                copy.document.state.cursorCol >
                    (copy.document.state.lines[copy.document.state.cursorLine]?.length ?? 0)
            )
                throw new Error("Editor draft cursor is invalid");

            native.cancelAutocomplete();
            Object.assign(native, {
                ...copy.document,
                pastes: new Map(copy.document.pastes),
                history: copy.history,
                historyIndex: copy.historyIndex,
                historyDraft: copy.historyDraft,
                lastAction: copy.lastAction,
                jumpMode: copy.jumpMode,
                preferredVisualCol: copy.preferredVisualCol,
                snappedFromCursorCol: copy.snappedFromCursorCol,
                scrollOffset: copy.scrollOffset,
                pasteBuffer: copy.pasteBuffer,
                isInPaste: copy.isInPaste,
            });
            native.killRing.ring = copy.killRing;
            native.undoStack.stack = copy.undo.map((snapshot) => ({
                ...snapshot,
                pastes: new Map(snapshot.pastes),
            }));
            native.invalidate();
        },
        dispose: (): void => {
            native.cancelAutocomplete();
        },
    };
}
