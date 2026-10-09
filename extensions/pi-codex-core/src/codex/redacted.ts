import { inspect } from "node:util";

const REDACTED_TEXT = "[redacted]";

/** Immutable wrapper for secrets that must not be logged or serialized. */
export class Redacted<T> {
    readonly #value: T;

    private constructor(value: T) {
        this.#value = value;
    }

    /** Wrap a sensitive value at a boundary. */
    static of<T>(value: T): Redacted<T> {
        return new Redacted(value);
    }

    /** Reveal the wrapped secret only at the adapter that needs it. */
    reveal(): T {
        return this.#value;
    }

    toString(): string {
        return REDACTED_TEXT;
    }

    toJSON(): string {
        return REDACTED_TEXT;
    }

    [inspect.custom](): string {
        return REDACTED_TEXT;
    }
}
