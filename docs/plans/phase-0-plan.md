# Phase 0 — Invisible `sim/` Core Plan

> **Goal:** Build the entire pure `sim/` core (rule-based agents, no rendering) with
> determinism and energy/water conservation asserted by property tests, runnable
> headless from the terminal.
> **Spec:** `docs/SPEC.md` — see **Build Order** (Phase 0 row), **Architecture**,
> **Determinism**, **Energy**, **The Genome**, **Brain Design**, **Contests**,
> **The Tick Loop**, **Testing**.

## Scope & guardrails

- This plan covers **Phase 0 only**. Phases 1–5 are planned just-in-time, each in
  its own `docs/plans/<phase>-plan.md`, after the prior phase's gate is green.
- **Deliberate expansion beyond the literal Phase 0 build-order row.** SPEC.md's
  Phase 0 row (§Build Order) names `constants, types, rng, world, energy, genetics,
  tick, brain`. This plan also builds `spatial.ts`, `stats.ts`, and `serialize.ts`
  in Phase 0 because Phase 0's own gates require them: the conservation gate needs
  `stats.ts` (`totalEnergy`/`totalWater` live there per SPEC.md §Energy/§Water); the
  tick loop's sensors/contests need `spatial.ts`; and the roundtrip gate needs
  `serialize.ts`. All three are `sim/` files in the Architecture file list
  (SPEC.md §Key Components), so this is filling in the Phase 0 row, not adding scope.
- **Phase 0 has no runtime UI.** Output is population counts printed to the
  terminal. The throwaway debug canvas is deferred to the Phase 1 plan.
- **Standing UI directive (carries forward):** any future phase that builds a
  frontend surface — the Phase 2 canvas renderer, the Phase 3 sandbox
  (inspector, sliders, spawn/paint, follow-cam), and any charts/inspector work —
  **must load the `frontend-design` skill** before writing UI code. This does not
  apply to Phase 0 (no frontend), but is recorded here so the requirement is not
  lost across sessions.
- **The `sim/` purity rule is load-bearing** (SPEC.md §"The `sim/` purity rule"):
  `sim/` imports nothing — no React, no DOM, no `window`, no `Math.random()`.
  Every task below lives under `src/sim/` unless stated otherwise.
- **Invariant-first:** per SPEC.md §Testing, conservation + determinism tests are
  the primary bug detectors. Where a task produces a testable invariant, the test
  is written **with** the code and is that task's gate, not a later cleanup.
- **Never iterate a `Set` or `Object.keys()` in `sim/`** — all agent iteration is
  index-based over a stable ID array (SPEC.md §Determinism).

---

## Phase 0.0 — Project scaffold

**Gate:** `pnpm build` (tsc typecheck) and `pnpm test` (empty suite) both run
clean; `pnpm biome check` passes; the `sim/**` import-boundary lint override is
active; lefthook runs `biome check` pre-commit.

### Task 0.0.1: Initialize toolchain

- **What:** A pnpm + Vite + TypeScript project with Biome, Vitest (node), and
  lefthook wired per SPEC.md §Tooling.
- **Why:** Nothing compiles or tests without the scaffold; every later task
  depends on `pnpm test` and the purity lint existing.
- **How:**
  - `pnpm init`; add Vite, `typescript`, `@biomejs/biome`, `vitest`,
    `fast-check`, `lefthook` as dev deps (SPEC.md §Tooling — do not add ESLint,
    Prettier, jsdom).
  - `tsconfig.json`: `strict: true`, `moduleResolution: "bundler"`, path alias
    `@sim/* → src/sim/*` (Vitest reuses `vite.config.ts` so the alias works in
    tests).
  - `vite.config.ts` with a `test` block: `environment: 'node'` (SPEC.md §Testing
    — **never jsdom**), globals on.
  - `biome.json`: `indentStyle: "space"`; add the `overrides` block scoping
    `noRestrictedImports` (deny `react`, `react-dom`, `zustand`, `../ui/**`,
    `../render/**`) and `noRestrictedGlobals` (`window`, `document`) to
    `src/sim/**`. This is Layer 1 of the three-layer purity enforcement
    (SPEC.md §"The `sim/` purity rule").
  - `lefthook.yml`: pre-commit runs `biome check` only (tests run in CI, not the
    commit path).
  - `package.json` scripts: `build` (`tsc --noEmit`), `test` (`vitest run`),
    `bench` (`vitest bench`), `lint` (`biome check`).
  - Create empty dirs `src/sim/`, `tests/sim/`, `scripts/`.
