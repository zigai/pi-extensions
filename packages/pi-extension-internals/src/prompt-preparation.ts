import type { BuildSystemPromptOptions, EventBus } from "@earendil-works/pi-coding-agent";

export type SystemPromptPreparation = (options: BuildSystemPromptOptions) => Promise<void>;
type PreparationQuery = { version: 1; accept(prepare: SystemPromptPreparation): void };

const PREPARATION_EVENT = "pi:system-prompt-preparation";

function isPreparationQuery(value: unknown): value is PreparationQuery {
    return (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1 &&
        "accept" in value &&
        typeof value.accept === "function"
    );
}

export function registerSystemPromptPreparation(
    events: EventBus,
    prepare: SystemPromptPreparation,
): () => void {
    return events.on(PREPARATION_EVENT, (value) => {
        if (isPreparationQuery(value)) value.accept(prepare);
    });
}

export async function prepareSystemPromptOptions(
    events: EventBus,
    options: BuildSystemPromptOptions,
): Promise<void> {
    const preparations: SystemPromptPreparation[] = [];

    events.emit(PREPARATION_EVENT, {
        version: 1,
        accept: (prepare: SystemPromptPreparation) => {
            if (typeof prepare === "function") preparations.push(prepare);
        },
    });

    for (const prepare of preparations) await prepare(options);
}
