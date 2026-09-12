type PropertyReplay = {
    readonly seed?: number;
    readonly path?: string;
};

/** Replay only the selected property; shrinking paths are not portable across tests. */
export function propertyReplayParameters(): PropertyReplay {
    const rawSeed = process.env.FC_SEED;
    const path = process.env.FC_PATH;
    if (rawSeed === undefined) {
        if (path !== undefined) {
            throw new Error("FC_PATH requires FC_SEED and a single-property -t filter");
        }

        return { seed: 0x5eed_2026 };
    }

    const seed = Number(rawSeed);
    if (!/^-?\d+$/u.test(rawSeed) || !Number.isSafeInteger(seed)) {
        throw new Error("FC_SEED must be a safe integer copied from a fast-check failure");
    }

    return path === undefined ? { seed } : { seed, path };
}
