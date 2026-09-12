import { defineConfig } from "vitest/config";

// Unresolved acceptance contracts, not inverted assertions or silently skipped tests.
// These stay out of the default green lane until the corresponding defects are fixed.
export default defineConfig({
    test: {
        include: ["test/audit/*.regression.ts"],
        testTimeout: 15_000,
    },
});
