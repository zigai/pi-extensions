import { defineConfig } from "vitest/config";

export default defineConfig({
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
