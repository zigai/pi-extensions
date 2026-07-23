import { readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { SettingsControl } from "./settings-schema.ts";

type NumberControl = Extract<SettingsControl, { readonly _tag: "NumberControl" }>;

export type PathCompletionOutcome =
    | { readonly _tag: "PathCompleted"; readonly value: string }
    | {
          readonly _tag: "PathMatches";
          readonly value: string;
          readonly matches: readonly string[];
      }
    | { readonly _tag: "PathUnavailable"; readonly message: string };

function numberStep(control: NumberControl): number {
    const multiple = control.multipleOf;
    if (multiple !== undefined && multiple > 0) return multiple;
    return control.integer ? 1 : 0.1;
}

function numberBounds(control: NumberControl): {
    readonly minimum: number | undefined;
    readonly maximum: number | undefined;
} {
    const step = numberStep(control);
    return {
        minimum:
            control.minimum ??
            (control.exclusiveMinimum === undefined ? 0 : control.exclusiveMinimum + step),
        maximum:
            control.maximum ??
            (control.exclusiveMaximum === undefined ? 100 : control.exclusiveMaximum - step),
    };
}

function normalizeNumber(value: number): number {
    return Number(value.toPrecision(15));
}

/** Move a numeric settings value by its schema step while respecting its bounds. */
export function stepSettingsNumber(
    control: NumberControl,
    current: number | undefined,
    direction: -1 | 1,
): number {
    const bounds = numberBounds(control);
    if (current === undefined) return normalizeNumber(bounds.minimum ?? 0);
    let value = current;
    value = normalizeNumber(value + numberStep(control) * direction);
    if (bounds.minimum !== undefined) value = Math.max(bounds.minimum, value);
    if (bounds.maximum !== undefined) value = Math.min(bounds.maximum, value);
    return normalizeNumber(value);
}

/** Render the compact bounded-number bar used by slider controls. */
export function formatSliderValue(control: NumberControl, value: number): string {
    const bounds = numberBounds(control);
    if (bounds.minimum === undefined || bounds.maximum === undefined) return String(value);
    const range = bounds.maximum - bounds.minimum;
    const ratio = range <= 0 ? 0 : (value - bounds.minimum) / range;
    const segmentCount = 8;
    const filled = Math.max(0, Math.min(segmentCount, Math.round(ratio * segmentCount)));
    return `${value} [${"█".repeat(filled)}${"░".repeat(segmentCount - filled)}]`;
}

/** Render a true-color terminal swatch for a CSS-style hexadecimal color. */
export function colorSwatch(value: string): string | undefined {
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(value);
    const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/iu.exec(value);
    let channels: readonly string[] | undefined;
    if (short !== null) {
        channels = short.slice(1).map((channel) => `${channel}${channel}`);
    } else if (full !== null) {
        channels = full.slice(1, 4);
    }
    if (channels === undefined) return undefined;
    const [red, green, blue] = channels.map((channel) => Number.parseInt(channel, 16));
    if (red === undefined || green === undefined || blue === undefined) return undefined;
    return `\u001b[48;2;${red};${green};${blue}m  \u001b[0m`;
}

function commonPrefix(values: readonly string[]): string {
    const first = values[0] ?? "";
    let length = first.length;
    for (const value of values.slice(1)) {
        length = Math.min(length, value.length);
        let index = 0;
        while (index < length && first[index] === value[index]) index += 1;
        length = index;
    }
    return first.slice(0, length);
}

function pathDirectory(
    input: string,
    cwd: string,
): {
    readonly displayDirectory: string;
    readonly entryPrefix: string;
    readonly resolvedDirectory: string;
} {
    const separator = input.lastIndexOf("/");
    const displayDirectory = separator === -1 ? "" : input.slice(0, separator + 1);
    const entryPrefix = separator === -1 ? input : input.slice(separator + 1);
    let resolvedDirectory: string;
    if (displayDirectory.startsWith("~/")) {
        resolvedDirectory = resolve(homedir(), displayDirectory.slice(2));
    } else if (displayDirectory.startsWith("/")) {
        resolvedDirectory = resolve(displayDirectory);
    } else {
        resolvedDirectory = resolve(cwd, displayDirectory || ".");
    }
    return { displayDirectory, entryPrefix, resolvedDirectory };
}

/** Complete a path relative to the active Pi working directory. */
export function completeSettingsPath(input: string, cwd: string): PathCompletionOutcome {
    if (input === "~") return { _tag: "PathCompleted", value: "~/" };
    const directory = pathDirectory(input, cwd);
    let entries: Dirent<string>[];
    try {
        entries = readdirSync(directory.resolvedDirectory, { withFileTypes: true });
    } catch {
        return {
            _tag: "PathUnavailable",
            message: "That path cannot be read or does not exist.",
        };
    }
    const matches = entries
        .filter(
            (entry) =>
                entry.name.startsWith(directory.entryPrefix) &&
                (directory.entryPrefix.startsWith(".") || !entry.name.startsWith(".")),
        )
        .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
        .sort((left, right) => left.localeCompare(right));
    if (matches.length === 0) {
        return { _tag: "PathUnavailable", message: "No matching paths." };
    }
    if (matches.length === 1) {
        return {
            _tag: "PathCompleted",
            value: `${directory.displayDirectory}${matches[0] ?? ""}`,
        };
    }
    const prefix = commonPrefix(matches);
    return {
        _tag: "PathMatches",
        value: `${directory.displayDirectory}${prefix}`,
        matches: matches.map((match) => `${directory.displayDirectory}${match}`),
    };
}
