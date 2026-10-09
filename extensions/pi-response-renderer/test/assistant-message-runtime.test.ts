import assert from "node:assert/strict";
import { test } from "vitest";

import { assistantMessageRuntime } from "../src/assistant-message-runtime.ts";

const render = (): string[] => [];
const updateContent = (): void => {};

for (const [name, module] of [
    ["null namespace", null],
    ["absent namespace", undefined],
    ["scalar namespace", 1],
    ["missing export", {}],
    ["null export", { AssistantMessageComponent: null }],
    [
        "non-callable export",
        { AssistantMessageComponent: { prototype: { render, updateContent } } },
    ],
    ["arrow without prototype", { AssistantMessageComponent: () => {} }],
    ["null prototype", { AssistantMessageComponent: Object.assign(() => {}, { prototype: null }) }],
    ["missing methods", { AssistantMessageComponent: class {} }],
    [
        "missing updateContent",
        {
            AssistantMessageComponent: class {
                render(): string[] {
                    return [];
                }
            },
        },
    ],
    [
        "non-callable render",
        {
            AssistantMessageComponent: Object.assign(() => {}, {
                prototype: { render: 1, updateContent },
            }),
        },
    ],
    [
        "non-callable updateContent",
        {
            AssistantMessageComponent: Object.assign(() => {}, {
                prototype: { render, updateContent: 1 },
            }),
        },
    ],
    [
        "non-constructable callable with matching prototype",
        {
            AssistantMessageComponent: Object.assign(() => {}, {
                prototype: { render, updateContent },
            }),
        },
    ],
] as const) {
    test(`rejects ${name}`, () => {
        assert.equal(assistantMessageRuntime.parse(module), undefined);
    });
}

test("preserves constructor and prototype identity without executing the constructor", () => {
    let constructions = 0;

    class AssistantMessageComponent {
        constructor() {
            constructions += 1;
        }

        render(width: number): string[] {
            return [String(width)];
        }

        updateContent(): void {}
    }

    const parsed = assistantMessageRuntime.parse({ AssistantMessageComponent });
    assert.ok(parsed);
    assert.equal(parsed, AssistantMessageComponent);
    assert.equal(parsed.prototype, AssistantMessageComponent.prototype);
    assert.equal(constructions, 0);
    assert.deepEqual(new parsed().render(80), ["80"]);
    assert.equal(constructions, 1);
});
