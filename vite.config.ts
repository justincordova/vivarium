import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@sim": fileURLToPath(new URL("./src/sim", import.meta.url)),
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url)),
      "@render": fileURLToPath(new URL("./src/render", import.meta.url)),
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
      "@store": fileURLToPath(new URL("./src/store", import.meta.url)),
    },
  },
  test: {
    // sim/ is pure — tests must run in Node, never jsdom (SPEC.md §Testing).
    // A test that passes because jsdom supplied a `window` has destroyed the
    // guarantee it was written to check.
    environment: "node",
    globals: true,
    // Many sim tests run hundreds–thousands of live ticks over a full population; a
    // single tick got heavier after the exploration fix + Allee rescue, so the 5s
    // default is too tight. 30s global default keeps the suite robust without per-test
    // annotations (the long-horizon determinism/serialize/gate properties set their own
    // larger explicit timeouts).
    testTimeout: 30_000,
    // These tests are CPU-bound sim runs. Running every heavy test file fully in
    // parallel starves them of cores and causes spurious timeouts, so cap concurrency
    // to half the machine — the long live-tick properties then get real CPU and finish
    // well inside their timeouts (determinism/gate are load-bearing, not flaky).
    maxWorkers: "50%",
    // Scaffold has no tests yet; real tests land in Phase 0.1+. Remove once
    // the first test exists if you want zero-test runs to fail.
    passWithNoTests: true,
    include: ["tests/**/*.test.ts"],
    benchmark: {
      include: ["tests/**/*.bench.ts"],
    },
  },
});
