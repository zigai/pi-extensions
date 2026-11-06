import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [...configDefaults.include, "test/platform-verification.check.ts"],
    coverage: { reporter: ["text"] },
  },
  root: import.meta.dirname,
});