- **Verify:** `pnpm build && pnpm test && pnpm biome check` all exit 0 on the
  empty project. Add a throwaway `src/sim/_smoke.ts` importing `react` and confirm
  `biome check` errors on it, then delete it (proves the boundary lint is live).

---

## Phase 0.1 — Vocabulary: constants & types

**Depends on:** Phase 0.0.
**Gate:** `pnpm build` typechecks; `pnpm biome check` clean; no runtime code yet.

### Task 0.1.1: `src/sim/constants.ts`

- **What:** Every named constant from the spec, with the units/comment discipline
  of SPEC.md §"Tick Semantics & Units."
- **Why:** Types and every downstream module reference these; they are the
  balancing vocabulary.
- **How:** Enumerate, grouped by subsystem, each with a one-line comment and
  `(tunable)` marker where the spec marks it:
  - Tick/time: `TICKS_PER_DAY`, `DAYS_PER_SEASON`, `MS_PER_TICK` (comment: chosen
    after Phase 1 bench), `MAX_OFFLINE_TICKS` (comment: chosen after bench).
  - Movement/kinematics: `MAX_TURN_RATE`, `MAX_ACCEL`, `K_SIZE`, `K_ARMOR`
    (SPEC.md §Actions — the mass/accel formula).
  - Brain: skeleton sizes `SENSORS=18`, `HIDDEN=10`, `ACTIONS=7`, `ARROWS=350`;
    `NEWBORN_ENABLE_FRAC≈0.15`; the pinned tanh rational-approximation constants;
    distance-metric coefficients.
  - Mutation: `WEIGHT_MUT_RATE`, `WEIGHT_MUT_SIGMA`, `ENABLE_ON_RATE`,
    `ENABLE_OFF_RATE`, `DRIFT_RATE`, `DRIFT_SIGMA=0.2`, `TRAIT_MUT_RATE`,
    `TRAIT_MUT_SIGMA` (per-gene), `HUE_MUT_RATE`, `HUE_DRIFT`, `MUT_GLOBAL`.
  - Energy/water: `LIGHT_DECAY`, `CORPSE_DECAY_FRACTION`, `PLANT_GROWTH_MAX`,
    `LIGHT_THRESHOLD`, `FERTILITY_THRESHOLD`.
  - Plant/creature maxima referents: `maxHealth`/`maxEnergy`/`maxHydration`
    coefficients, sensor normalizers (`TEMP_MIN/MAX`, `LIGHT_SENSOR_MAX`,
    `SCENT_SENSOR_MAX`, `WATER_CELL_MAX`, `FERTILITY_CELL_MAX`).
  - Contests: `REACH_BASE`, `REACH_PER_SIZE`, `k_speed`, `k_angle`.
  - Reach/sense are distinct (SPEC.md §Contests). Keep each value a plain literal;
    do not compute.
- **Verify:** `pnpm build` typechecks. A `tests/sim/constants.test.ts` asserts
  sanity relationships that must hold structurally (e.g. `ARROWS === SENSORS*HIDDEN
  + HIDDEN*HIDDEN + HIDDEN*ACTIONS`, i.e. `350 === 180+100+70`).

### Task 0.1.2: `src/sim/types.ts`

- **What:** All core data shapes and the sensor/action enums.
- **Why:** Every module operates on these; defining them wrong forces later
  rewrites of the save format.
- **How:** Define, matching the spec exactly:
  - `Genome` (SPEC.md §The Genome — diploid brain arrays + trait-gene pairs +
    `hue`), `PlantGenome` (SPEC.md §Plant Lifecycle — the typed block including
    `maxAge`).
  - `Creature` (id, `parentId` — SPEC.md §Lineage, position/heading, velocity,
    energy, hydration, health, age, genome, brain, derived-weights cache marked
    non-serialized), `Plant`, `Corpse` (energy but **no** hydration field —
    SPEC.md §Removal), field arrays.
  - `World` (creatures/plants/corpses as arrays + a stable ID array,
    `solarReservoir` as mutable integer, the gridded fields with ledger-bearing
    fields as `Int32Array`/`Uint32Array` and modulator fields as `Float32Array`
    per SPEC.md §Space & Fields, per-sub-stream RNG state, tick counter,
    `lastSavedRealTime`, event log).
  - `Config` (world dims, grid resolution, initial `solarReservoir` size, all
    tunables, RNG sub-stream layout — SPEC.md §Persistence: self-describing save).
  - `enum Sensor` (0–17) and `enum Action` (0–6) matching the exact indices in
    SPEC.md §Sensors and §Actions.
