import { Type } from "typebox";

export const DEFAULT_SPINNER_INTERVAL_MS = 160;
export const RIGHT_MESSAGES_SETTINGS_KEY = "rightMessages";
export const DEFAULT_RIGHT_MESSAGE_INTERVAL_MS = 10_000;
export const DEFAULT_RIGHT_MESSAGE_MIN_GAP = 4;
export const DEFAULT_RIGHT_MESSAGE_SCROLL_COLUMN_INTERVAL_MS = 120;
export const DEFAULT_RIGHT_MESSAGE_MIN_SCROLL_CYCLES = 1;

export const spinnerSettingsSchema = Type.Object(
    {
        frames: Type.Optional(
            Type.Array(Type.String(), {
                description: "Spinner frames displayed while Pi is active.",
            }),
        ),
        intervalMs: Type.Integer({
            minimum: 1,
            default: DEFAULT_SPINNER_INTERVAL_MS,
            description: "Delay between working spinner frames in milliseconds.",
        }),
    },
    { default: {}, additionalProperties: false },
);

export const timerSettingsSchema = Type.Object(
    {
        visible: Type.Boolean({
            default: true,
            description: "Show the active-run timer.",
        }),
        paused: Type.Boolean({
            default: false,
            description: "Display the active-run timer as paused.",
        }),
    },
    { default: {}, additionalProperties: false },
);

export const activeSettingsSchema = Type.Object(
    {
        text: Type.Optional(Type.String({ description: "Custom active status text." })),
        spinner: spinnerSettingsSchema,
        timer: timerSettingsSchema,
    },
    { default: {}, additionalProperties: false },
);

export const idleSettingsSchema = Type.Object(
    {
        text: Type.Optional(Type.String({ description: "Custom idle status text." })),
        visible: Type.Boolean({
            default: true,
            description: "Show the status bar while Pi is idle.",
        }),
        showLastRunSummary: Type.Boolean({
            default: true,
            description: "Show the previous run summary while idle.",
        }),
        showTokensPerSecond: Type.Boolean({
            default: true,
            description: "Show model token throughput in the previous run summary.",
        }),
    },
    { default: {}, additionalProperties: false },
);

export const extensionSettingsInput = {
    id: "pi-status-bar",
    title: "Pi Status Bar",
    description: "Settings for active, idle, and rotating status-bar content.",
    schemaId:
        "https://raw.githubusercontent.com/zigai/pi-tweaks/master/extensions/pi-status-bar/config.schema.json",
    schema: Type.Object(
        {
            statusBar: Type.Object(
                {
                    active: activeSettingsSchema,
                    idle: idleSettingsSchema,
                },
                { default: {}, additionalProperties: false },
            ),
            rightMessages: Type.Object(
                {
                    enabled: Type.Boolean({
                        default: false,
                        description: "Enable rotating messages on the right side.",
                    }),
                    intervalMs: Type.Integer({
                        minimum: 1,
                        default: DEFAULT_RIGHT_MESSAGE_INTERVAL_MS,
                        description: "Delay between rotating messages in milliseconds.",
                    }),
                    minGap: Type.Integer({
                        minimum: 0,
                        default: DEFAULT_RIGHT_MESSAGE_MIN_GAP,
                        description: "Minimum spaces between repeated scrolling messages.",
                    }),
                    minScrollCycles: Type.Integer({
                        minimum: 1,
                        default: DEFAULT_RIGHT_MESSAGE_MIN_SCROLL_CYCLES,
                        description: "Minimum completed scroll cycles before advancing.",
                    }),
                    scrollColumnIntervalMs: Type.Integer({
                        minimum: 1,
                        default: DEFAULT_RIGHT_MESSAGE_SCROLL_COLUMN_INTERVAL_MS,
                        description: "Delay between horizontal scroll columns in milliseconds.",
                    }),
                    dimmed: Type.Boolean({
                        default: true,
                        description: "Render rotating messages with dim styling.",
                    }),
                    italic: Type.Boolean({
                        default: true,
                        description: "Render rotating messages with italic styling.",
                    }),
                    messages: Type.Array(Type.String(), {
                        default: [],
                        description: "Inline rotating status messages.",
                    }),
                    messagesFile: Type.Optional(
                        Type.String({
                            minLength: 1,
                            "x-control": "path",
                            description: "Path to a newline-delimited messages file.",
                        }),
                    ),
                },
                { default: {}, additionalProperties: false },
            ),
        },
        { additionalProperties: false },
    ),
};

export default extensionSettingsInput;
