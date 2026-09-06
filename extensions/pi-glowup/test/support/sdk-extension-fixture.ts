import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionEvent,
    type ExtensionHandler,
    type ExtensionUIContext,
    type ProjectTrustEvent,
    type ProjectTrustHandler,
} from "@earendil-works/pi-coding-agent";

type OrdinaryEvent = Exclude<ExtensionEvent, ProjectTrustEvent>;
export type Registration =
    | {
          [Name in OrdinaryEvent["type"]]: readonly [
              Name,
              ExtensionHandler<Extract<OrdinaryEvent, { type: Name }>, unknown>,
          ];
      }[OrdinaryEvent["type"]]
    | readonly ["project_trust", ProjectTrustHandler];

export class ExtensionRegistrationFixture implements Pick<ExtensionAPI, "on"> {
    readonly registrations: Registration[] = [];
    on(...registration: Registration): void {
        this.registrations.push(registration);
    }
}

function unavailable(): never {
    throw new Error("This fixture does not implement interactive SDK operations");
}

export function createExtensionContext(
    cwd: string,
    options: {
        mode?: ExtensionContext["mode"];
        trusted?: boolean;
        sessionManager?: ExtensionContext["sessionManager"];
        setToolsExpanded?: ExtensionUIContext["setToolsExpanded"];
    } = {},
): ExtensionContext {
    const ui: ExtensionUIContext = {
        select: unavailable,
        confirm: unavailable,
        input: unavailable,
        notify: unavailable,
        onTerminalInput: unavailable,
        setStatus: unavailable,
        setWorkingMessage: unavailable,
        setWorkingVisible: unavailable,
        setWorkingIndicator: unavailable,
        setHiddenThinkingLabel: unavailable,
        setWidget: unavailable,
        setFooter: unavailable,
        setHeader: unavailable,
        setTitle: unavailable,
        custom: unavailable,
        pasteToEditor: unavailable,
        setEditorText: unavailable,
        getEditorText: unavailable,
        editor: unavailable,
        addAutocompleteProvider: unavailable,
        setEditorComponent: unavailable,
        getEditorComponent: unavailable,
        get theme(): never {
            return unavailable();
        },
        getAllThemes: unavailable,
        getTheme: unavailable,
        setTheme: unavailable,
        getToolsExpanded: () => false,
        setToolsExpanded: options.setToolsExpanded ?? (() => {}),
    };
    return {
        cwd,
        ui,
        mode: options.mode ?? "print",
        hasUI: options.mode === "tui",
        sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
        get modelRegistry(): never {
            return unavailable();
        },
        model: undefined,
        scopedModels: [],
        signal: undefined,
        isIdle: () => true,
        isProjectTrusted: () => options.trusted ?? true,
        abort: unavailable,
        hasPendingMessages: () => false,
        shutdown: unavailable,
        getContextUsage: () => undefined,
        compact: unavailable,
        getSystemPrompt: () => "",
    };
}
