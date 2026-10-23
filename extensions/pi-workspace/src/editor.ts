import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { BackendRegistry } from "./backend-registry.ts";
import { attachEditorDraftAdapter, getEditorDraftAdapter } from "./editor-draft.ts";

export {
    attachEditorDraftAdapter,
    editorDraftSchema,
    type EditorDraft,
    type EditorDraftAdapter,
} from "./editor-draft.ts";
export type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
export type EditorBackend = { create: EditorFactory };

const registryKey = Symbol.for("zigai.pi-workspace.editor-backends");

type Shared = typeof globalThis & { [registryKey]?: BackendRegistry<EditorBackend> };

const shared: Shared = globalThis;

const builtins: ReadonlyMap<string, EditorBackend> = new Map([
    ["native", { create: (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings) }],
]);

export const editorBackends = shared[registryKey] ?? new BackendRegistry(builtins, "native");
shared[registryKey] = editorBackends;

export function registerEditorBackend(
    name: string,
    backend: EditorBackend,
): { update(next: EditorBackend): void; dispose(): void } {
    return editorBackends.register(name, backend);
}

export function selectEditorBackend(name: string): void {
    editorBackends.select(name);
}

export function createWorkspaceEditor(...args: Parameters<EditorFactory>): EditorComponent {
    const editor = editorBackends.current.create(...args);
    const adapter = getEditorDraftAdapter(editor);
    attachEditorDraftAdapter(editor, adapter);

    return editor;
}
