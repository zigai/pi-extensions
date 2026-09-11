import type { AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, EditorComponent, Focusable } from "@earendil-works/pi-tui";

type AppAwareEditor = EditorComponent & {
    readonly actionHandlers: Map<AppKeybinding, () => void>;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean;
};

function isFocusableEditor(editor: EditorComponent): editor is EditorComponent & Focusable {
    return "focused" in editor && typeof editor.focused === "boolean";
}

function isAppAwareEditor(editor: EditorComponent): editor is AppAwareEditor {
    return "actionHandlers" in editor && editor.actionHandlers instanceof Map;
}

/** Intercepts Pi's reserved `/settings` submission while preserving the current editor component. */
export class SettingsCommandEditor implements EditorComponent, Focusable {
    private readonly fallbackActionHandlers = new Map<AppKeybinding, () => void>();
    private opening = false;
    private _focused = false;
    onEscape?: () => void;
    onCtrlD?: () => void;
    onPasteImage?: () => void;
    onExtensionShortcut?: (data: string) => boolean;
    onSubmit?: (text: string) => void;
    onChange?: (text: string) => void;
    borderColor?: (text: string) => string;

    constructor(
        private readonly base: EditorComponent,
        private readonly keybindings: Pick<KeybindingsManager, "matches">,
        private readonly openSettings: () => Promise<void>,
        private readonly reportOpenFailure: () => void,
    ) {
        if (base.onSubmit !== undefined) this.onSubmit = base.onSubmit;
        if (base.onChange !== undefined) this.onChange = base.onChange;
        if (base.borderColor !== undefined) this.borderColor = base.borderColor;

        if (isAppAwareEditor(base)) {
            if (base.onEscape !== undefined) this.onEscape = base.onEscape;
            if (base.onCtrlD !== undefined) this.onCtrlD = base.onCtrlD;
            if (base.onPasteImage !== undefined) this.onPasteImage = base.onPasteImage;

            if (base.onExtensionShortcut !== undefined) {
                this.onExtensionShortcut = base.onExtensionShortcut;
            }
        }
    }

    get actionHandlers(): Map<AppKeybinding, () => void> {
        return isAppAwareEditor(this.base) ? this.base.actionHandlers : this.fallbackActionHandlers;
    }

    get focused(): boolean {
        return isFocusableEditor(this.base) ? this.base.focused : this._focused;
    }

    set focused(value: boolean) {
        this._focused = value;
        if (isFocusableEditor(this.base)) this.base.focused = value;
    }

    get wantsKeyRelease(): boolean {
        return this.base.wantsKeyRelease === true;
    }

    render(width: number): string[] {
        return this.base.render(width);
    }

    invalidate(): void {
        this.base.invalidate();
    }

    handleInput(data: string): void {
        this.syncBaseCallbacks();

        const text = this.base.getExpandedText?.() ?? this.base.getText();
        if (
            !this.opening &&
            text.trim() === "/settings" &&
            this.keybindings.matches(data, "tui.input.submit")
        ) {
            this.opening = true;
            this.base.setText("");
            void this.openSettings().then(
                () => {
                    this.opening = false;
                },
                () => {
                    this.opening = false;
                    this.reportOpenFailure();
                },
            );

            return;
        }

        this.base.handleInput(data);
    }

    getText(): string {
        return this.base.getText();
    }

    getExpandedText(): string {
        return this.base.getExpandedText?.() ?? this.base.getText();
    }

    setText(text: string): void {
        this.syncBaseCallbacks();
        this.base.setText(text);
    }

    addToHistory(text: string): void {
        this.base.addToHistory?.(text);
    }

    insertTextAtCursor(text: string): void {
        this.base.insertTextAtCursor?.(text);
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.base.setAutocompleteProvider?.(provider);
    }

    setPaddingX(padding: number): void {
        this.base.setPaddingX?.(padding);
    }

    setAutocompleteMaxVisible(maxVisible: number): void {
        this.base.setAutocompleteMaxVisible?.(maxVisible);
    }

    private syncBaseCallbacks(): void {
        if (this.onSubmit !== undefined) this.base.onSubmit = this.onSubmit;
        if (this.onChange !== undefined) this.base.onChange = this.onChange;
        if (this.borderColor !== undefined) this.base.borderColor = this.borderColor;
        if (!isAppAwareEditor(this.base)) return;
        if (this.onEscape !== undefined) this.base.onEscape = this.onEscape;
        if (this.onCtrlD !== undefined) this.base.onCtrlD = this.onCtrlD;
        if (this.onPasteImage !== undefined) this.base.onPasteImage = this.onPasteImage;

        if (this.onExtensionShortcut !== undefined) {
            this.base.onExtensionShortcut = this.onExtensionShortcut;
        }
    }
}
