import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { type InputCorrectionsContext } from "./index.ts";

type Handlers = {
    session_start: () => void;
    session_shutdown: () => void;
    input: (event: InputEvent, ctx: InputCorrectionsContext) => InputEventResult;
};

class InputHost {
    handlers: Partial<Handlers> = {};

    on<K extends keyof Handlers>(event: K, handler: Handlers[K]) {
        this.handlers[event] = handler;

        return () => {
            delete this.handlers[event];
        };
    }

    input(
        text: string,
        ctx: InputCorrectionsContext,
        source: InputEvent["source"] = "interactive",
        images?: InputEvent["images"],
    ) {
        const result = this.handlers.input?.({ type: "input", text, source, images }, ctx);
        if (result === undefined) throw new Error("input not registered");
        return result;
    }
}

// Compile-time proof that Pi's real registration surface accepts this entrypoint.
const piEntrypoint: (pi: ExtensionAPI) => void = extension;

let root: string;
let previousAgentDir: string | undefined;
let host: InputHost;
let context: InputCorrectionsContext;
let notifications: string[];
let globalPath: string;
let projectPath: string;
let policyPath: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-input-corrections-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const cwd = join(root, "project");
    globalPath = join(root, "agent", "extension-settings", "pi-input-corrections.json");
    projectPath = join(cwd, ".pi", "extension-settings", "pi-input-corrections.json");
    mkdirSync(join(root, "agent", "extension-settings"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "extension-settings"), { recursive: true });
    policyPath = join(root, "agent", "extension-settings", "policy.json");
    writeFileSync(policyPath, '{"version":1,"rules":[]}');
    writeFileSync(globalPath, JSON.stringify({ policyFile: "./policy.json" }));
    notifications = [];
    context = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => true,
        ui: {
            notify: (message) => {
                notifications.push(message);
            },
        },
    };
    host = new InputHost();
    extension(host);
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

    rmSync(root, { recursive: true, force: true });
});

const prompt = "can you help'";

