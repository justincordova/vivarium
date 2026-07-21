# Phase 6 — Terrain Foundation Plan

> **Goal:** Add authored, seed-generated, immutable terrain (biomes + water bodies) to
> the sim as a rate-modulating layer, enlarge the world, render it, and (as a final
> gated batch) add terrain brain-sensing — all preserving determinism and the closed
> ledgers.
> **Design:** `docs/designs/living-world.md` (Phase 1). **Spec:** `docs/SPEC.md`
> §"Living World redesign".

## Invariants (do not violate)

- `sim/` imports nothing; terrain is read-only during `tick()`.
- Energy + water stay closed integer ledgers; terrain modulates rates only.
- Determinism is bit-exact: index-based iteration, no `Set`/`Object.keys` in `sim/`,
  new RNG draws only from a **named sub-stream**.
- Gate after every task: `pnpm build` → `pnpm test` → `pnpm lint`. Commit per task.

---

## Phase 6A: Terrain in the sim (no brain change)

**Gate:** terrain generated + serialized + modulating growth/movement; all existing
tests green (golden brain vector and determinism UNCHANGED because no sensor/RNG-order
change reaches the brain path); conservation holds.

### Task 1: Terrain data model
- **What:** A `Biome` enum + `Terrain` structure (typed arrays per cell) on the World.
- **Why:** Everything downstream reads it; define shape first.
- **How:**
  - In `src/sim/types.ts`: add
    `export enum Biome { Water=0, Grassland=1, Forest=2, Barren=3, Rock=4 }`
    and `export interface Terrain { biome: Uint8Array; elevation: Float32Array }`
    (both length `gridCols*gridRows`, row-major like `Fields`).
  - Add `terrain: Terrain` to `interface World` (next to `fields`).
  - Do NOT add to `Fields` (fields are ledger-bearing; terrain is not).
- **Verify:** `pnpm build` (types only; no behavior yet).

### Task 2: Terrain generation + `terrain` RNG sub-stream
- **What:** Deterministic terrain generator seeded from a new named sub-stream.
- **Why:** World creation needs terrain; must not perturb existing streams.
- **How:**
  - `src/sim/rng.ts`: add `terrain: 0x1b56c4e9` (a fresh unique salt) to
    `STREAM_SALT`, and add `"terrain"` to `RNG_STREAM_NAMES` (append at END so
    existing stream indices/derivation are unchanged). Add `"terrain"` to
    `RngStreamName` union in `types.ts`.
  - New file `src/sim/terrain.ts` (pure): `export function generateTerrain(cfg: Config,
    rng: RNG): Terrain`. Value-noise elevation (sum a few seeded sine/҂value octaves
    using `rng.next()` for offsets — NOT `Math.random`), then classify per cell:
    elevation below a low threshold → `Water`; a moisture proxy (distance to water +
    noise) splits mid land into `Grassland`/`Forest`; highest → `Rock`; a dry band →
    `Barren`. Deterministic, index-based loops only.
  - `src/sim/world.ts`: after `fields` seeding, call
    `world.terrain = generateTerrain(config, rng.terrain)`. Then **seed water bodies**:
    for each `Water` cell, transfer extra water from the reservoir up to a target via
    the existing `transfer`/`cellCompartment` helpers (conserved — drawn, never
    minted). Keep total initial water within the declared ledger (reduce the uniform
    `INITIAL_WATER_PER_CELL` fill so the sum is unchanged, OR draw the surplus from
    `solarReservoir`'s water counterpart — use whichever compartment currently backs
    water; confirm via `world.ts` water seeding at lines ~262-263).
- **Verify:** `pnpm build`; add `tests/sim/terrain.test.ts`: same seed → identical
  `biome`/`elevation` arrays (determinism); all biome values in 0..4; at least one
  Water and one non-Water cell for the default seed.

### Task 3: Save format v3 → v4 (serialize terrain)
- **What:** Persist terrain; migrate old saves.
- **Why:** Terrain is world state; a reload must restore the same map.
- **How:**
  - `src/sim/serialize.ts`: bump `SAVE_VERSION = 4`. Add `terrain?: { biome: number[];
    elevation: number[] }` to `SaveBlob`. Serialize `Array.from(world.terrain.biome)` /
    `elevation`. In `deserialize`, rebuild the typed arrays; add `migrateV3toV4(b)` to
    the `migrate` scaffold that, when `terrain` is absent, regenerates a **default
    all-grassland, flat** terrain sized to the blob's grid (biome filled `Grassland`,
    elevation 0) — matching today's uniform behavior (NOT a re-gen from seed, to keep
    old worlds visually stable).
  - RNG: `deserializeRng` already tolerates a missing `terrain` stream (`?? 0`); a
    reloaded world keeps its serialized terrain so the mulberry32(0) default is inert.
- **Verify:** `tests/sim/serialize.test.ts`: round-trip a world with terrain →
  identical arrays; a synthetic v3 blob (no `terrain`) loads → all-Grassland terrain,
  no throw; `version` reads 4.

### Task 4: Bigger world
- **What:** Enlarge the world + grid.
- **Why:** Terrain needs room to form regions; do AFTER gen works at small size.
- **How:** `src/sim/config.ts` `makeDefaultConfig`: `worldWidth/worldHeight` 200 →
  1000; `gridCols/gridRows` 64 → 128. Check `initialSolarReservoir` scales
  sufficiently (more cells draw more; bump proportionally if conservation/starvation
  tests reveal shortfall). Confirm spatial hash `cellSize` is world-relative
  (`src/sim/spatial.ts`) — no change expected.
