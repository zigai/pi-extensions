import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    call,
    defineGlowupRenderer,
    output,
    text,
    withGlowupRendering,
} from "@zigai/pi-glowup/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";

const demoArgsSchema = Type.Object({
    query: Type.String(),
});

const demoResultSchema = Type.Object({
    details: Type.Optional(
        Type.Object({
            matches: Type.Optional(Type.Number()),
        }),
    ),
});

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
        try {
            return Value.Parse(demoArgsSchema, value);
        } catch {
            return undefined;
        }
    },
    parseResult(value) {
        try {
            return Value.Parse(demoResultSchema, value);
        } catch {
            return { details: {} };
        }
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
