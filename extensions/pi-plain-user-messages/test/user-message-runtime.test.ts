import { expect, test } from "vitest";
import { userMessageRuntime } from "../src/user-message-runtime.ts";

const malformedExports: unknown[] = [
    null,
    undefined,
    1,
    {},
    { UserMessageComponent: null },
    { UserMessageComponent: { prototype: { render: () => [] } } },
    { UserMessageComponent: class {} },
    {
        UserMessageComponent: class {
            render = () => [];
        },
    },
    { UserMessageComponent: Object.assign(() => undefined, { prototype: { render: () => [] } }) },
    { UserMessageComponent: Object.assign(function invalid() {}, { prototype: { render: 1 } }) },
];

test.each(malformedExports)("rejects an incompatible user-message export %#", (value) => {
    expect(userMessageRuntime.parse(value)).toBeUndefined();
});

test("checks constructability without invoking the component or replacing its prototype", () => {
    let constructions = 0;

    class UserMessageComponent {
        constructor(_text: string) {
            constructions += 1;
        }

        render(_width: number): string[] {
            return ["message"];
        }
    }

    const parsed = userMessageRuntime.parse({ UserMessageComponent });
    expect(parsed).toBe(UserMessageComponent);
    expect(parsed?.prototype).toBe(UserMessageComponent.prototype);
    expect(constructions).toBe(0);
});
