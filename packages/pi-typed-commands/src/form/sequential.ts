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
    StringListArgumentDefinition,
    KeyValueArgumentDefinition,
} from "../types.js";
import type { RegisteredTypedCommand } from "../pi/command-types.js";
import { formatIssues } from "../usage.js";
import { FORM_MESSAGE_OPTIONS, UNSET_OPTION } from "./constants.js";
import type { ArgumentFormContext } from "./context.js";

function currentValueText(value: ArgumentValue): string {
    if (value === undefined) {
        return "";
    }
    if (Array.isArray(value)) {
        return value.join(",");
    }
    if (typeof value === "object") {
        return Object.entries(value)
            .map(([key, entryValue]) => `${key}=${entryValue}`)
            .join(",");
    }
    if (typeof value === "number" && Object.is(value, -0)) {
        return "-0";
    }
    return String(value);
}

function evaluateFormBoolean(
    option: boolean | ((values: Readonly<Record<string, ArgumentValue>>) => boolean) | undefined,
    state: Readonly<Record<string, ArgumentValue>>,
): boolean {
    if (typeof option === "function") {
        return option({ ...state });
    }
    return option === true;
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
        for (const name of Object.keys(command.args)) {
            if (!Object.hasOwn(this.state, name) && Object.hasOwn(Object.prototype, name)) {
                Object.defineProperty(this.state, name, {
                    configurable: true,
                    enumerable: true,
                    value: undefined,
                    writable: true,
                });
            }
        }
    }

    async run(): Promise<Record<string, ArgumentValue> | undefined> {
        if (this.parsed.issues.length > 0 && this.active()) {
            this.ctx.ui.notify(
                formatIssues(this.parsed.issues.map(formatFormIssueMessage)),
                "warning",
            );
        }

        for (const [name, definition] of Object.entries(this.command.args)) {
            const copyFrom = definition.ui?.copyFrom;
            if (
                copyFrom !== undefined &&
                this.state[name] === undefined &&
                this.state[copyFrom] !== undefined
            ) {
                this.state[name] = this.state[copyFrom];
            }
            if (definition.ui?.compute !== undefined) {
                this.state[name] = definition.ui.compute({ ...this.state });
                continue;
            }
            if (
                evaluateFormBoolean(definition.ui?.hidden, this.state) ||
                (definition.ui?.visibleWhen !== undefined &&
                    !evaluateFormBoolean(definition.ui.visibleWhen, this.state)) ||
                evaluateFormBoolean(definition.ui?.readOnly, this.state) ||
                evaluateFormBoolean(definition.ui?.disabled, this.state) ||
                (definition.ui?.enabledWhen !== undefined &&
                    !evaluateFormBoolean(definition.ui.enabledWhen, this.state)) ||
                definition.ui?.widget === "readonly" ||
                definition.ui?.widget === "computed"
            ) {
                continue;
            }
            if (
                !shouldPromptArgument(name, definition, this.mode, this.parsed) &&
                !evaluateFormBoolean(definition.ui?.requiredWhen, this.state)
            ) {
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
            case "string-list":
            case "key-value":
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
            this.promptTitle(name, definition),
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
            this.promptTitle(name, definition),
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

        const title = `${this.promptTitle(name, definition)} (current: ${currentValueText(current)})`;
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
        definition:
            | StringArgumentDefinition
            | NumberArgumentDefinition
            | StringListArgumentDefinition
            | KeyValueArgumentDefinition,
    ): Promise<boolean> {
        const current = this.state[name];
        const placeholder = definition.placeholder ?? currentValueText(current);

        const title = `${this.promptTitle(name, definition)} (current: ${currentValueText(current)})`;
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
            case "number":
            case "string-list":
            case "key-value": {
                const coercedValue = coerceArgumentValue(
                    definition,
                    input,
                    name,
                    FORM_MESSAGE_OPTIONS,
                );
                if (!coercedValue.ok) {
                    if (this.active()) this.ctx.ui.notify(coercedValue.issue.message, "error");
                    return this.promptStringLike(name, definition);
                }

                this.state[name] = coercedValue.value;
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
        definition:
            | StringArgumentDefinition
            | NumberArgumentDefinition
            | StringListArgumentDefinition
            | KeyValueArgumentDefinition,
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
            if (
                evaluateFormBoolean(definition.ui?.requiredWhen, this.state) &&
                this.state[name] === undefined
            ) {
                messages.push(`${toKebabCase(name)} is required`);
                continue;
            }
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

    private promptTitle(name: string, definition: ArgumentDefinition): string {
        const title = definition.title ?? definition.ui?.title ?? formatFlagName(name);
        if (definition.description === undefined) {
            return `Set ${title}`;
        }
        return `Set ${title} — ${definition.description}`;
    }
}
