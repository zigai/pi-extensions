import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { CallToolResult, InitializeResult } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { catalogSchema, type Catalog } from "../src/settings-input.ts";
import { jsonObjectSchema } from "../src/json.ts";

const argsSchema = Type.Tuple([Type.String(), Type.String()]);
const [statePath, logPath] = Value.Parse(argsSchema, process.argv.slice(2));
const stateSchema = Type.Object({
    ...catalogSchema.properties,
    capabilities: Type.Optional(jsonObjectSchema),
    gate: Type.Optional(Type.Boolean()),
    closeGate: Type.Optional(Type.Boolean()),
});

const requestSchema = Type.Object({
    id: Type.Optional(Type.Integer()),
    method: Type.String(),
    params: Type.Optional(
        Type.Object({
            name: Type.Optional(Type.String()),
            arguments: Type.Optional(Type.Object({ mode: Type.Optional(Type.String()) })),
        }),
    ),
});

const send = (id: number, result: InitializeResult | Catalog | CallToolResult): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const state = () => Value.Parse(stateSchema, JSON.parse(readFileSync(statePath, "utf8")));

appendFileSync(logPath, `${JSON.stringify({ event: "start", pid: process.pid })}\n`);

let held: { id: number; result: CallToolResult } | undefined;
let count = 0;
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
    const request = Value.Parse(requestSchema, JSON.parse(line));
    if (request.id === undefined) return;

    if (request.method === "initialize") {
        const config = state();
        if (config.gate === true) return;

        const result: InitializeResult = {
            protocolVersion: "2025-11-25",
            capabilities: config.capabilities ?? { tools: {} },
            serverInfo: { name: "sample", version: "1" },
        };
        if (config.instructions !== undefined) result.instructions = config.instructions;
        send(request.id, result);
    } else if (request.method === "tools/list") {
        send(request.id, { tools: state().tools });
    } else if (request.method === "tools/call") {
        count += 1;
        appendFileSync(
            logPath,
            `${JSON.stringify({ event: "call", name: request.params?.name })}\n`,
        );

        const result: CallToolResult = {
            content: [{ type: "text", text: "completed" }],
            structuredContent: { count, pid: process.pid },
        };
        if (request.params?.arguments?.mode === "invalid") {
            process.stdout.write("sample-private-payload: invalid JSON\n");
        } else if (request.params?.arguments?.mode === "hold") {
            held = { id: request.id, result };
        } else {
            send(request.id, result);

            if (request.params?.arguments?.mode === "release" && held !== undefined) {
                send(held.id, held.result);
                held = undefined;
            }
        }
    }
});

process.on("SIGTERM", () => {
    if (state().closeGate !== true) process.exit(0);
});

lines.on("close", () => {
    if (state().closeGate === true) setInterval(() => undefined, 1000);
    else process.exit(0);
});
