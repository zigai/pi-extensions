/** Generated npm package name. */
export const packageName = "@zigai/pi-extension-settings";

/** User-visible package title. */
export const packageTitle = "Pi Extension Settings";

/** Input accepted by `createGreeting`. */
export type GreetingInput = {
    /** Name to include in the greeting. Blank names are normalized to `world`. */
    readonly name: string;

    /** Whether to uppercase the generated greeting. */
    readonly excited?: boolean;
};

/** Create a small starter greeting. */
export function createGreeting(input: GreetingInput): string {
    const trimmedName = input.name.trim();
    const name = trimmedName === "" ? "world" : trimmedName;
    const greeting = `Hello, ${name}!`;

    return input.excited === true ? greeting.toUpperCase() : greeting;
}
