import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    coverage: { reporter: ["text"] },
    include: ["test/platform-verification.check.ts"],
  },
};
