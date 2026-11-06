import { defineConfig } from "vitest/config";

export default defineConfig({
    root: import.meta.dirname,
    test: {
        coverage: { reporter: ["text"] },
        server: { deps: { external: ["typescript"] } },
    },
});
