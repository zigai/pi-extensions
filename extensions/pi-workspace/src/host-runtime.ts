import * as sdk from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { Compile } from "typebox/compile";

export const componentSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    invalidate: Type.Function([], Type.Void()),
});

const editorThemeSchema = Type.Object({
    borderColor: Type.Function([Type.String()], Type.String()),
    selectList: Type.Object({
        selectedPrefix: Type.Function([Type.String()], Type.String()),
        selectedText: Type.Function([Type.String()], Type.String()),
        description: Type.Function([Type.String()], Type.String()),
        scrollInfo: Type.Function([Type.String()], Type.String()),
        noMatch: Type.Function([Type.String()], Type.String()),
    }),
});

export const editorSchema = Type.Intersect([
    componentSchema,
    Type.Object({
        getText: Type.Function([], Type.String()),
        setText: Type.Function([Type.String()], Type.Void()),
        handleInput: Type.Function([Type.String()], Type.Void()),
        onExtensionShortcut: Type.Optional(Type.Function([Type.String()], Type.Boolean())),
    }),
]);

export const containerSchema = Type.Intersect([
    componentSchema,
    Type.Object({
        children: Type.Array(componentSchema),
        clear: Type.Function([], Type.Void()),
        addChild: Type.Function([componentSchema], Type.Void()),
        removeChild: Type.Function([componentSchema], Type.Void()),
    }),
]);
const factorySchema = Type.Function([Type.Unknown(), Type.Unknown(), Type.Unknown()], editorSchema);
const prototypeSchema = Type.Object({
    setCustomEditorComponent: Type.Function([Type.Optional(factorySchema)], Type.Void()),
    renderSessionEntries: Type.Function(
        [Type.Array(Type.Unknown()), Type.Optional(Type.Unknown())],
        Type.Void(),
    ),
    renderInitialMessages: Type.Function([], Type.Void()),
    rebuildChatFromMessages: Type.Function([], Type.Void()),
    setupExtensionShortcuts: Type.Function([Type.Unknown()], Type.Void()),
    handleReloadCommand: Type.Function([], Type.Unknown()),
    handleEvent: Type.Function([Type.Unknown()], Type.Unknown()),
    addMessageToChat: Type.Function([Type.Unknown(), Type.Optional(Type.Unknown())], Type.Void()),
    switchTuiMode: Type.Function(
        [
            Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")]),
            Type.Optional(Type.Boolean()),
            Type.Optional(Type.Boolean()),
        ],
        Type.Boolean(),
    ),
});

const hostSchema = Type.Object({
    editor: editorSchema,
    editorComponentFactory: Type.Optional(factorySchema),
    sessionManager: Type.Object({ getSessionId: Type.Function([], Type.String()) }),
    defaultEditor: Type.Intersect([editorSchema, Type.Object({ theme: editorThemeSchema })]),
    ui: Type.Object({
        terminal: Type.Object({ rows: Type.Number(), columns: Type.Number() }),
        requestRender: Type.Function([Type.Optional(Type.Boolean())], Type.Void()),
        setFocus: Type.Function([Type.Union([componentSchema, Type.Null()])], Type.Void()),
    }),
    keybindings: Type.Object({
        matches: Type.Function([Type.String(), Type.String()], Type.Boolean()),
    }),
    chatContainer: containerSchema,
    streamingComponent: Type.Optional(componentSchema),
    documentContainer: containerSchema,
    editorContainer: containerSchema,
    renderer: Type.Object({
        mode: Type.Union([Type.Literal("regular"), Type.Literal("fullscreen")]),
        requestRender: Type.Function([Type.Optional(Type.Boolean())], Type.Void()),
    }),
    fullscreenLayoutRoot: componentSchema,
});

export type WorkspaceHost = StaticDecode<typeof hostSchema>;
export type HostPrototype = StaticDecode<typeof prototypeSchema>;

const hosts = Compile(hostSchema);

export const hostRuntime = {
    parse(value: unknown): WorkspaceHost {
        if (!hosts.Check(value)) throw new Error("Pi workspace host shape is unsupported");

        return value;
    },
};
const moduleSchema = Type.Object({ InteractiveMode: Type.Function([], Type.Unknown()) });

export function getHostPrototype(): HostPrototype {
    if (!Value.Check(moduleSchema, sdk)) throw new Error("Pi interactive host is unavailable");

    const prototype: unknown = Object.getOwnPropertyDescriptor(
        sdk.InteractiveMode,
        "prototype",
    )?.value;
    if (!Value.Check(prototypeSchema, prototype))
        throw new Error("Pi workspace lifecycle methods are unsupported");

    return prototype;
}
