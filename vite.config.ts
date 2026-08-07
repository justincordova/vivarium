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
    //
    // **Why the per-test timeouts look generous (300–480 s).** On an asymmetric CPU
    // (Apple silicon: performance + efficiency cores) "half the machine" still schedules
    // some workers onto E-cores, where the same sim run takes roughly 3× longer. A budget
    // calibrated on a P-core therefore fails at random depending on where the OS happened
    // to place that worker — which reads as flakiness but is pure scheduling. The budgets
    // below are sized for the E-core case.
    //
    // If one of these ever times out, the fix is NOT to shrink the tick counts or the
    // fast-check `numRuns`: those are the gate. Either pin the test to the modest world
    // (as `determinism.test.ts` `DET_WORLD` and its callers do — the invariants are
    // world-scale-agnostic) or raise the budget.
    maxWorkers: "50%",
    // Fail loudly on a zero-test run: the suite is the primary bug detector (determinism,
    // conservation, catch-up bit-identity), so an accidentally-empty run — e.g. a typo in
    // the include glob — must not pass green.
    passWithNoTests: false,
    include: ["tests/**/*.test.ts"],
    benchmark: {
      include: ["tests/**/*.bench.ts"],
    },
  },
});
