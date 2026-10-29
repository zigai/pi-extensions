import { Type, type Static } from "typebox";

export const DEFAULT_PASTE_COLLAPSE_ENABLED = true;
export const DEFAULT_PASTE_COLLAPSE_LINE_THRESHOLD = 10;
export const DEFAULT_PASTE_COLLAPSE_CHAR_THRESHOLD = 1000;
export const DEFAULT_PASTE_COLLAPSE_EXPAND_KEY: string | null = null;
export const DEFAULT_PASTE_COLLAPSE_USE_TOOL_EXPAND_KEY = true;

export const PeakRuleSchema = Type.Object(
    {
        provider: Type.String({ minLength: 1, description: "Exact physical Pi provider ID." }),
        model: Type.String({
            minLength: 1,
            description: "Exact native model ID, not its display alias.",
        }),
        openRouterBillingConfirmed: Type.Optional(
            Type.Boolean({
                description:
                    "For or only: you confirm OpenRouter billing (not BYOK) and no extension or proxy changes the configured routing.",
            }),
        ),
        schedule: Type.Union(
            [
                Type.Literal("deepseek-direct"),
                Type.Literal("deepseek-reseller"),
                Type.Literal("command"),
                Type.Literal("glm"),
                Type.Literal("qwen"),
                Type.Literal("ali-qwen"),
                Type.Literal("ali-deepseek"),
                Type.Literal("mimo"),
                Type.Literal("or"),
            ],
            {
                title: "OffPeakSchedule",
                description:
                    "Selecting a schedule asserts the exact billing route, plan, region, endpoint, offer validity and no ineligible fallback. Only documented model IDs are accepted; or requires live OpenRouter metadata and verified Pi routing.",
            },
        ),
    },
    { additionalProperties: false, title: "OffPeakRule" },
);

export const PeakHolidaySchema = Type.Object(
    {
        date: Type.String({
            pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
            description: "Beijing calendar date, YYYY-MM-DD.",
        }),
        holiday: Type.Boolean({
            description: "True for a public holiday, false for a confirmed ordinary date.",
        }),
    },
    { additionalProperties: false, title: "DeepSeekHolidayDate" },
);

export type PeakRule = Static<typeof PeakRuleSchema>;
export type PeakHoliday = Static<typeof PeakHolidaySchema>;

export type UiTweaksConfig = {
    readonly autocompleteAboveInput: boolean;
    readonly bashExecPromptSpacing: boolean;
    readonly anchorInputToBottom: boolean;
    readonly compactModelSelector: boolean;
    readonly compactStartup: boolean;
    readonly dimInputBorder: boolean;
    readonly hideAutocompleteScrollInfo: boolean;
    readonly hideModelChangeStatus: boolean;
    readonly hideModelProviderHint: boolean;
    readonly hideSlashCommandSourceTags: boolean;
    readonly highlightSelectedModelProvider: boolean;
    readonly pinnedModels: readonly string[];
    readonly offPeakRules: readonly PeakRule[];
    readonly deepseekHolidayCalendar: readonly PeakHoliday[];
    readonly inputPromptPrefix: string;
    readonly neutralBorderColor: boolean;
    readonly mainScreenSynchronizedOutput: boolean;
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
    compactStartup?: boolean;
    dimInputBorder?: boolean;
    enabled?: boolean;
    hideAutocompleteScrollInfo?: boolean;
    hideModelChangeStatus?: boolean;
    hideModelProviderHint?: boolean;
    hideSlashCommandSourceTags?: boolean;
    highlightSelectedModelProvider?: boolean;
    pinnedModels?: string[];
    offPeakRules?: PeakRule[];
    deepseekHolidayCalendar?: PeakHoliday[];
    inputPromptPrefix?: string;
    neutralBorderColor?: boolean;
    mainScreenSynchronizedOutput?: boolean;
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
            compactStartup: Type.Boolean({
                default: false,
                description:
                    "Show a compact startup header; expand tools to reveal native help and loaded resources.",
            }),
            dimInputBorder: Type.Boolean({
                default: true,
                description: "Dim the input editor's horizontal border lines.",
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
            offPeakRules: Type.Array(PeakRuleSchema, {
                default: [],
                description:
                    "Opt in only after verifying the exact billing route, plan, model, endpoint, region and active offer. deepseek-reseller is OpenCode Go only; command is Command; glm is the Coding Plan; qwen is Alibaba Global PAYG; ali-qwen is eligible Alibaba personal Token Plan; ali-deepseek is eligible Alibaba PAYG or Token Plan; mimo is Token Plan. or requires verified OpenRouter routing and live endpoint metadata.",
            }),
            deepseekHolidayCalendar: Type.Array(PeakHolidaySchema, {
                default: [],
                description:
                    "Authoritative Chinese public-holiday status by date for direct DeepSeek: true is a holiday, false is not. Unknown dates suppress predictions that depend on them. Keep dates current; reseller schedules do not use this calendar.",
            }),
            pinnedModels: Type.Array(Type.String({ minLength: 1 }), {
                default: [],
                description:
                    "Pinned models in display order, each as provider/native-model-id (including virtual model IDs); aliases and display names do not change the key.",
            }),
            inputPromptPrefix: Type.String({
                minLength: 1,
                default: "> ",
                description: "Prefix displayed before input text.",
            }),
            mainScreenSynchronizedOutput: Type.Boolean({
                default: true,
                description:
                    "Present regular-mode content and final cursor updates in one synchronized-output frame.",
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
