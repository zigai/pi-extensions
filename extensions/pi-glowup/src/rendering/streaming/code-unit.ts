import { reportExtensionDiagnostic } from "@zigai/pi-extension-internals";
import type {
    ScriptBlockFormatterInput,
    ScriptBlockFormatterOptions,
} from "../../tools/built-in/bash/formatter.ts";
import type { CodeStreamInput } from "./code-stream.ts";
import type { StatementUnit } from "./statement-worker.ts";
import { maskStatementLiterals } from "./literal-formatting.ts";

export type FormattedCodeUnit = {
    readonly text: string;
    readonly bodyIndent?: string;
    readonly applied?: true;
};

function dedent(code: string, indent: string): string {
    return code
        .split("\n")
        .map((line, index) => {
            if (index > 0 && indent.length > 0 && line.startsWith(indent))
                return line.slice(indent.length);

            return line;
        })
        .join("\n");
}

function markerFor(source: string): string {
    let index = 0;
    while (source.includes(`__glowup_unit_${index}__`)) index += 1;

    return `__glowup_unit_${index}__`;
}

function extracted(
    code: string,
    begin: string,
    end: string,
    header: boolean,
): FormattedCodeUnit | undefined {
    const lines = code.replace(/\r\n/gu, "\n").split("\n");
    const start = lines.findIndex((line) => line.trim() === begin);
    const finish = lines.findIndex((line) => line.trim() === end);
    if (start < 0 || finish <= start) return undefined;

    const rows = lines.slice(start + 1, finish);
    while (rows[0]?.trim() === "") rows.shift();
    while (rows.at(-1)?.trim() === "") rows.pop();
    let indent = /^\s*/u.exec(lines[start] ?? "")?.[0].length ?? 0;
    if (!header) {
        indent = Number.POSITIVE_INFINITY;
        for (const row of rows)
            if (row.trim().length > 0)
                indent = Math.min(indent, /^\s*/u.exec(row)?.[0].length ?? 0);

        if (!Number.isFinite(indent)) indent = 0;
    }

    const text = rows
        .map((row) => row.slice(indent))
        .join("\n")
        .trimEnd();
    if (!header) return { text };

    const bodyIndent = (/^[\t ]*/u.exec(lines[finish] ?? "")?.[0] ?? "").slice(indent);
    return { text, bodyIndent };
}

async function abortable(
    promise: Promise<string | undefined>,
    signal: AbortSignal,
): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const abort = (): void => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });

        if (signal.aborted) abort();

        void promise.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            () => {
                signal.removeEventListener("abort", abort);
                reject(new Error("Statement formatter rejected its input"));
            },
        );
    });
}

export async function formatCodeUnit(
    input: CodeStreamInput,
    language: string,
    unit: StatementUnit,
    signal: AbortSignal,
    targetIndent: string,
): Promise<FormattedCodeUnit> {
    const raw = input.source.slice(unit.start, unit.end);
    if (!unit.format || input.formatter === undefined) return { text: raw };

    const marker = markerFor(input.source);
    const literals = maskStatementLiterals(
        input.source,
        unit.start,
        unit.end,
        language,
        unit.literals ?? [],
        marker,
    );
    let code = dedent(literals.code, unit.indent);
    let comment = "//!";
    if (language === "python" || language === "bash") comment = "#";

    const begin = `${comment} ${marker}begin`;
    const end = `${comment} ${marker}end`;
    let wrapped = false;
    if (unit.scaffold !== undefined) {
        let placeholder = unit.scaffold.body ?? "__glowup_placeholder__();";
        let bodyIndent = "";
        if (language === "python") {
            placeholder = unit.scaffold.body ?? "pass";
            bodyIndent = "    ";
        }

        if (language === "bash" && unit.scaffold.body === undefined) placeholder = ":";

        const contextIndent = unit.scaffold.indent ?? "";
        const header = code
            .split("\n")
            .map((line) => contextIndent + line)
            .join("\n");
        const body = `${contextIndent}${bodyIndent}${end}\n${contextIndent}${bodyIndent}${placeholder}`;
        code = `${unit.scaffold.before}${contextIndent}${begin}\n${header}\n${body}${unit.scaffold.after}\n`;
        if (unit.context !== undefined) code = unit.context.before + code + unit.context.after;
        wrapped = true;
    } else if (unit.context !== undefined) {
        code = `${unit.context.before}${begin}\n${code}\n${end}\n${unit.context.after}`;
        wrapped = true;
    } else if (
        language === "python" &&
        (unit.indent.length > 0 || /^(?:return|break|continue)_statement$/u.test(unit.kind))
    ) {
        code = `async def __glowup_context__():\n    while True:\n        ${begin}\n${code
            .split("\n")
            .map((line) => `        ${line}`)
            .join("\n")}\n        ${end}\n`;
        wrapped = true;
    } else if (
        ["javascript", "typescript", "tsx"].includes(language) &&
        /^(?:return|break|continue)_statement$/u.test(unit.kind)
    ) {
        code = `async function* __glowup_context__() {\nwhile (true) {\n${begin}\n${code}\n${end}\n}\n}\n`;
        wrapped = true;
    }

    let formatted: string | undefined;

    try {
        let formatterInput: ScriptBlockFormatterInput = {
            label: input.path ?? language,
            language,
            code,
        };
        let formatterOptions: ScriptBlockFormatterOptions = { signal };
        if (input.targetWidth !== undefined) {
            formatterInput = { ...formatterInput, targetWidth: input.targetWidth };
            formatterOptions = { ...formatterOptions, targetWidth: input.targetWidth };
        }

        formatted = await abortable(input.formatter(formatterInput, formatterOptions), signal);
    } catch {
        reportExtensionDiagnostic(
            "[pi-glowup] Statement display formatter failed; preserving this unit's original text.",
        );
    }

    if (formatted === undefined || signal.aborted) return { text: raw };

    let result: FormattedCodeUnit = {
        text: formatted.replace(/\r\n/gu, "\n").replace(/\n+$/u, ""),
    };
    if (wrapped) {
        const value = extracted(formatted, begin, end, unit.scaffold !== undefined);
        if (value === undefined) {
            reportExtensionDiagnostic(
                "[pi-glowup] Display formatter did not preserve private structural markers; preserving this unit's original text.",
            );
            return { text: raw };
        }

        result = value;
    }

    if (result.text.trim().length === 0) return { text: raw };

    const indented = result.text
        .split("\n")
        .map((line, index) => {
            if (index === 0) return line;
            return targetIndent + line;
        })
        .join("\n");
    const text = literals.restore(indented);
    if (text === undefined) {
        reportExtensionDiagnostic(
            "[pi-glowup] Display formatter did not preserve private literal markers; preserving this unit's original text.",
        );
        return { text: raw };
    }

    if (result.bodyIndent !== undefined)
        return { text, bodyIndent: targetIndent + result.bodyIndent, applied: true };

    return { text, applied: true };
}
