import { defineConfig } from "vitest/config";

export default defineConfig({
    root: import.meta.dirname,
    test: {
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/cli-entry.ts"],
            thresholds: {
                branches: 90,
                functions: 95,
                lines: 95,
                statements: 95,
            },
        },
    },
});
