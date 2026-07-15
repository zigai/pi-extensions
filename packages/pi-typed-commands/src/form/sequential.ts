import { casesHandled } from "../exhaustive.js";
import { formatFlagName, toKebabCase } from "../names.js";
import { applyArgumentDefault, coerceArgumentValue, validateArgumentValue } from "../schema.js";
import { formatFormIssueMessage, shouldPromptArgument } from "../pi-tui/form-model.js";
import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentValue,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    FormMode,
    MultiEnumArgumentDefinition,
    NumberArgumentDefinition,
    ParsedCommandArguments,
    StringArgumentDefinition,
} from "../types.js";
import type { RegisteredTypedCommand } from "../pi/command-types.js";
import { formatIssues } from "../usage.js";
import { FORM_MESSAGE_OPTIONS, UNSET_OPTION } from "./constants.js";
import type { ArgumentFormContext } from "./context.js";

function currentValueText(value: ArgumentValue): string {
    if (value === undefined) {
        return "";
    }
    return String(value);
}

/** Sequential prompt-based argument form used outside TUI mode. */
export class SequentialArgumentForm<TDefinitions extends ArgumentDefinitions> {
    private readonly command: RegisteredTypedCommand<TDefinitions>;
    private readonly parsed: ParsedCommandArguments;
    private readonly mode: FormMode;
    private readonly ctx: ArgumentFormContext;
    private readonly signal: AbortSignal | undefined;
    private readonly state: Record<string, ArgumentValue>;

    constructor(
        command: RegisteredTypedCommand<TDefinitions>,
        parsed: ParsedCommandArguments,
        mode: FormMode,
        ctx: ArgumentFormContext,
        signal?: AbortSignal,
    ) {
        this.command = command;
        this.parsed = parsed;
        this.mode = mode;
        this.ctx = ctx;
        this.signal = signal;
        this.state = { ...parsed.values };
    }

    async run(): Promise<Record<string, ArgumentValue> | undefined> {
        if (this.parsed.issues.length > 0 && this.active()) {
            this.ctx.ui.notify(
                formatIssues(this.parsed.issues.map(formatFormIssueMessage)),
                "warning",
            );
        }

        for (const [name, definition] of Object.entries(this.command.args)) {
            if (!shouldPromptArgument(name, definition, this.mode, this.parsed)) {
                continue;
            }

            const completed = await this.promptArgument(name, definition);
            if (!completed) {
                return undefined;
            }
        }

        const messages = this.finalIssues();
        if (messages.length > 0 && this.active()) {
            this.ctx.ui.notify(formatIssues(messages), "error");
            return undefined;
        }

        if (!this.active()) {
            return undefined;
        }
        return this.state;
    }

    private active(): boolean {
        return this.signal?.aborted !== true;
    }

    private dialogOptions(): { signal?: AbortSignal } {
        if (this.signal === undefined) {
            return {};
        }
        return { signal: this.signal };
    }

    private async promptArgument(name: string, definition: ArgumentDefinition): Promise<boolean> {
        switch (definition.type) {
            case "string":
            case "number":
                return this.promptStringLike(name, definition);
            case "boolean":
                return this.promptBoolean(name, definition);
            case "enum":
                return this.promptEnum(name, definition);
            case "multi-enum":
                return this.promptMultiEnum(name, definition);
            default:
                return casesHandled(definition);
        }
    }

    private async promptEnum(name: string, definition: EnumArgumentDefinition): Promise<boolean> {
        const options = [...definition.values];
        if (definition.required !== true) {
            options.unshift(UNSET_OPTION);
        }

        const selected = await this.ctx.ui.select(
            `Set ${formatFlagName(name)}`,
            options,
            this.dialogOptions(),
        );
        if (!this.active() || selected === undefined) {
            return false;
        }

        if (selected === UNSET_OPTION) {
            this.state[name] = applyArgumentDefault(definition);
            return true;
        }

        this.state[name] = selected;
        return true;
    }

    private async promptBoolean(
        name: string,
        definition: BooleanArgumentDefinition,
    ): Promise<boolean> {
        const options = ["true", "false"];
        if (definition.required !== true) {
            options.push(UNSET_OPTION);
        }

        const selected = await this.ctx.ui.select(
            `Set ${formatFlagName(name)}`,
            options,
            this.dialogOptions(),
        );
        if (!this.active() || selected === undefined) {
            return false;
        }

        if (selected === UNSET_OPTION) {
            this.state[name] = applyArgumentDefault(definition);
            return true;
        }

        this.state[name] = selected === "true";
        return true;
    }

