export async function captureConsoleWarnings(run: () => void | Promise<void>): Promise<string[]> {
    const originalWarn = console.warn;
    const warnings: string[] = [];

    console.warn = (...values: unknown[]): void => {
        warnings.push(values.map((value) => String(value)).join(" "));
    };

    try {
        await run();
    } finally {
        console.warn = originalWarn;
    }

    return warnings;
}