- **Verify:** `pnpm test` (determinism/conservation must still pass at new size);
  `pnpm exec tsx scripts/headless.ts --ticks 200 --seed 1` runs without crash and pop
  stays > 0.

### Task 5: Terrain as selection pressure (rate modulation)
- **What:** Biomes modulate plant growth + movement; deep water impedes.
- **Why:** The point of terrain — must be ledger-safe.
- **How:** Add `src/sim/terrain.ts` pure helpers `growthMultiplier(biome): number`
  (Grassland 1.4, Forest 1.0, Barren 0.2, Rock 0, Water 0) and
  `moveCostMultiplier(biome): number` (Grassland 1, Forest 1, Barren 1, Rock 0.4 i.e.
  slower, Water 0.15 near-impassable).
  - Plant growth (`tick.ts` ~874): multiply `grow` by
    `growthMultiplier(world.terrain.biome[cell])` BEFORE `Math.min(..., headroom)`,
    still `toQuantum`-floored so the ledger stays integer. Draw amount == gain
    (unchanged transfer logic).
  - Movement (`tick.ts` ~533): scale `c.vx,c.vy` by
    `moveCostMultiplier(biome at c's cell)` before the position update. This changes
    only position (not any ledger). Cost transfer at ~536 unchanged.
  - Iterate deterministically; read terrain, never write it.
- **Verify:** extend `tests/sim/conservation.test.ts` — run N ticks in a terrained
  world, assert `totalEnergy`/`totalWater` exactly `===` before/after every tick;
  `pnpm test` green; a headless run shows plants sparse in Barren/Rock, dense in
  Grassland (spot-check via a small script or assertion on per-biome plant counts).

### Task 6: Terrain in the frame + biome/water rendering
- **What:** Ship terrain to the renderer; draw biomes + water bodies.
- **Why:** Make it visible; supersede the flat water underlay.
- **How:**
  - `src/worker/protocol.ts` `RenderFrame`: add `biome: Uint8Array` (per cell) and
    keep/replace `water` (now derived from real water cells). `src/worker/frame.ts`:
    copy `world.terrain.biome` into the frame; add `biome.buffer` to
    `frameTransferables`.
  - `src/render/canvas.ts`: replace `drawWater` with `drawTerrain` that fills each cell
    by biome (muted palette: grassland deep green-gray, forest darker green, barren
    tan, rock gray, water the existing blue), drawn under plants/creatures. Keep it a
    pure function of the frame; cull to viewport; perf-gate cell fills.
  - `src/ui/HelpLegend.tsx`: update the water row → a small biome legend.
- **Verify:** `pnpm build`; `tests/worker/frame.test.ts`: frame carries `biome`
  (Uint8Array, length cols*rows); `pnpm test tests/render` green; manual `pnpm dev`
  shows a varied map (deferred to user smoke-test).

---

## Phase 6B: Terrain brain-sensing (BREAKING geometry)

**Gate:** SENSORS raised, golden brain vector re-baselined, cold-open re-evolved, all
tests green. This is a separate phase because it invalidates the brain golden-vector
test and the shipped cold-open (design doc §"breaking brain-geometry change").

### Task 7: Add terrain sensory inputs (single geometry bump)
- **What:** Give the brain terrain awareness.
- **Why:** So movement/behavior can EVOLVE to terrain (drink pathing, biome pref).
- **How:**
  - `src/sim/constants.ts`: raise `SENSORS` (e.g. 18 → 21) for: local biome
    (normalized), water-direction (dx,dy toward nearest water), elevation gradient.
    Document each new sensor index in `brain.ts` §sensor layout (APPEND new indices at
    the end so existing arrow indices for old sensors are preserved where possible;
    note arrow COUNT changes regardless).
  - `src/sim/tick.ts` sense step (~line 250 / the sensor-fill block): populate the new
    sensor slots from `world.terrain` + nearest-water search (bounded, deterministic).
  - Re-baseline the golden vector in `tests/sim/brain.test.ts` (regenerate the expected
    array with the new geometry; this is the intentional, reviewed break).
  - `src/sim/serialize.ts`: this is a fresh-geometry world; ensure a pre-bump save
    loads as a new-geometry world (genome traits kept, brain wiring re-seeded) or is
    rejected cleanly — pick "load with re-seeded wiring" and document in the migration.
- **Verify:** `pnpm test` green with the re-baselined golden vector; determinism test
  passes at the new SENSORS; conservation unchanged.

### Task 8: Regenerate the cold-open
- **What:** Ship a pre-evolved terrained world.
- **Why:** First-time visitor must see a living, terrain-adapted world.
- **How:** Run `scripts/make-cold-open.ts` (the generator) under the new
  geometry/world size to produce `public/cold-open.viv.gz`. Confirm it deserializes at
  `version: 4` and boots via the landing "Enter the living world" path.
- **Verify:** `pnpm exec tsx scripts/make-cold-open.ts` succeeds; loading it in
  `pnpm dev` shows creatures using terrain (deferred to user smoke-test); prod build
  green.

---

## Final wrap-up (after 6A + 6B)
- `pnpm build && pnpm test && pnpm lint` all green; `pnpm bench` not regressed
  materially; headless purity run green.
- Suggest `sync-docs` to fold Phase 1 of the design into SPEC.md body sections.
