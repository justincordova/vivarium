/**
 * layering.test.ts — the architectural purity guard with no other automated owner.
 *
 * The whole design rests on the layering direction `sim → worker → render → ui`: outer
 * layers may import inner, NEVER the reverse. `src/sim/` is the pure core — it must import
 * nothing from `worker/`, `render/`, `ui/`, or `store/`.
 *
 * The existing three guards each miss this specific violation:
 *   - the headless runner crashes only on a DOM/React import (a *pure* helper pulled up
 *     from `worker/` would sail through),
 *   - Biome's `noRestrictedGlobals` targets globals (`window`), not cross-layer imports,
 *   - the determinism test catches non-determinism, not a layer inversion that stays
 *     deterministic.
 *
 * So this test is the sole gate on "sim/ never imports an outer layer". It scans every
 * source file under `src/sim/` for an import (aliased `@worker`/`@render`/`@ui`/`@store`
 * or a relative `../worker` etc.) and fails loudly on any hit.
 */

import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SIM_DIR = new URL("../../src/sim/", import.meta.url);

// Matches `from "@worker/..."`, `from "../render/..."`, `import("@ui/...")`, etc. The
// alias forms and the relative forms both count — either would invert the layering.
const OUTER_IMPORT =
  /\b(?:from|import)\s*\(?\s*["'](?:@(?:worker|render|ui|store)\b|(?:\.\.\/)+(?:worker|render|ui|store)\/)/;

async function simSourceFiles(): Promise<string[]> {
  const entries = await readdir(SIM_DIR);
  return entries.filter((f) => f.endsWith(".ts"));
}

describe("sim/ imports no outer layer (worker/render/ui/store)", () => {
  it("every src/sim/*.ts file is free of outer-layer imports", async () => {
    const files = await simSourceFiles();
    // Sanity: the scan actually found the sim sources (guards against a silent empty pass).
    expect(files.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const file of files) {
      const src = await readFile(new URL(file, SIM_DIR), "utf8");
      if (OUTER_IMPORT.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
