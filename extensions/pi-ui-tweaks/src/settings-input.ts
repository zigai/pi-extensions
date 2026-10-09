import { Type } from "typebox";

export const DEFAULT_PASTE_COLLAPSE_ENABLED = true;
export const DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD = 10;
export const DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD = 1000;
export const DEFAULT_PASTE_COLLAPSE_EXPAND_KEY: string | null = null;
export const DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY = true;

export type UiTweaksConfig = {
    readonly autocompleteAboveInput: boolean;
    readonly bashExecPromptSpacing: boolean;
    readonly anchorInputToBottom: boolean;
    readonly compactModelSelector: boolean;
    readonly hideAutocompleteScrollInfo: boolean;
    readonly hideModelChangeStatus: boolean;
    readonly hideModelProviderHint: boolean;
    readonly hideSlashCommandSourceTags: boolean;
    readonly highlightSelectedModelProvider: boolean;
    readonly inputPromptPrefix: string;
    readonly neutralBorderColor: boolean;
    readonly pasteCollapseCharThreshold: number;
    readonly pasteCollapseEnabled: boolean;
    readonly pasteCollapseExpandKey: string | null;
    readonly pasteCollapseLineThreshold: number;
    readonly pasteCollapseUseToolExpandKey: boolean;
    readonly preserveCompactionHistory: boolean;
    readonly restoreContentAfterAutocompleteClose: boolean;
    readonly refreshTmuxHyperlinks: boolean;
    readonly selectedOptionPrefix: string;
};

export type LoadedUiTweaksConfig = {
    readonly config: UiTweaksConfig;
    readonly errors: readonly string[];
};

export type UiTweaksSettingsSource = {
    readonly label: string;
    readonly settings: unknown;
};

export type UiTweaksSettings = {
    $schema?: string;
    autocompleteAboveInput?: boolean;
    bashExecPromptSpacing?: boolean;
    anchorInputToBottom?: boolean;
    compactModelSelector?: boolean;
    enabled?: boolean;
    hideAutocompleteScrollInfo?: boolean;
    hideModelChangeStatus?: boolean;
    hideModelProviderHint?: boolean;
    hideSlashCommandSourceTags?: boolean;
    highlightSelectedModelProvider?: boolean;
    inputPromptPrefix?: string;
    neutralBorderColor?: boolean;
    pasteCollapseCharThreshold?: number;
    pasteCollapseEnabled?: boolean;
    pasteCollapseExpandKey?: string | null;
    pasteCollapseLineThreshold?: number;
    pasteCollapseUseToolExpandKey?: boolean;
    preserveCompactionHistory?: boolean;
    restoreContentAfterAutocompleteClose?: boolean;
    refreshTmuxHyperlinks?: boolean;
    selectedOptionPrefix?: string;
};

export const PASTE_COLLAPSE_EXPAND_KEY_PATTERN =
    "^(?:(?:ctrl|shift|alt|super)\\+)*(?:[a-z0-9]|escape|esc|enter|return|tab|space|backspace|delete|insert|clear|home|end|pageUp|pageDown|pageup|pagedown|up|down|left|right|f(?:[1-9]|1[0-2])|[`\\-=\\[\\]\\\\;',./!@#$%^&*()_|~{}:<>?])$";

export const OptionalPasteCollapseExpandKeySchema = Type.Union([
    Type.String({ minLength: 1, pattern: PASTE_COLLAPSE_EXPAND_KEY_PATTERN }),
    Type.Null(),
]);

export const extensionSettingsInput = {
    id: "pi-ui-tweaks",
    title: "Pi UI Tweaks",
    description: "Settings for Pi interactive-interface behavior and presentation tweaks.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-ui-tweaks/config.schema.json",
    schema: Type.Object(
        {
            enabled: Type.Boolean({ default: true, description: "Enable all UI tweaks." }),
            autocompleteAboveInput: Type.Boolean({
                default: true,
                description: "Render autocomplete above the input editor.",
            }),
            bashExecPromptSpacing: Type.Boolean({
                default: true,
                description: "Add spacing around bash execution prompts.",
            }),
            anchorInputToBottom: Type.Boolean({
                default: false,
                description: "Anchor the input editor to the terminal bottom.",
            }),
            compactModelSelector: Type.Boolean({
                default: true,
                description: "Use compact model-selector rows.",
            }),
            hideAutocompleteScrollInfo: Type.Boolean({
                default: true,
                description: "Hide autocomplete scroll-position text.",
            }),
            hideModelChangeStatus: Type.Boolean({
                default: true,
                description: "Hide model-change status messages.",
            }),
            hideModelProviderHint: Type.Boolean({
                default: true,
                description: "Hide provider hints in the model selector.",
            }),
            hideSlashCommandSourceTags: Type.Boolean({
                default: true,
                description: "Hide source tags in slash-command completion.",
            }),
            highlightSelectedModelProvider: Type.Boolean({
                default: true,
                description: "Highlight the selected model provider.",
            }),
            inputPromptPrefix: Type.String({
                minLength: 1,
                default: "> ",
                description: "Prefix displayed before input text.",
            }),
            neutralBorderColor: Type.Boolean({
                default: true,
                description: "Use a neutral border color when Pi is idle.",
            }),
            pasteCollapseCharThreshold: Type.Integer({
                minimum: 0,
                default: DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD,
                description: "Character threshold that collapses pasted content.",
            }),
            pasteCollapseEnabled: Type.Boolean({
                default: DEFAULT_PASTE_COLLAPSE_ENABLED,
                description: "Collapse large pasted content.",
            }),
            pasteCollapseExpandKey: Type.Union(OptionalPasteCollapseExpandKeySchema.anyOf, {
                default: DEFAULT_PASTE_COLLAPSE_EXPAND_KEY,
                description: "Explicit key used to expand collapsed pasted content.",
            }),
            pasteCollapseLineThreshold: Type.Integer({
                minimum: 0,
                default: DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD,
                description: "Line threshold that collapses pasted content.",
            }),
            pasteCollapseUseToolExpandKey: Type.Boolean({
                default: DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY,
                description: "Reuse Pi's configured tool-expansion key for pasted content.",
            }),
            preserveCompactionHistory: Type.Boolean({
                default: false,
                description: "Keep pre-compaction messages visible in transcript history.",
            }),
            restoreContentAfterAutocompleteClose: Type.Boolean({
                default: true,
                description: "Restore editor content after closing autocomplete.",
            }),
            refreshTmuxHyperlinks: Type.Boolean({
                default: true,
                description: "Refresh Markdown links when a tmux client attaches or detaches.",
            }),
            selectedOptionPrefix: Type.String({
                minLength: 1,
                default: "→ ",
                description: "Prefix displayed before selected list options.",
            }),
        },
        { additionalProperties: false },
    ),
};

export default extensionSettingsInput;
