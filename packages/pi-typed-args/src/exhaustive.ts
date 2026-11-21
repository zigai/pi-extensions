export function casesHandled(unexpected: never): never {
    throw new Error(`Unhandled case: ${String(unexpected)}`);
}