    private async promptMultiEnum(
        name: string,
        definition: MultiEnumArgumentDefinition,
    ): Promise<boolean> {
        const current = this.state[name];
        let placeholder = definition.placeholder ?? currentValueText(current);
        if (placeholder.length === 0) {
            placeholder = definition.values.join(",");
        }

        const title = `Set ${formatFlagName(name)} (current: ${currentValueText(current)})`;
        const input = await this.ctx.ui.input(title, placeholder, this.dialogOptions());
        if (!this.active() || input === undefined) {
            return false;
        }

        if (input.trim().length === 0) {
            return this.applyEmptyMultiEnumInput(name, definition, current);
        }

        const coerced = coerceArgumentValue(definition, input, name, FORM_MESSAGE_OPTIONS);
        if (!coerced.ok) {
            if (this.active()) this.ctx.ui.notify(coerced.issue.message, "error");
            return this.promptMultiEnum(name, definition);
        }

        const validation = validateArgumentValue(
            name,
            definition,
            coerced.value,
            FORM_MESSAGE_OPTIONS,
        );
        if (!validation.ok) {
            if (this.active()) this.ctx.ui.notify(validation.message, "error");
            return this.promptMultiEnum(name, definition);
        }

        this.state[name] = coerced.value;
        return true;
    }

    private async promptStringLike(
        name: string,
        definition: StringArgumentDefinition | NumberArgumentDefinition,
    ): Promise<boolean> {
        const current = this.state[name];
        const placeholder = definition.placeholder ?? currentValueText(current);

        const title = `Set ${formatFlagName(name)} (current: ${currentValueText(current)})`;
        const input = await this.ctx.ui.input(title, placeholder, this.dialogOptions());
        if (!this.active() || input === undefined) {
            return false;
        }

        if (input.trim().length === 0) {
            return this.applyEmptyTextInput(name, definition, current);
        }

        switch (definition.type) {
            case "string": {
                const validation = validateArgumentValue(
                    name,
                    definition,
                    input,
                    FORM_MESSAGE_OPTIONS,
                );
                if (!validation.ok) {
                    if (this.active()) this.ctx.ui.notify(validation.message, "error");
                    return this.promptStringLike(name, definition);
                }
                this.state[name] = input;
                return true;
            }
            case "number": {
                const numberValue = coerceArgumentValue(
                    definition,
                    input,
                    name,
                    FORM_MESSAGE_OPTIONS,
                );
                if (!numberValue.ok) {
                    if (this.active()) this.ctx.ui.notify(numberValue.issue.message, "error");
                    return this.promptStringLike(name, definition);
                }

                this.state[name] = numberValue.value;
                return true;
            }
            default:
                return casesHandled(definition);
        }
    }

    private async applyEmptyMultiEnumInput(
        name: string,
        definition: MultiEnumArgumentDefinition,
        current: ArgumentValue,
    ): Promise<boolean> {
        if (current !== undefined) {
            return true;
        }
        const defaultValue = applyArgumentDefault(definition);
        if (defaultValue !== undefined) {
            this.state[name] = defaultValue;
            return true;
        }
        if (definition.required === true) {
            if (this.active()) this.ctx.ui.notify(`${toKebabCase(name)} is required`, "error");
            return this.promptMultiEnum(name, definition);
        }
        this.state[name] = undefined;
        return true;
    }

    private async applyEmptyTextInput(
        name: string,
        definition: StringArgumentDefinition | NumberArgumentDefinition,
        current: ArgumentValue,
    ): Promise<boolean> {
        if (current !== undefined) {
            return true;
        }
        const defaultValue = applyArgumentDefault(definition);
        if (defaultValue !== undefined) {
            this.state[name] = defaultValue;
            return true;
        }
        if (definition.required === true) {
            if (this.active()) this.ctx.ui.notify(`${toKebabCase(name)} is required`, "error");
            return this.promptStringLike(name, definition);
        }
        this.state[name] = undefined;
        return true;
    }

    private finalIssues(): string[] {
        const messages: string[] = [];
        for (const [name, definition] of Object.entries(this.command.args)) {
            const validation = validateArgumentValue(
                name,
                definition,
                this.state[name],
                FORM_MESSAGE_OPTIONS,
            );
            if (!validation.ok) {
                messages.push(validation.message);
            }
        }
        return messages;
    }
}
