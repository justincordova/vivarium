import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@sim": fileURLToPath(new URL("./src/sim", import.meta.url)),
    },
  },
  test: {
    // sim/ is pure — tests must run in Node, never jsdom (SPEC.md §Testing).
    // A test that passes because jsdom supplied a `window` has destroyed the
    // guarantee it was written to check.
    environment: "node",
    globals: true,
    // Scaffold has no tests yet; real tests land in Phase 0.1+. Remove once
    // the first test exists if you want zero-test runs to fail.
    passWithNoTests: true,
    include: ["tests/**/*.test.ts"],
    benchmark: {
      include: ["tests/**/*.bench.ts"],
    },
  },
});
