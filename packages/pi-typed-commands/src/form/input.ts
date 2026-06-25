import { decodeKittyPrintable, type Input } from "@earendil-works/pi-tui";
import type { ArgumentDefinition } from "../types.js";

type InputCursorState = {
    cursor?: unknown;
};

/** Return the current cursor offset from Pi TUI's input widget, falling back to end-of-value. */
export function inputCursor(input: Input): number {
    const cursor = (input as unknown as InputCursorState).cursor;
    if (typeof cursor === "number") {
        return cursor;
    }
    return input.getValue().length;
}

/** Set Pi TUI's input cursor to a bounded offset. */
export function setInputCursor(input: Input, cursor: number): void {
    const boundedCursor = Math.max(0, Math.min(cursor, input.getValue().length));
    (input as unknown as { cursor: number }).cursor = boundedCursor;
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
    if (definition.integer === true) {
        return new RegExp(`^${signPattern}\\d*$`).test(value);
    }
    return new RegExp(`^${signPattern}(?:\\d+|\\d*\\.\\d*)?$`).test(value);
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

/** Restore a number input's previous value and cursor when a raw key event creates an invalid prefix. */
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

/** Set an input widget's value and move the cursor to the end. */
export function setInputValueAtEnd(input: Input, value: string): void {
    input.setValue(value);
    setInputCursor(input, value.length);
}