- **Verify:** `pnpm build` typechecks. No behavior yet.

---

## Phase 0.2 — Determinism substrate: RNG

**Depends on:** Phase 0.1.
**Gate:** two seeded runs of the same sub-stream produce identical sequences;
sub-stream state serializes and resumes mid-sequence.

### Task 0.2.1: `src/sim/rng.ts`

- **What:** `mulberry32` with the 7 named sub-streams and serializable state.
- **Why:** All stochastic code draws from these; the whole determinism guarantee
  rests here (SPEC.md §"RNG Discipline").
- **How:**
  - Implement `mulberry32(state: number)` returning `{ next(): number; state:
    number }` — the 32-bit state word is the entire serializable state.
  - Provide a `RNG` type and a bundle keyed by the 7 stream names: `motion`,
    `mutation`, `mating`, `resolve-shuffle`, `resolve`, `field-noise`, `spawn`.
  - `gaussian(rng)` helper (Box–Muller or similar) drawing from a passed stream.
  - Seed derivation: each sub-stream seeded deterministically from the world seed
    + a fixed per-stream salt so adding a consumer in one stream never perturbs
    another.
  - Serialize/deserialize the bundle as one integer per stream.
- **Verify:** `tests/sim/rng.test.ts` (fast-check where useful): same seed → two
  streams identical; drawing N then serializing then deserializing then drawing M
  equals a single N+M draw (mid-sequence resume); two different sub-streams from
  the same world seed are independent (interleaving one does not shift the other).

---

## Phase 0.3 — Spatial index

**Depends on:** Phase 0.1.
**Gate:** neighbor queries and `localDensity` return correct, deterministic
results.

### Task 0.3.1: `src/sim/spatial.ts`