describe("Pi input lifecycle with real isolated settings files", () => {
    it("registers a valid Pi entrypoint and preserves images by identity", () => {
        expect(piEntrypoint).toBe(extension);
        const images: NonNullable<InputEvent["images"]> = [
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ];

        const result = host.input(prompt, context, "interactive", images);
        expect(result).toEqual({ action: "transform", text: "can you help?", images });

        if (result.action !== "transform") throw new Error("expected transform");

        expect(result.images).toBe(images);
        expect(host.input("already correct?", context)).toEqual({ action: "continue" });
    });

    it("does no settings I/O at registration, reset, shutdown or noninteractive input", () => {
        rmSync(globalPath);
        host.handlers.session_start?.();
        expect(host.input(prompt, context, "rpc")).toEqual({ action: "continue" });
        expect(host.input(prompt, context, "extension")).toEqual({ action: "continue" });
        host.handlers.session_shutdown?.();
        expect(() => readFileSync(globalPath)).toThrow();
        expect(notifications).toEqual([]);
    });

    it("loads a full personal allowlist and rejects an oversized layer without rewriting it", () => {
        const rules = Array.from({ length: 512 }, (_, index) => ({
            name: `Correction ${index}`,
            kind: "word",
            find: `wrong${index}`,
            replacement: `right${index}`,
        }));
        writeFileSync(
            policyPath,
            JSON.stringify({ version: 1, trailingQuestionMark: false, rules }),
        );

        expect(host.input("please correct wrong511", context)).toMatchObject({
            action: "transform",
            text: "please correct right511",
        });

        expect(notifications).toEqual([]);

        rules.push({ name: "One too many", kind: "word", find: "overflow", replacement: "fixed" });
        const oversized = JSON.stringify({ version: 1, rules });
        writeFileSync(policyPath, oversized);
        host.handlers.session_start?.();
        expect(host.input("please correct overflow", context)).toEqual({ action: "continue" });
        expect(notifications).toHaveLength(1);
        expect(readFileSync(policyPath, "utf8")).toBe(oversized);
    });

    it("caches disabled settings until reset, then reloads; shutdown clears cache", () => {
        writeFileSync(globalPath, '{"enabled":false}');
        expect(host.input(prompt, context)).toEqual({ action: "continue" });
        writeFileSync(globalPath, '{"enabled":true,"policyFile":"./policy.json"}');
        expect(host.input(prompt, context)).toEqual({ action: "continue" });
        host.handlers.session_start?.();
        expect(host.input(prompt, context).action).toBe("transform");
        writeFileSync(globalPath, '{"enabled":false}');
        host.handlers.session_shutdown?.();
        expect(host.input(prompt, context)).toEqual({ action: "continue" });
    });

    it("caches invalid settings and reports once without overwriting them", () => {
        const invalid = '{"enabled":"secret-value"}';
        writeFileSync(globalPath, invalid);
        host.input(prompt, context);
        host.input(prompt, context);
        expect(notifications).toHaveLength(1);
        expect(notifications.join()).not.toContain("secret-value");
        expect(readFileSync(globalPath, "utf8")).toBe(invalid);
        writeFileSync(globalPath, '{"enabled":false}');
        expect(host.input(prompt, context).action).toBe("continue");
        host.handlers.session_start?.();
        expect(host.input(prompt, context).action).toBe("continue");
    });

    it("reports non-UI diagnostics once and caches semantic rule failures", () => {
        writeFileSync(
            policyPath,
            JSON.stringify({
                version: 1,
                rules: [
                    { name: "secret-name", kind: "regex", find: "(", replacement: "secret-value" },
                ],
            }),
        );

        const errors: string[] = [];
        const originalError = console.error;
        vi.stubGlobal("console", { ...console, error: (message: string) => errors.push(message) });
        try {
            host.input(prompt, { ...context, hasUI: false });
            host.input(prompt, context);
            host.input(prompt, context);
            expect(errors).toHaveLength(1);
            expect(errors.join()).not.toContain("secret");
            expect(notifications).toEqual([]);
            writeFileSync(globalPath, '{"enabled":false}');
            expect(host.input(prompt, context).action).toBe("transform");
        } finally {
            vi.unstubAllGlobals();
            console.error = originalError;
        }
    });

    it("ignores even trusted project overrides and resolves policy beside personal config", () => {
        writeFileSync(
            policyPath,
            JSON.stringify({
                version: 1,
                trailingQuestionMark: false,
                rules: [{ name: "global", find: "help", replacement: "assist" }],
            }),
        );

        writeFileSync(projectPath, JSON.stringify({ enabled: false, policyFile: "missing.json" }));

        expect(host.input(prompt, context)).toMatchObject({
            action: "transform",
            text: "can you assist'",
        });

        host.handlers.session_start?.();
        expect(host.input(prompt, { ...context, isProjectTrusted: () => false })).toMatchObject({
            action: "transform",
            text: "can you assist'",
        });
    });
});

describe("personal policy selection", () => {
    it("does not let a trusted project enable corrections without personal opt-in", () => {
        writeFileSync(globalPath, "{}");
        writeFileSync(projectPath, JSON.stringify({ enabled: true, policyFile: policyPath }));
        expect(host.input(prompt, context)).toEqual({ action: "continue" });
        expect(notifications).toEqual([]);
    });

    it("rejects obsolete inline settings instead of keeping a second configuration format", () => {
        writeFileSync(
            globalPath,
            JSON.stringify({
                policyFile: policyPath,
                rules: [{ name: "old", find: "help", replacement: "assist" }],
            }),
        );

        expect(host.input(prompt, context)).toEqual({ action: "continue" });
        expect(notifications).toHaveLength(1);
    });

    it("caches compiled policy until session reset even when the file changes", () => {
        expect(host.input(prompt, context)).toMatchObject({ text: "can you help?" });
        writeFileSync(
            policyPath,
            JSON.stringify({
                version: 1,
                rules: [{ name: "new", find: "help", replacement: "assist" }],
            }),
        );

        expect(host.input(prompt, context)).toMatchObject({ text: "can you help?" });
        host.handlers.session_start?.();
        expect(host.input(prompt, context)).toMatchObject({ text: "can you assist?" });
    });
});
