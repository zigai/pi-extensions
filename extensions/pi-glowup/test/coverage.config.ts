import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        exclude: ["test/pty/**"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: [
                "src/settings.prevalidated.ts",
                "src/rendering/syntax/bundled-language-names.ts",
            ],
            reportsDirectory: "coverage/in-process",
            reporter: ["text", "json", "json-summary", "html"],
            reportOnFailure: true,
        },
    },
});
