import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { UserMessageComponentInstance } from "./plain-markdown.ts";

export type UserMessageComponentPrototype = {
    render: (this: UserMessageComponentInstance, width: number) => string[];
};

type UserMessageComponentConstructor = {
    new (text: string, theme?: MarkdownTheme, outputPad?: number): UserMessageComponentInstance;
    readonly prototype: UserMessageComponentPrototype;
};

function isObjectIdentity(value: unknown): value is object {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Decode the private user-message export resolved from Pi's installed runtime. */
export const userMessageRuntime = {
    parse: (module: unknown): UserMessageComponentConstructor | undefined => {
        if (!isObjectIdentity(module) || !("UserMessageComponent" in module)) return undefined;

        const component = module.UserMessageComponent;
        if (typeof component !== "function" || !("prototype" in component)) return undefined;

        const prototype: unknown = component.prototype;
        if (
            !isObjectIdentity(prototype) ||
            !("render" in prototype) ||
            typeof prototype.render !== "function"
        ) {
            return undefined;
        }

        try {
            // Probe constructability without executing a foreign constructor.
            Reflect.construct(Object, [], component);
        } catch {
            return undefined;
        }
        // Pi 0.84.4 user-message.d.ts/js defines these constructor arguments and
        // render(width): string[], with Container state inspected by plain-markdown.ts.
        // The installed-runtime and malformed-export tests cover this private contract.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Export constructability and render are checked above; the resolved Pi user-message module establishes signatures and instance state that reflection cannot prove.
        return component as UserMessageComponentConstructor;
    },
};
