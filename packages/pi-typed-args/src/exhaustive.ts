/** Throw when a finite union grows without a corresponding branch update. */
export function casesHandled(unexpected: never): never {
    throw new Error(`Unhandled case: ${String(unexpected)}`);
}
