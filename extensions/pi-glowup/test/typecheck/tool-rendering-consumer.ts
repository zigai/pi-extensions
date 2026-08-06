import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    call,
    defineGlowupRenderer,
    output,
    text,
    withGlowupRendering,
} from "@zigai/pi-glowup/protocol";
import { Type } from "typebox";

type DemoArgs = {
    readonly query: string;
};

type DemoResult = {
    readonly details?: {
        readonly matches?: number;
    };
};

const rendering = defineGlowupRenderer<DemoArgs, DemoResult>({
    version: 3,
    parseArgs(value) {
        if (typeof value !== "object" || value === null || !("query" in value)) return undefined;
        return typeof value.query === "string" ? { query: value.query } : undefined;
    },
    parseResult(value) {
        if (typeof value !== "object" || value === null || !("details" in value)) return {};
        if (typeof value.details !== "object" || value.details === null) return {};
        const matches = "matches" in value.details ? value.details.matches : undefined;
        return typeof matches === "number" ? { details: { matches } } : { details: {} };
    },
    renderPartialCall() {
        return call({ static: "Demo Search", running: "Searching", completed: "Searched" });
    },
    renderCall(args) {
        return call(
            { static: "Demo Search", running: "Searching", completed: "Searched" },
            { body: text(args.query) },
        );
    },
    renderResult(result) {
        return output(`${result.details?.matches ?? 0} matches`);
    },
});

const tool = withGlowupRendering(
    defineTool({
        name: "demo_search",
        label: "Demo Search",
        description: "Search a deterministic demo index.",
        parameters: Type.Object({ query: Type.String() }),
        async execute(_toolCallId, params) {
            return {
                content: [{ type: "text", text: params.query }],
                details: { matches: 1 },
            };
        },
    }),
    rendering,
);

export function registerConsumerFixture(pi: ExtensionAPI): void {
    pi.registerTool(tool);
}
