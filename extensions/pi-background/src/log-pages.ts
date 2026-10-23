import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

export type LogPage = {
    readonly index: number;
    readonly count: number;
    readonly size: number;
    readonly start: number;
    readonly end: number;
    readonly text: string;
};

export type LogPageTarget = number | "end";

function isContinuation(byte: number): boolean {
    return byte >= 0x80 && byte <= 0xbf;
}

/** Positional, bounded reads; no descriptor or previous page survives this call. */
export async function readLogPage(
    path: string,
    target: LogPageTarget,
    options: { readonly signal?: AbortSignal } = {},
): Promise<LogPage> {
    const { signal } = options;
    signal?.throwIfAborted();

    if (target !== "end" && (!Number.isSafeInteger(target) || target < 0))
        throw new RangeError("Invalid log page.");

    // Nonblocking open avoids hanging on a replaced log that is now a FIFO.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

    try {
        signal?.throwIfAborted();
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Log must be a regular file.");
        if (!Number.isSafeInteger(stat.size))
            throw new Error("Log size is not a safe byte offset.");

        let count = Math.max(1, Math.ceil(stat.size / DEFAULT_MAX_BYTES));
        const remainder = stat.size % DEFAULT_MAX_BYTES;

        // A final scalar may belong wholly to the previous aligned page.
        if (count > 1 && remainder > 0 && remainder <= 3) {
            const tail = Buffer.alloc(remainder);
            signal?.throwIfAborted();
            const { bytesRead } = await file.read(tail, 0, remainder, stat.size - remainder);
            signal?.throwIfAborted();
            if (bytesRead === remainder && tail.every(isContinuation)) count -= 1;
        }

        let index = count - 1;
        if (target !== "end") index = Math.min(target, count - 1);

        const offset = index * DEFAULT_MAX_BYTES;

        // Three lookahead bytes complete a UTF-8 scalar crossing a nominal boundary.
        const buffer = Buffer.alloc(Math.min(DEFAULT_MAX_BYTES + 3, stat.size - offset));
        let length = 0;
        while (length < buffer.length) {
            signal?.throwIfAborted();

            const { bytesRead } = await file.read(
                buffer,
                length,
                buffer.length - length,
                offset + length,
            );

            signal?.throwIfAborted();
            if (bytesRead === 0) break;

            length += bytesRead;
        }

        let start = 0;
        if (offset > 0) {
            while (start < Math.min(3, length) && isContinuation(buffer[start])) start += 1;
        }

        let end = Math.min(DEFAULT_MAX_BYTES, length);
        while (end < length && isContinuation(buffer[end])) end += 1;

        // Do not parse escape sequences: a sequence can cross any byte page boundary.
        // Neutralize every control introducer independently, leaving printable Unicode intact.
        const text = buffer
            .subarray(start, end)
            .toString("utf8")
            .replace(/\p{Cc}/gu, (character) => {
                if (character === "\n" || character === "\t") return character;
                if (character === "\u001b") return "␛";
                return " ";
            });

        signal?.throwIfAborted();
        return { index, count, size: stat.size, start: offset + start, end: offset + end, text };
    } finally {
        // FileHandle.read has no AbortSignal: at most one bounded read must finish on cancel.
        await file.close();
    }
}
