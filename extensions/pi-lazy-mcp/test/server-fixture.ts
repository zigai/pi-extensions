import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { CallToolResult, InitializeResult } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { catalogSchema, type Catalog } from "../src/catalog.ts";
import { jsonObjectSchema } from "../src/json.ts";

const argsSchema = Type.Tuple([Type.String(), Type.String()]);
const [statePath, logPath] = Value.Parse(argsSchema, process.argv.slice(2));
const stateSchema = Type.Object({
    ...catalogSchema.properties,
    capabilities: Type.Optional(jsonObjectSchema),
    gate: Type.Optional(Type.Boolean()),
    closeGate: Type.Optional(Type.Boolean()),
    initializeDelayMs: Type.Optional(Type.Integer()),
    firstListDelayMs: Type.Optional(Type.Integer()),
    stdoutBanner: Type.Optional(Type.String()),
    startupStderr: Type.Optional(Type.String()),
    exitOnStart: Type.Optional(Type.Integer()),
});

const requestSchema = Type.Object({
    id: Type.Optional(Type.Integer()),
    method: Type.String(),
    params: Type.Optional(
        Type.Object({
            name: Type.Optional(Type.String()),
            arguments: Type.Optional(
                Type.Object({
                    mode: Type.Optional(Type.String()),
                    variable: Type.Optional(Type.String()),
                }),
            ),
        }),
    ),
});

const send = (id: number, result: InitializeResult | Catalog | CallToolResult): void => {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const state = () => Value.Parse(stateSchema, JSON.parse(readFileSync(statePath, "utf8")));

appendFileSync(logPath, `${JSON.stringify({ event: "start", pid: process.pid })}\n`);

const startup = state();
if (startup.startupStderr !== undefined) process.stderr.write(`${startup.startupStderr}\n`);
if (startup.stdoutBanner !== undefined) process.stdout.write(`${startup.stdoutBanner}\n`);
if (startup.exitOnStart !== undefined) process.exit(startup.exitOnStart);

let held: { id: number; result: CallToolResult } | undefined;
let count = 0;
let listed = false;
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
    const request = Value.Parse(requestSchema, JSON.parse(line));
    if (request.method === "tools/list")
        appendFileSync(logPath, `${JSON.stringify({ event: "list" })}\n`);

    if (request.id === undefined) return;

    const id = request.id;
    if (request.method === "initialize") {
        const config = state();
        if (config.gate === true) return;

        const result: InitializeResult = {
            protocolVersion: "2025-11-25",
            capabilities: config.capabilities ?? { tools: {} },
            serverInfo: { name: "sample", version: "1" },
        };
        if (config.instructions !== undefined) result.instructions = config.instructions;

        setTimeout(() => {
            send(id, result);
        }, config.initializeDelayMs ?? 0);
    } else if (request.method === "tools/list") {
        const config = state();
        let delay = 0;
        if (!listed) delay = config.firstListDelayMs ?? 0;

        listed = true;
        setTimeout(() => {
            send(id, { tools: config.tools });
        }, delay);
    } else if (request.method === "tools/call") {
        count += 1;
        appendFileSync(
            logPath,
            `${JSON.stringify({ event: "call", name: request.params?.name })}\n`,
        );

        const mode = request.params?.arguments?.mode;
        const result: CallToolResult = {
            content: [{ type: "text", text: "completed" }],
            structuredContent: { count, pid: process.pid },
        };
        if (mode === "invalid") {
            process.stdout.write("sample-private-payload: invalid JSON\n");
        } else if (mode === "hold") {
            held = { id, result };
        } else if (mode === "crash") {
            process.stderr.write("sample crash detail\n");
            process.exit(3);
        } else if (mode === "environment") {
            const variable = request.params?.arguments?.variable ?? "";
            send(id, {
                content: [{ type: "text", text: process.env[variable] ?? "(unset)" }],
            });
        } else if (mode === "announce") {
            const current = state();
            writeFileSync(
                statePath,
                JSON.stringify({
                    ...current,
                    tools: [...current.tools, { name: "added", inputSchema: {} }],
                }),
            );

            process.stdout.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
            );

            send(id, result);
        } else {
            send(id, result);

            if (mode === "release" && held !== undefined) {
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
