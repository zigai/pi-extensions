import { decodeKittyPrintable, type Input } from "@earendil-works/pi-tui";
import type { ArgumentDefinition } from "../types.ts";

// Pi TUI's Input (1.6.0) keeps `cursor` private and has no public accessor or setter, so the form
// reads and writes that field by name and falls back to end-of-value when it is missing.
export function inputCursor(input: Input): number {
    const cursor: unknown = Reflect.get(input, "cursor");
    if (typeof cursor === "number") {
        return cursor;
    }

    return input.getValue().length;
}

export function setInputCursor(input: Input, cursor: number): void {
    const boundedCursor = Math.max(0, Math.min(cursor, input.getValue().length));
    Reflect.set(input, "cursor", boundedCursor);
}

function numberAllowsNegative(definition: ArgumentDefinition): boolean {
    return definition.type === "number" && (definition.min === undefined || definition.min < 0);
}

function numberInputPrefixIsValid(definition: ArgumentDefinition, value: string): boolean {
    if (definition.type !== "number") {
        return true;
    }

    if (value.length === 0) {
        return true;
    }

    let signPattern = "\\+?";
    if (numberAllowsNegative(definition)) {
        signPattern = "[+-]?";
    }

    return new RegExp(
        `^${signPattern}(?:\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d*)?|\\.\\d+(?:[eE][+-]?\\d*)?|\\.)?$`,
    ).test(value);
}

function printableInputText(data: string): string | undefined {
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
        return kittyPrintable;
    }

    let hasControlChars = false;
    for (const char of data) {
        const code = char.charCodeAt(0);
        if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
            hasControlChars = true;
            break;
        }
    }

    if (hasControlChars) {
        return undefined;
    }

    return data;
}

/** Filter a printable input chunk so number fields only accept syntactically possible prefixes. */
export function filterNumberInputData(
    definition: ArgumentDefinition,
    value: string,
    cursor: number,
    data: string,
): string | undefined {
    if (definition.type !== "number") {
        return data;
    }

    const printable = printableInputText(data);
    if (printable === undefined) {
        return undefined;
    }

    let nextValue = value;
    let nextCursor = cursor;
    let accepted = "";
    for (const char of printable) {
        const candidate = nextValue.slice(0, nextCursor) + char + nextValue.slice(nextCursor);
        if (!numberInputPrefixIsValid(definition, candidate)) {
            continue;
        }

        accepted += char;
        nextValue = candidate;
        nextCursor += char.length;
    }

    return accepted;
}

export function restoreNumberInputIfInvalid(
    input: Input,
    definition: ArgumentDefinition,
    previousValue: string,
    previousCursor: number,
): void {
    if (numberInputPrefixIsValid(definition, input.getValue())) {
        return;
    }

    input.setValue(previousValue);
    setInputCursor(input, previousCursor);
}

export function setInputValueAtEnd(input: Input, value: string): void {
    input.setValue(value);
    setInputCursor(input, value.length);
}