- **What:** Hash-grid neighbor index + the single canonical `localDensity(pos)`.
- **Why:** Sensors (nearest food/threat/mate, density #11) and contest reach all
  query it; density-dependent removal and sensor #11 must share one function
  (SPEC.md §Removal, §Sensors).
- **How:**
  - Build/rebuild a hash grid over continuous positions; cell size a passed param.
  - `nearestWithin(pos, radius, predicate)` returning nearest by distance, **ties
    broken by ascending entity `id`** (SPEC.md §"What counts as food/threat/mate").
  - `localDensity(pos)` — count of living agents within a fixed radius; the
    exact-one density definition both sensor #11 and removal call.
  - No `Set`/`Object.keys` iteration; iterate the stable ID array.
- **Verify:** `tests/sim/spatial.test.ts`: known fixtures for nearest-with-tie
  (asserts id tiebreak), radius boundary inclusion/exclusion, density count.

---

## Phase 0.4 — Energy & water accounting + conservation harness

**Depends on:** Phase 0.1.
**Gate:** `totalEnergy`/`totalWater` sum every compartment exactly; the
conservation property test exists and passes on a static (non-ticked) world.

### Task 0.4.1: `src/sim/energy.ts` + `stats.ts` totals

- **What:** The authoritative `totalEnergy(world)` and `totalWater(world)`, plus
  the per-compartment transfer helpers used later by `tick.ts`.
- **Why:** SPEC.md §Energy makes conservation the primary bug detector; writing
  the totals + test **before** the tick loop means the loop is built against a
  live gate.
- **How:**
  - `totalEnergy(world)` = exact integer sum of `solarReservoir` + Σcreature +
    Σplant + Σcorpse + ΣfertilityField + ΣlightField (SPEC.md §Energy — the
    conserved quantity). Integer arithmetic only; no epsilon.
  - `totalWater(world)` = ΣwaterField + Σcreature.hydration **only** (SPEC.md
    §Water — corpses/plants excluded by construction).
  - Provide small typed transfer helpers (`moveEnergy(from, to, qty)` guarding
    non-negative, never-exceed-source) so later code cannot mint/destroy.
  - Place `totalEnergy`/`totalWater` where SPEC.md says (`stats.ts`), with
    `energy.ts` holding the transfer helpers/cost formulas.
- **Verify:** `tests/sim/conservation.test.ts`: construct a random static world
  (fast-check generator), assert totals equal the hand-summed compartments; assert
  a `moveEnergy` round-trip leaves the total unchanged and rejects
  over-transfer/mint.

---

## Phase 0.5 — Genetics

**Depends on:** Phase 0.1, 0.2.
**Gate:** Inheritance (sexual + clonal), distance-metric symmetry/zero-identity
property tests pass.

### Task 0.5.1: `src/sim/genetics.ts`

- **What:** Meiosis/gamete crossover, mutation, the expressed-brain genetic
  distance, and clonal plant reproduction.
- **Why:** `world.ts` (founders) and `tick.ts` (births) both call it; the
  Inheritance invariant is defined here.
- **How:**
  - `gamete(hA, hB, mA, mB, mating)` per SPEC.md §"Crossover, mutation, distance"
    (per-arrow independent homolog pick, no linkage v1). Child assembles one
    gamete from each parent into its two homologs; trait genes + `hue` segregate
    the same way.
  - `mutate(child, mutation)` per the SPEC.md §Mutation table (weight, enable
    on/off, disabled-arrow **homolog** drift with dirty-flag, trait per-allele,
    hue wrap-mod-360). All rates scaled by `MUT_GLOBAL`. Draws from the `mutation`
    stream only.
  - `plantSeed(parent, spawn, mutation)` — clonal: copy both homologs verbatim,
    then apply the same per-allele trait/hue mutation (SPEC.md §Plant Lifecycle,
    reproduction is asexual v1).
  - `distance(a, b)` on the **expressed** brain (mean weights, OR-ed masks):
    Euclidean over expressed weights + Hamming over expressed masks, weighted by
    the `constants.ts` coefficients (SPEC.md §"Genetic distance").
  - Expressed-value helpers: trait mean-of-alleles; brain derived
    `weights`/`enabled` (mean / OR) — used by both distance and the brain cache.
- **Verify:** `tests/sim/genetics.test.ts` (fast-check): **sexual Inheritance** —
  every child allele came from one of two parents (pre-mutation); **clonal
  Inheritance** — every plant-seed allele equals the single parent's allele
  (pre-mutation); **distance** — `distance(a,b)===distance(b,a)` and
  `distance(a,a)===0`.

---

## Phase 0.6 — Brain (rule-based)

**Depends on:** Phase 0.1, 0.2, 0.5.
**Gate:** `RuleBasedBrain` implements `BrainOps` deterministically; derived cache
re-derives on drift and is not serialized.

### Task 0.6.1: `src/sim/brain.ts`

- **What:** The `BrainOps<B>` interface and `RuleBasedBrain` (Phase 0's policy);
  the derived-weights cache machinery shared with the future `PatchbayBrain`.
- **Why:** `tick.ts` calls `BrainOps.think` without knowing the implementation;
  Phase 4 swaps in `PatchbayBrain` touching only this file (SPEC.md §Architecture,
  §"Why not NEAT").
- **How:**
  - Define `BrainOps<B>` exactly as SPEC.md §"Why not NEAT" (create/think/mutate/
    crossover/distance/serialize), with the doc'd rule: the single `rng: RNG`
    passed is always the specific named sub-stream (`create←spawn`,
    `mutate←mutation`, `crossover←mating`).
  - **Key clarification — brain arrays exist and evolve in Phase 0 even though the
    rule-based policy ignores them.** The diploid `Genome` carries
    `weightsA/B`/`enabledA/B` (350 arrows each) **from commit one** — brains are
    diploid from the first save (SPEC.md §The Genome), so the arrays are inherited,
    mutated, drifted, distance-measured, and serialized by `genetics.ts`/
    `serialize.ts` **regardless of which policy is active**. `RuleBasedBrain` only
    overrides `think` to ignore those arrays; its `create`/`mutate`/`crossover`/
    `distance` delegate to the shared genome machinery from Task 0.5.1. This is what
    makes the Phase 4 swap touch only `think` (SPEC.md §Architecture): the genetics,
    save format, and species distance are already exercising the real brain arrays
    in Phase 0. Do **not** stub the brain arrays out for Phase 0 — that would force
    a save-invalidating rewrite at Phase 4.
  - `RuleBasedBrain.think(senses)` — a fixed formula policy (SPEC.md §Initial
    Conditions: "enough to move toward food and toward mates"): steer toward
    nearest-food/mate angle, accelerate when hungry, fire `eat`/`drink`/`mate`
    when gated conditions met. Reads senses only; **ignores the brain weight
    arrays**. No learning; deterministic given senses.
  - Implement the derived-weights cache contract even though rule-based brains
    don't use weights, so the interface/serialization shape is stable for Phase 4:
    cache is a pure function of homologs, `dirty` flag triggers re-derive, cache
    is **not** serialized (SPEC.md §"Brain weight expression").
  - Pin the tanh rational approximation as a named function here (used by
    `PatchbayBrain` later; harmless for rule-based).
- **Verify:** `tests/sim/brain.test.ts`: same senses → identical outputs across
  two calls; `think` never reads `Math.random`; serialize/deserialize a brain and
  confirm the derived cache is absent from the blob and re-derived on load.

---

## Phase 0.7 — World construction

**Depends on:** Phase 0.1–0.6.
**Gate:** `createWorld(seed, config)` yields a world whose `totalEnergy`/
`totalWater` equal the config's declared initial totals; founders are clustered;
plants pre-seeded.

### Task 0.7.1: `src/sim/world.ts`

- **What:** `createWorld`, founder spawning, plant pre-seeding, terrain/field init.
- **Why:** `tick.ts` and the headless harness need a valid initial world; the
  conservation gate must hold from tick 0.
- **How:**
  - `createWorld(seed, config)`: init RNG bundle from seed; size `solarReservoir`
    from config; init gridded fields (integer ledger fields, float modulators).
  - Founders: 40–100 lightly-randomized copies of seed genomes, **genome jitter
    and placement both from the `spawn` stream**, clustered into a few demes
    (SPEC.md §Initial Conditions).
  - Pre-seed plants at moderate density (also `spawn` stream).
  - Assign monotonic `id`s and maintain the stable ID array; set `parentId` null
    for founders.
  - Critically: energy handed to founders/plants/fields must be **drawn from**
    `solarReservoir` (or the config's declared pools), never minted, so the
    conservation gate holds at tick 0.
- **Verify:** `tests/sim/world.test.ts`: `totalEnergy(createWorld(...))` equals
  the config's declared grand total; `totalWater` likewise; founder count in
  range; founders occupy few clusters (spatial variance check); same seed → two
  identical worlds (structural deep-equal).

---

## Phase 0.8 — The tick loop

**Depends on:** Phase 0.1–0.7.
**Gate:** 1,000-tick determinism + per-tick energy/water conservation both pass;
the free serialize→deserialize→tick equivalence holds (co-gated with 0.9).

### Task 0.8.1: `src/sim/tick.ts`

- **What:** `tick(world)` — the `sense → think → act → resolve` loop with the
  fixed resolve sub-phase sequence.
- **Why:** This is the engine; every invariant test exercises it. It is built last
  in `sim/` because it composes all prior modules.
- **How:** Implement exactly per SPEC.md §"The Tick Loop":
  1. **Sense** — each agent reads 18 sensors from an **immutable snapshot** of the
     prior state (double-buffered; no first-mover advantage). Distance sensors use
     `spatial.nearestWithin`; polarity `0=adjacent,1=absent`; normalizers from
     `constants.ts`.
  2. **Think** — `BrainOps.think` per agent (rule-based in Phase 0).
  3. **Act** — collect intended actions; apply nothing.
  4. **Resolve**, fixed sub-phases:
     1. Agent actions in `resolve-shuffle` order (movement, eat, drink,
        attack/contests, mate/births, emit scent). Contests: escape check then
        probabilistic contest, both from the `resolve` stream (SPEC.md §Contests);
        kills route through corpse path; eat-to-gain only.
     2. Removals in ascending-`id` order (creature death → corpse + hydration
        return; plant death → fertility decomposition).
     3. Plant updates in ascending plant-`id` order (photosynthesis
        headroom-limited; seeding via `spawn`).
     4. Field updates fixed order: corpse decay → hydration decay → field
        diffusion/decay (`field-noise`) → solar→light influx → unabsorbed-light
        decay to reservoir.
  - **Every** energy/water transfer goes through the `energy.ts` helpers so
    nothing mints/destroys. Metabolic/heat/senescence costs route to
    `solarReservoir`; healing deducts `creature.energy` and credits reservoir.
  - Increment age; apply soft senescence + hard `maxLifespan` ceiling.
  - Index-based iteration throughout; no `Set`/`Object.keys`.
- **Verify:** `tests/sim/determinism.test.ts` (fast-check over seeds): two
  1,000-tick runs from the same seed → bit-identical world (deep structural
  equality). `tests/sim/conservation.test.ts` extended: after **every** tick of a
  1,000-tick run, `totalEnergy(after)===totalEnergy(before)` and `totalWater`
  likewise, exact. This is the load-bearing gate — do not proceed to 0.9 until
  green.

---

## Phase 0.9 — Serialization

**Depends on:** Phase 0.8.
**Gate:** serialization-roundtrip property passes; the free
500→serialize→deserialize→500 ≡ 1,000 test passes.

### Task 0.9.1: `src/sim/serialize.ts`

- **What:** Pure, versioned `serialize(world)` / `deserialize(data)` with the
  migration scaffold.
- **Why:** SPEC.md §Persistence requires `version:1` from the first write and a
  self-describing save; the roundtrip test double-checks determinism.
- **How:**
  - `serialize(world)` writes `version: 1`, world dims, grid resolution, all
    tunable constants, RNG sub-stream **layout and live state**, `solarReservoir`,
    all compartments, `lastSavedRealTime`, event log, downsampled-history shape
    (SPEC.md §Lineage — part of the v1 schema now so adding it later isn't a
    migration).
  - **Do not** serialize the derived brain cache; `deserialize` re-derives it.
  - Every field individually optional/defaulted; add empty `migrate_v…` scaffold
    and a `deserialize` version dispatch (SPEC.md §"Save-migration policy").
  - Pure — lives in `sim/`, no DOM/IndexedDB (those are worker/Phase 5 concerns).
- **Verify:** `tests/sim/serialize.test.ts` (fast-check): `tick^N → serialize →
  deserialize` deep-equals `serialize → deserialize → tick^N` for random seed/N;
  the explicit 500/serialize/deserialize/500 ≡ straight-1000 test passes; a
  `version:1` blob with a field omitted still deserializes (default applied).

---

## Phase 0.10 — Headless terminal harness

**Depends on:** Phase 0.8 (0.9 optional for checkpointing).
**Gate:** `node`/`tsx` runs N ticks printing population counts; running it proves
`sim/` is import-clean (Layer 3 of the purity enforcement).

### Task 0.10.1: `scripts/headless.ts`

- **What:** A minimal runner: parse `--seed` and `--ticks`, `createWorld`, loop
  `tick`, print population counts periodically. No CSV yet (that's Phase 1).
- **Why:** SPEC.md Phase 0 row: "Population counts printed to terminal." Also the
  strongest purity gate — if `sim/` imported React/`window`, plain-Node execution
  crashes (SPEC.md §"The `sim/` purity rule", Layer 3).
- **How:**
  - `scripts/headless.ts` (outside `sim/`), imports only from `src/sim/`.
  - Arg parse; run loop; every K ticks print `tick, population, plantCount,
    corpseCount` to stdout.
  - Run via `tsx`/`vite-node` (no bundler, no DOM).
- **Verify:** `pnpm exec tsx scripts/headless.ts --seed 42 --ticks 1000` runs to
  completion and prints changing population counts. If it crashes on a
  DOM/React import, that is the purity gate correctly firing — fix `sim/`, do not
  weaken the runner.

---

## Phase 0 exit criteria

All green before any Phase 1 planning:

- [ ] `pnpm build && pnpm test && pnpm biome check` all pass.
- [ ] Determinism property (1,000 ticks, any seed) passes.
- [ ] Energy conservation exact every tick; water conservation exact every tick.
- [ ] Inheritance (sexual + clonal) and distance-metric properties pass.
- [ ] Serialization roundtrip + 500/deserialize/500≡1000 pass.
- [ ] `scripts/headless.ts` runs 1,000 ticks and prints population counts.
- [ ] `sim/` imports nothing (Layers 1–3 all enforce it).

**Next:** write `docs/plans/phase-1-plan.md` (headless CSV runner, world-health
metrics, sweep script, throwaway ~50-line debug canvas). Phase 1's gate —
"a config oscillates and diversifies for 100k ticks" — governs whether the sim is
balanced enough to proceed to the visible phases.
