// @ts-check
import { parentPort } from "node:worker_threads";

import { getEncoding } from "js-tiktoken";

/** @typedef {{ readonly id: number, readonly op: "count", readonly text: string }} CountRequest */
/** @typedef {{ readonly id: number, readonly op: "truncate", readonly text: string, readonly maxTokens: number }} TruncateRequest */
/** @typedef {CountRequest | TruncateRequest} TokenizerRequest */
/** @typedef {{ readonly encode: (text: string) => number[], readonly decode: (tokens: number[]) => string }} TokenEncoding */

/** @type {TokenEncoding} */
const tokenEncoding = getEncoding("o200k_base");

/** @param {string} text @param {number} maxTokens */
function truncateTextToTokenBudget(text, maxTokens) {
    if (maxTokens <= 0) return "";
    const tokens = tokenEncoding.encode(text);
    if (tokens.length <= maxTokens) return text;
    if (maxTokens <= 3) return tokenEncoding.decode(tokens.slice(0, maxTokens));
    const marker = "\n…\n";
    const markerTokens = tokenEncoding.encode(marker).length;
    const remaining = Math.max(1, maxTokens - markerTokens);
    const headCount = Math.ceil(remaining / 2);
    const tailCount = Math.floor(remaining / 2);
    const head = tokenEncoding.decode(tokens.slice(0, headCount));
    const tail = tokenEncoding.decode(tokens.slice(tokens.length - tailCount));
    return `${head}${marker}${tail}`;
}

/** @param {unknown} value @returns {value is TokenizerRequest} */
function isTokenizerRequest(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.id !== "number" || typeof record.op !== "string") {
        return false;
    }
    if (record.op === "count") {
        return typeof record.text === "string";
    }
    return (
        record.op === "truncate" &&
        typeof record.text === "string" &&
        typeof record.maxTokens === "number"
    );
}

/** @param {TokenizerRequest} request */
function handleTokenizerRequest(request) {
    if (request.op === "count") {
        parentPort?.postMessage({
            id: request.id,
            type: "result",
            value: tokenEncoding.encode(request.text).length,
        });
        return;
    }
    parentPort?.postMessage({
        id: request.id,
        type: "result",
        value: truncateTextToTokenBudget(request.text, request.maxTokens),
    });
}

parentPort?.on("message", (message) => {
    if (!isTokenizerRequest(message)) {
        return;
    }
    try {
        handleTokenizerRequest(message);
    } catch (cause) {
        parentPort?.postMessage({
            id: message.id,
            type: "error",
            error: cause instanceof Error ? cause.message : String(cause),
        });
    }
});

parentPort?.postMessage({ type: "ready" });
