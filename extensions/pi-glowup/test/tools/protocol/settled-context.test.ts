import { describe, expect, it } from "vitest";
import { call } from "../../../src/tools/protocol/contract.ts";
import { createProtocolRenderer } from "../../../src/tools/protocol/renderer.ts";
import type {
    ThirdPartyToolRenderContext,
    ThirdPartyToolRenderer,
} from "../../../src/tools/types.ts";

const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value };
const empty = { render: () => [], invalidate() {} };
const fallback: ThirdPartyToolRenderer = { renderCall: () => empty, renderResult: () => empty };
const base: ThirdPartyToolRenderContext = {
    args: {},
    toolCallId: "live-settlement",
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    isError: false,
    expanded: false,
    showImages: false,
};

describe("public settled-call context without forwarding live result payloads", () => {
    it.each([
        { name: "settled live call", patch: {}, expected: true },
        { name: "failed settled live call", patch: { isError: true }, expected: true },
        { name: "active execution", patch: { isPartial: true }, expected: false },
        { name: "incomplete arguments", patch: { argsComplete: false }, expected: false },
        {
            name: "pending call",
            patch: { executionStarted: false, isPartial: true },
            expected: false,
        },
        {
            name: "unstarted call without result",
            patch: { executionStarted: false },
            expected: false,
        },
        {
            name: "restored result",
            patch: { executionStarted: false, result: { content: [], details: {} } },
            expected: true,
        },
        { name: "explicit owner override", patch: { hasResult: false }, expected: false },
    ])("reports hasResult for $name", ({ patch, expected }) => {
        const observed: unknown[] = [];
        const renderer = createProtocolRenderer(
            {
                version: 3,
                parseArgs: (value) => value,
                renderCall(_args, context) {
                    observed.push(context);
                    return call({ static: "Demo" });
                },
            },
            fallback,
        );
        renderer.renderCall({}, theme, { ...base, ...patch }).render(80);
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ hasResult: expected });
    });
});
