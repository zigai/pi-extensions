import { Type } from "typebox";

import { compileSchema } from "../schema-parsing.ts";

const RetryHeadersDecoder = compileSchema(Type.Record(Type.String(), Type.Unknown()));
const RetryHeaderValueDecoder = compileSchema(
    Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);

const MAX_SCHEDULED_DELAY_MS = 2_147_483_647;
const UTC_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HTTP_DATE =
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Z][a-z]{2}-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

export function parseRetryAfterMs(
    value: string | null | undefined,
    nowMs: number,
): number | undefined {
    if (value === null || value === undefined || /[^\t\x20-\x7e]/.test(value)) return undefined;

    const normalized = value.trim();
    let delayMs: number;
    if (/^\d+$/.test(normalized)) {
        delayMs = Number(normalized) * 1000;
    } else if (HTTP_DATE.test(normalized)) {
        const dateMs = parseHttpDateMs(normalized);
        if (dateMs === undefined) return undefined;

        delayMs = Math.max(0, dateMs - nowMs);
    } else {
        return undefined;
    }

    if (!Number.isFinite(delayMs) || delayMs > MAX_SCHEDULED_DELAY_MS) return undefined;
    return delayMs;
}

function parseHttpDateMs(value: string): number | undefined {
    let dateText = value;
    if (!dateText.endsWith(" GMT")) dateText += " GMT";

    const dateMs = Date.parse(dateText);
    if (!Number.isFinite(dateMs)) return undefined;

    const date = new Date(dateMs);
    const canonical = date.toUTCString();
    let expected = canonical;

    if (!value.includes(",")) {
        const day = canonical.slice(5, 7).replace(/^0/, " ");

        expected = `${canonical.slice(0, 3)} ${canonical.slice(8, 11)} ${day} ${canonical.slice(17, 25)} ${canonical.slice(12, 16)}`;
    } else if (value.includes("-")) {
        expected = `${UTC_WEEKDAYS[date.getUTCDay()]}, ${canonical.slice(5, 7)}-${canonical.slice(8, 11)}-${canonical.slice(14, 16)} ${canonical.slice(17, 25)} GMT`;
    }

    if (value !== expected) return undefined;
    return dateMs;
}

export function parseRetryAfterHeaders(value: unknown, nowMs: number): number | undefined {
    const headers = RetryHeadersDecoder.decode(value);
    if (!headers) return undefined;

    let retryAfter: string | undefined;
    for (const name of Object.keys(headers).sort()) {
        if (name.toLowerCase() !== "retry-after") continue;

        const header = RetryHeaderValueDecoder.decode(headers[name]);
        if (header === undefined) continue;

        const text = String(header);
        if (/[^\t\x20-\x7e]/.test(text)) continue;
        retryAfter = text;
    }

    return parseRetryAfterMs(retryAfter, nowMs);
}
