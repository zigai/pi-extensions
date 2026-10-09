import { defineConfig } from "vitest/config";

export default defineConfig({
    root: import.meta.dirname,
    test: {
        server: { deps: { external: ["typescript"] } },
    },
});
