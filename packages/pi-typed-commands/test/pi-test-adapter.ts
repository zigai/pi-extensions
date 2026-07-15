import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ExtensionUIContext,
    KeybindingsManager,
    Theme,
} from "@earendil-works/pi-coding-agent";
import { isFocusable, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

export type TestExtensionEventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export type TestExtensionApiOverrides = {
    readonly events?: ExtensionAPI["events"];
    readonly on?: (name: string, handler: TestExtensionEventHandler) => void;
    readonly getCommands?: ExtensionAPI["getCommands"];
    readonly registerCommand?: ExtensionAPI["registerCommand"];
    readonly sendUserMessage?: ExtensionAPI["sendUserMessage"];
};

export type TestWidgetFactory = (tui: TUI, theme: Theme) => Component;

export type TestUiOverrides = {
    readonly addAutocompleteProvider?: (factory: unknown) => void;
    readonly custom?: (factory: Parameters<ExtensionUIContext["custom"]>[0]) => Promise<unknown>;
    readonly getEditorText?: () => string;
    readonly input?: (
        title: string,
        placeholder?: string,
        options?: { readonly signal?: AbortSignal; readonly timeout?: number },
    ) => Promise<string | undefined>;
    readonly notify?: (message: string, level?: "info" | "warning" | "error") => void;
    readonly onTerminalInput?: (
        handler: (
            data: string,
        ) => { readonly consume?: boolean; readonly data?: string } | undefined,
    ) => () => void;
    readonly setEditorText?: (text: string) => void;
    readonly setWidget?: (
        key: string,
        content: string[] | TestWidgetFactory | undefined,
        options?: { readonly placement?: "aboveEditor" | "belowEditor" },
    ) => void;
};

export type TestContextOverrides = {
    readonly cwd?: string;
    readonly hasUI?: boolean;
    readonly isProjectTrusted?: () => boolean;
    readonly mode?: ExtensionContext["mode"];
    readonly signal?: AbortSignal;
    readonly ui?: TestUiOverrides;
};

export type TestThemeOverrides = {
    readonly bold?: (text: string) => string;
    readonly fg?: (color: string, text: string) => string;
};

type ExternalPiContract =
    | ExtensionAPI
    | ExtensionCommandContext
    | ExtensionContext
    | KeybindingsManager
    | Theme
    | TUI;

function externalPiContract<TContract extends ExternalPiContract>(value: object): TContract {
    // SAFETY: Every value crossing this test-only boundary is assembled from the checked adapter
    // option types above, and tests exercise only those installed capabilities. Pi's framework
    // contracts require large runtime-owned objects/classes that cannot be constructed publicly.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return value as TContract;
}

export function createTestExtensionApi(overrides: TestExtensionApiOverrides = {}): ExtensionAPI {
    return externalPiContract<ExtensionAPI>({
        events: overrides.events ?? {},
        on: overrides.on ?? (() => {}),
        getCommands: overrides.getCommands ?? (() => []),
        registerCommand: overrides.registerCommand ?? (() => {}),
        sendUserMessage: overrides.sendUserMessage ?? (() => {}),
    });
}

function createTestContextValue(overrides: TestContextOverrides): object {
    return {
        cwd: overrides.cwd ?? process.cwd(),
        hasUI: overrides.hasUI ?? true,
        isProjectTrusted: overrides.isProjectTrusted ?? (() => true),
        mode: overrides.mode ?? "tui",
        signal: overrides.signal,
        ui: {
            addAutocompleteProvider: overrides.ui?.addAutocompleteProvider ?? (() => {}),
            custom: overrides.ui?.custom ?? (async () => undefined),
            getEditorText: overrides.ui?.getEditorText ?? (() => ""),
            input: overrides.ui?.input ?? (async () => undefined),
            notify: overrides.ui?.notify ?? (() => {}),
            onTerminalInput: overrides.ui?.onTerminalInput ?? (() => () => {}),
            setEditorText: overrides.ui?.setEditorText ?? (() => {}),
            setWidget: overrides.ui?.setWidget ?? (() => {}),
        },
    };
}

export function createTestExtensionContext(overrides: TestContextOverrides = {}): ExtensionContext {
    return externalPiContract<ExtensionContext>(createTestContextValue(overrides));
}

export function createTestExtensionCommandContext(
    overrides: TestContextOverrides = {},
): ExtensionCommandContext {
    return externalPiContract<ExtensionCommandContext>(createTestContextValue(overrides));
}

export function createTestTui(): TUI {
    return externalPiContract<TUI>({
        terminal: { rows: 24, columns: 80 },
        requestRender() {},
    });
}

export function createTestTheme(overrides: TestThemeOverrides = {}): Theme {
    return externalPiContract<Theme>({
        bold: overrides.bold ?? ((text: string) => text),
        fg: overrides.fg ?? ((_color: string, text: string) => text),
    });
}

export function createTestKeybindings(): KeybindingsManager {
    return externalPiContract<KeybindingsManager>({});
}

export type InteractiveTestComponent = Component &
    Focusable & {
        handleInput(data: string): void;
    };

export function requireFocusableComponent(component: Component): Component & Focusable {
    if (!isFocusable(component)) {
        throw new TypeError("expected a focusable component");
    }
    return component;
}

function hasInputHandler(component: Component & Focusable): component is InteractiveTestComponent {
    return typeof component.handleInput === "function";
}

export function requireInteractiveComponent(component: Component): InteractiveTestComponent {
    const focusable = requireFocusableComponent(component);
    if (!hasInputHandler(focusable)) {
        throw new TypeError("expected a callable component input handler");
    }
    return focusable;
}

export function isTestWidgetFactory(value: unknown): value is TestWidgetFactory {
    return typeof value === "function";
}

export function requireTestWidgetFactory(value: unknown): TestWidgetFactory {
    if (!isTestWidgetFactory(value)) {
        throw new TypeError("expected a widget factory");
    }
    return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTransformInputResult(
    value: unknown,
): value is { readonly action: "transform"; readonly text: string } {
    return isRecord(value) && value.action === "transform" && typeof value.text === "string";
}

export type TestSignal<T> = {
    readonly promise: Promise<T>;
    resolve(value: T): void;
};

export function createTestSignal<T>(): TestSignal<T> {
    let settle: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return {
        promise,
        resolve(value) {
            if (settle === undefined) {
                throw new Error("test signal was not initialized");
            }
            settle(value);
        },
    };
}
