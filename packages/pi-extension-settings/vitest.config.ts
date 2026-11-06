import { defineConfig } from "vitest/config";

export default defineConfig({
    root: import.meta.dirname,
    test: {
        coverage: {
            reporter: ["text"],
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/cli-entry.ts"],
        },
    },
});
