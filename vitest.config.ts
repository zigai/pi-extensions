import { defineConfig } from "vitest/config";
import { isolatedDirectories } from "./scripts/workspace-tasks.ts";

// Imported package test scripts execute separately in their own cwd, preserving
// PTY, platform, coverage-threshold and package-specific fixture contracts.
export default defineConfig({
    test: {
        include: [
            "extensions/**/*.test.ts",
            "packages/pi-extension-internals/**/*.test.ts",
            "scripts/**/*.test.ts",
        ],
        exclude: [
            "**/node_modules/**",
            "**/dist/**",
            ...[...isolatedDirectories].map((directory) => `${directory}/**`),
        ],
        coverage: {
            provider: "v8",
            include: [
                "extensions/**/*.ts",
                "packages/pi-extension-internals/src/**/*.ts",
                "scripts/**/*.ts",
            ],
            exclude: [
                "**/test/**",
                "**/*.test.ts",
                ...[...isolatedDirectories].map((directory) => `${directory}/**`),
            ],
        },
    },
});
