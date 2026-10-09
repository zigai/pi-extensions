// Version 1 protocol example. Read one JSON request on stdin.
// Search one million synthetic tickets using numeric prefix ranges, without enumerating the list.
import { readFileSync, writeFileSync } from "node:fs";

import { Type } from "typebox";
import { Value } from "typebox/value";

const requestSchema = Type.Union([
    Type.Object({
        version: Type.Literal(1),
        method: Type.Literal("discover"),
        sourceId: Type.String(),
        cwd: Type.String(),
        trusted: Type.Boolean(),
        query: Type.String(),
        path: Type.Array(Type.Unknown()),
        limit: Type.Number(),
        cursor: Type.Optional(Type.String()),
    }),
    Type.Object({
        version: Type.Literal(1),
        method: Type.Literal("resolve"),
        sourceId: Type.String(),
        cwd: Type.String(),
        trusted: Type.Boolean(),
        segments: Type.Array(Type.String()),
    }),
]);

const input = readFileSync(0, "utf8");
const request = Value.Parse(requestSchema, JSON.parse(input));

/** @param {number} id */
function ticket(id) {
    return {
        id: String(id),
        label: `Ticket ${id}`,
        segment: String(id),
        selectable: true,
        navigable: false,
        replacement: `issue tracker ticket #${id}`,
    };
}

/** @type {unknown} */
let result;
if (request.method === "resolve") {
    let value = "";
    if (request.segments.length === 1) value = request.segments[0] ?? "";

    const id = Number(value);
    if (/^[1-9]\d*$/.test(value) && id <= 1000000) {
        result = { status: "resolved", path: [ticket(id)] };
    } else {
        result = { status: "unresolved", reason: "missing" };
    }
} else {
    const cursor = Number(request.cursor ?? "1");
    const query = request.query.replace(/^Ticket\s+/i, "");

    /** @type {Array<[number, number]>} */
    const ranges = [];
    if (query === "") ranges.push([1, 1000000]);
    else if (/^[1-9]\d*$/.test(query)) {
        for (let scale = 1; Number(query) * scale <= 1000000; scale *= 10) {
            ranges.push([
                Number(query) * scale,
                Math.min((Number(query) + 1) * scale - 1, 1000000),
            ]);
        }
    }

    const limit = Math.min(request.limit, 100);

    /** @type {Array<ReturnType<typeof ticket>>} */
    const items = [];
    let nextCursor;
    for (const [start, end] of ranges) {
        for (let id = Math.max(start, cursor); id <= end; id += 1) {
            if (items.length === limit) {
                nextCursor = String(id);
                break;
            }

            items.push(ticket(id));
        }

        if (nextCursor !== undefined) break;
    }

    const discovery = { items };
    if (nextCursor !== undefined) Object.assign(discovery, { nextCursor });
    result = discovery;
}

writeFileSync(1, JSON.stringify({ version: 1, method: request.method, result }), "utf8");
