import { defineConfig } from "vitest/config";

// FORK (docs/FORK.md): runs the *.live.test.ts files that vitest.config.ts leaves out.
export default defineConfig({
  test: {
    include: ["tests/**/*.live.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
