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

### Load-bearing conventions (pinned once, apply everywhere)

These resolve ambiguities that would otherwise let two implementations diverge
bit-for-bit and fail the determinism gate. They are fixed here and referenced by
every task below.

- **Angle encoding (single convention).** A relative angle in `[−π, π]` is encoded
  to a sensor/​control scalar as `angle / π ∈ [−1, 1]`. **Sign convention:
  positive = counter-clockwise (left), negative = clockwise (right)**, measured
  relative to the creature's current heading. `0` = dead ahead, `±1` = directly
  behind. Every angular sensor (6, 8, 10, 17) and the `turn` output use this exact
  mapping. "Steer toward angle `a`" means `turn = a`; "steer away" means
  `turn = wrapToSigned(a + 1)` (i.e. add π, re-wrap to `[−1,1]`) — never a bare
  negation.
- **Float→integer-quantum rounding (single rule).** Genes and expressed traits are
  floats; energy/water are integer quanta. **Every float quantity that becomes an
  energy or water quantum is converted with `Math.round`, once, at the moment it
  enters the ledger** (e.g. a computed metabolic cost `K_SIZE·size` is rounded to
  the integer actually deducted). Never `floor`/`ceil`, never round twice. This is
  what makes two runs subtract the identical integer and stay bit-identical.
- **Resolve interleaving is creature-major, not action-major.** In resolve
  sub-phase 1, iterate creatures in `resolve-shuffle` order and, **for each
  creature, apply all of its intended actions in fixed action-index order**
  (move → eat → drink → attack → mate → emit) before advancing to the next
  creature. (Not: all moves, then all eats.) This is the single pinned reading of
  SPEC §Tick Loop sub-phase 1.
- **`hidden` (recurrent state) initial value is a zero vector** everywhere it is
  born or absent: newborns, spawned creatures, and any `deserialize` of a blob
  lacking the field. Pinned so spawns/births don't diverge.

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
  - Healing (SPEC.md §"Health regeneration"): `HEAL_ENERGY_THRESHOLD` (regen only
    above this energy), `HEAL_RATE` (health/tick), `HEAL_COST` (energy per health
    point healed). Without these, Task 0.8.1 healing cannot be implemented.
  - Species / density (SPEC.md §"What counts as mate", §Density-dependent removal):
    `SPECIES_COMPAT_THRESHOLD` (genetic-distance cutoff for mate classification,
    the `mate` gate, and speciesCount clustering — one shared constant),
    `DENSITY_RADIUS` (the fixed radius `localDensity(pos)` queries).
  - Gated-action thresholds (SPEC.md §Actions "Gated actions fire when their output
    exceeds a threshold"): `EAT_THRESHOLD`, `DRINK_THRESHOLD`, `ATTACK_THRESHOLD`,
    `MATE_THRESHOLD`, `EMIT_THRESHOLD`.
  - Rule-policy fractions (consumed by the `RuleBasedBrain.think` policy, Task
    0.6.1): `HUNGRY_FRAC` (energy fraction below which a creature seeks food),
    `THIRSTY_FRAC` (hydration fraction below which it seeks water),
    `CRITICAL_FRAC` (energy fraction below which flee-from-threat is *suppressed*
    in favor of feeding — "not critical" in the policy means energy ≥
    `CRITICAL_FRAC`), `TARGET_COMMIT_TICKS` (hysteresis: how many ticks a creature
    stays committed to a chosen target before re-selecting — prevents the
    steer-toward-nearest limit cycle).
  - Plant/creature maxima referents: `maxHealth`/`maxEnergy`/`maxHydration`
    coefficients, sensor normalizers (`TEMP_MIN/MAX`, `LIGHT_SENSOR_MAX`,
    `SCENT_SENSOR_MAX`, `WATER_CELL_MAX`, `FERTILITY_CELL_MAX`).
  - Contests: `REACH_BASE`, `REACH_PER_SIZE`, `k_speed`, `k_angle`.
  - **Distance-metric coefficients** (SPEC.md §"Genetic distance"): the weights on
    the Euclidean-over-expressed-weights term and the Hamming-over-expressed-masks
    term (`DIST_WEIGHT_COEF`, `DIST_MASK_COEF`). These are load-bearing for
    determinism and `speciesCount`; enumerate them as named literals now.
  - **Pinned activation** (SPEC.md §"Activation function (pinned)"): the exact
    rational-approximation-of-`tanh` coefficients as named literals. The *specific*
    rational form is an implementation decision to be fixed here and never changed
    (changing it invalidates saved brains); pick one closed form (e.g. a Padé/
    rational approximant), commit it as `TANH_APPROX_*` constants, and document that
    it is frozen.
  - Reach/sense are distinct (SPEC.md §Contests). Keep each value a plain literal;
    do not compute.
- **Verify:** `pnpm build` typechecks. A `tests/sim/constants.test.ts` asserts
  sanity relationships that must hold structurally (e.g. `ARROWS === SENSORS*HIDDEN
  + HIDDEN*HIDDEN + HIDDEN*ACTIONS`, i.e. `350 === 180+100+70`); and that every
  constant referenced by a later task exists (a presence check over the names above).

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
    non-serialized, **`hidden: Float32Array(HIDDEN)`** — the per-creature recurrent
    hidden-state vector, and **`ruleState`** — a tiny serialized record
    `{ mode: 'seek'|'flee'|'rendezvous'|'scavenge'|'wander', targetId, targetKind,
    committedTicks }` used only by `RuleBasedBrain` for target hysteresis + mutual
    mate rendezvous, ignored by `PatchbayBrain`. **`ruleState` is rule-brain-only
    scaffolding** — it stays in the save format under `PatchbayBrain` (harmless dead
    weight) and is safe to drop via migration when `RuleBasedBrain` is eventually
    retired). `Plant`, `Corpse` (energy but **no** hydration field — SPEC.md
    §Removal), field arrays.
  - **Recurrent memory is real per-creature state, and it IS serialized.**
    `BrainOps.think(brain, senses, memory)` takes last tick's hidden layer
    (SPEC.md §Brain Design: memory = the hidden→hidden group; §Tick Loop line
    "senses + recurrent memory"). That vector must persist across ticks per
    creature and survive save/load, or the determinism + serialization-roundtrip
    properties break. So `Creature.hidden` is a serialized field (unlike the
    derived-weights cache, which is *not* serialized because it is a pure function
    of the homologs — the hidden vector is *not* a pure function of anything stored,
    it is genuine runtime state). In Phase 0 the rule-based policy ignores it, but
    the field exists from commit one (like the brain arrays) so Phase 4 needs no
    schema change.
  - `World` (creatures/plants/corpses as arrays + a stable ID array,
    `solarReservoir` as mutable integer, the gridded fields with ledger-bearing
    fields as `Int32Array`/`Uint32Array` and modulator fields as `Float32Array`
    per SPEC.md §Space & Fields, per-sub-stream RNG state, tick counter,
    `lastSavedRealTime`, event log). **Event-log entries are deterministic `sim/`
    data: `{ tick, event }` only — no wall-clock `realTime` inside `sim/`** (that
    would break determinism; the worker attaches `realTime` outside `sim/` — see
    Phase 5).
  - `Config` (world dims, grid resolution, initial `solarReservoir` size, all
    tunables including `brainKind` and `HIDDEN`, RNG sub-stream layout — SPEC.md
    §Persistence: self-describing save). **All UI-mutable tunables live in `Config`
    so `tick()` reads them from `world.config`, never by importing `constants.ts`
    directly** (load-bearing for determinism + Phase 3 `setParam` + Phase 5
    forking); `constants.ts` supplies the *default* values `defaultConfig` copies in.
  - `enum Sensor` (0–17) and `enum Action` (0–6) matching the exact indices in
    SPEC.md §Sensors and §Actions.
- **Verify:** `pnpm build` typechecks. No behavior yet.

### Task 0.1.3: `src/sim/config.ts` — the concrete `defaultConfig` value

- **What:** A single concrete `defaultConfig: Config` object with starting values
  for every tunable, plus a `makeConfig(overrides)` helper.
- **Why:** `createWorld` (0.7), the headless runner (0.10), the viability gate
  (0.11), and Phase 2's first render all need a concrete config *value*, not just
  the `Config` type. Without one owner, each caller invents its own — divergence.
- **How:** Populate every `Config` field from the `constants.ts` defaults (world
  dims, grid resolution, initial `solarReservoir`, all `(tunable)` rates,
  `brainKind: 'rule'`, `HIDDEN: 10`, the RNG sub-stream layout). `makeConfig` deep-
  copies `defaultConfig` and applies overrides (used by the sweep and the
  enlargement experiment). Pure, in `sim/`.
- **Verify:** `pnpm build` typechecks; `defaultConfig` has a value for every
  `Config` field (a presence test over the field names); `makeConfig({})` deep-
  equals `defaultConfig`.

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
    `DIST_WEIGHT_COEF`/`DIST_MASK_COEF` from `constants.ts` (SPEC.md §"Genetic
    distance"). Operates on the expressed brain **only** (not trait genes).
  - **Expressed-brain derivation lives HERE (single owner).** `deriveExpressed(hA,
    hB, mA, mB) → { weights, enabled }` computes `weights[k] = (hA[k]+hB[k])/2` and
    `enabled[k] = mA[k] | mB[k]` (mean / **dominant-enabled OR**, SPEC.md §"Enable-bit
    diploidy" — OR, never AND). This is the one implementation of the derivation;
    `distance` uses it, and the brain cache in Task 0.6.1 **calls this function**
    (it does not reimplement it). This resolves ownership: 0.5 owns the pure
    derivation, 0.6 owns the *caching* of its result. `trait-expression` helper
    (mean-of-alleles) also lives here.
- **Verify:** `tests/sim/genetics.test.ts` (fast-check): **sexual Inheritance** —
  for **every gene allele** in the child (brain weight/enable homologs **and** every
  trait gene allele **and** `hue`), the value came from one of the two parents,
  pre-mutation (SPEC.md §Testing: the property is over *every* gene allele, not just
  brain arrays); **clonal Inheritance** — every plant-seed allele equals the single
  parent's allele (pre-mutation); **distance** — `distance(a,b)===distance(b,a)` and
  `distance(a,a)===0`; `deriveExpressed` uses OR (a homolog-A-off/homolog-B-on arrow
  reads enabled).
  - **Per-homolog drift invariant (guards a silent regression).** A test asserting
    that disabled-arrow drift uses the **per-homolog** mask bit, not the OR-ed
    expressed bit: an arrow off in homolog A but on in homolog B **still drifts in
    homolog A** and does **not** drift in homolog B. (Using the OR for drift
    eligibility would silently kill the pseudogene-reservoir anti-stagnation
    mechanism — the world still runs/conserves/is deterministic, so only this
    targeted test catches it.)
  - **Golden-vector determinism (enforces fixed accumulation order).** A hard-coded
    golden test: `gamete`, `mutate`, and `deriveExpressed` on a fixed seed + fixed
    homologs produce an exact expected byte pattern, computed by an independent
    reference that sums/iterates in the specified index order. A value-only "is it
    deterministic on this machine" check **cannot** detect a reordering (any fixed
    FP order is deterministic locally); only a golden vector catches an accidental
    reorder that would break cross-engine reachability (SPEC §Determinism point 4).

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
  - `RuleBasedBrain.think(senses, memory)` — a **fully-specified deterministic
    formula policy**, pinned to exact arithmetic (the determinism gate requires
    bit-identical output) and emitting **all 7 actions** so the contest/corpse path
    (0.8.1) is exercised by Phase 0's gates. **Sensors are used for *steering
    intent*; the actual "in reach" / "stronger party" checks happen at resolve
    time** against the real reach formula and real target genes (the sensor vector
    is normalized perception and cannot carry them). `think` outputs *intents*;
    resolve validates and either applies or no-ops them. Uses the pinned angle
    convention (Conventions block) and the constants from 0.1.1.
    - **Target selection with hysteresis + mutual rendezvous** (`ruleState.mode`,
      Task 0.1.2; serialized). Re-select a target only every `TARGET_COMMIT_TICKS`
      ticks or when the current target leaves `senseRadius`; otherwise keep the
      committed target. This kills the "steer to fresh-nearest every tick" limit
      cycle. **Rendezvous (fixes the Allee bootstrap, not just the limit cycle):**
      one-sided pursuit of a moving mate never closes if the mate is itself moving.
      So when creature A commits to mate-target B **and** B has reciprocally
      committed to A (`B.ruleState.targetId === A.id`), both enter
      `mode: 'rendezvous'`, and **an explicit asymmetry breaks the deadlock: the
      **lower-`id`** party sets `accelerate = 0` (holds still) while the **higher-`id`**
      party keeps approaching** until within the reach formula; then **both** fire
      `mate` intent. (If both stopped, no gap would ever close — the asymmetry is what
      makes a *moving* approacher reach a *stationary* partner. Lower-id-holds is an
      arbitrary but fixed, deterministic tie-break.) Reciprocity and the id
      comparison are evaluated against the **prior-tick snapshot** (double-buffered
      sense), so it stays deterministic. The `mode` discriminant makes "holding,
      waiting to mate" a real, testable state.
    - **Priority (fixed):** if a threat is within `senseRadius` (sensor 7 < 1) **and**
      own energy (sensor 1) ≥ `CRITICAL_FRAC` → flee (target = threat, flee mode);
      else if hungry (sensor 1 < `HUNGRY_FRAC`) and food perceived (sensor 5 < 1) →
      seek food; else if energy > `MATE_THRESHOLD` and a compatible mate perceived
      (sensor 9 < 1) → seek mate; else wander (hold heading).
    - **turn** (output 0) = for seek, the committed target's angle sensor (6/8/10)
      **as-is** (already in the pinned `[−1,1]` convention); for flee, the threat
      angle steered *away* per the Conventions "steer away" rule. No re-scaling.
    - **accelerate** (output 1) = `1` while pursuing/fleeing a committed target;
      `0` when wandering.
    - **eat** (output 2) intent set when hungry and food perceived (sensor 5 < 1).
      Resolve fires it only if a food-eligible entity is actually within the reach
      formula (`REACH_BASE + REACH_PER_SIZE × size`).
    - **drink** (output 3) intent when hydration (sensor 2) < `THIRSTY_FRAC` and
      local water (sensor 14) > 0.
    - **attack** (output 4) intent when a **threat-classified** target is the
      committed target and this creature is the **stronger party by contest math**:
      resolve compares `self.aggression × self.size` (attacker power) vs.
      `target.armor × target.size` floored at `target.size` (defensive scale, SPEC
      §"What counts as threat") and only initiates if attacker power ≥ that. (Uses
      real genes at resolve, not sensors.) So predation occurs and the contest path
      runs, but suicidal attacks don't.
    - **After a successful kill, the attacker's committed target switches to the
      fresh corpse** (scavenge-to-gain): next-tick priority seeks/eats it, so
      "kill then wander off" is avoided and eat-to-gain actually closes.
    - **mate** (output 5) intent when energy > `MATE_THRESHOLD` and a compatible
      mate is the committed target; resolve fires it only if the mate is within the
      reach formula and both parties' `matingThreshold` gates pass.
    - **emit scent** (output 6) fires at low constant intensity when a threat is
      near (exercises the scent field + sensors 16/17).
    - Ignores the brain weight arrays. No learning; deterministic.
  - The derived-weights pair: **call `deriveExpressed` from `genetics.ts` (Task
    0.5.1)** — do not reimplement the mean/OR here. **Caching is a measured bet, not
    an assumed win.** Implement the *simplest correct thing first*: derive inline
    during the per-tick drift pass (which already iterates all disabled arrows), no
    cache, no dirty flag. Reason: at realistic `DRIFT_RATE` over ~595 disabled-arrow
    rolls/creature/tick, a large fraction of creatures dirty every tick anyway, so a
    dirty-flag cache may be a net loss plus a coherence hazard. **Phase 1's bench
    (Task 1.4) must A/B inline-derive vs. a dirty-flag cache and report the cache
    hit-rate; keep the cache only if it measurably wins.** If cached, the cache is a
    pure function of the homologs and is **not** serialized (re-derived on load —
    SPEC.md §"Brain weight expression"). This keeps the save shape canonical either
    way.
  - Pin the tanh rational approximation as a named function here that reads the
    `TANH_APPROX_*` constants (Task 0.1.1); used by `PatchbayBrain` later, harmless
    for rule-based.
- **Verify:** `tests/sim/brain.test.ts`: same senses+memory → identical outputs
  across two calls; the policy emits each of the 7 actions on an appropriate
  fixture (including `attack`, so the contest path has coverage); `think` never
  reads `Math.random`; serialize/deserialize a brain and confirm the derived cache
  is absent from the blob and re-derived on load.
  - **Unit-level rendezvous test** (the mechanism the viability gate's mating
    assertion depends on): two compatible, well-fed creatures both above
    `matingThreshold`, placed **initially out of reach but within `senseRadius`**
    (the case rendezvous exists to fix — an adjacent-only test would mask a
    both-stop deadlock), reciprocally commit, enter `rendezvous`, the higher-id
    approaches while the lower-id holds, and they **produce a birth within a bounded
    number of ticks**. Assert the lower-id party's `accelerate` is 0 and the
    higher-id party's position converges. This localizes rendezvous failures if
    Phase 0.11's mating assertion goes red.

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
      1. Agent actions in `resolve-shuffle` order, **creature-major** (per the
         Conventions block: iterate creatures in shuffle order, and for each
         creature apply its intended actions in fixed action-index order
         move→eat→drink→attack→mate→emit before the next creature — not
         action-major). Gated intents from `think` are validated here against the
         real reach formula / target genes and applied or no-op'd. Contests: escape
         check then probabilistic contest, both from the `resolve` stream (SPEC.md
         §Contests); kills route through corpse path; eat-to-gain only.
     2. Removals in ascending-`id` order (creature death → corpse + hydration
        return; plant death → fertility decomposition).
     3. Plant updates in ascending plant-`id` order (photosynthesis
        headroom-limited; seeding via `spawn`).
     4. Field updates fixed order: corpse decay → hydration decay → field
        diffusion/decay (`field-noise`) → solar→light influx → unabsorbed-light
        decay to reservoir.
  - **Every** energy/water transfer goes through the `energy.ts` helpers so
    nothing mints/destroys. Metabolic/heat/senescence costs route to
    `solarReservoir`.
  - **Healing** (SPEC.md §"Health regeneration"): only when `creature.energy >
    HEAL_ENERGY_THRESHOLD`; regenerate `HEAL_RATE` health/tick capped at
    `maxHealth`, deduct `HEAL_RATE × HEAL_COST` energy and credit `solarReservoir`
    by the same amount; **a heal the creature cannot afford does not occur** (below
    threshold or insufficient energy → no regen). Uses the constants added in 0.1.1.
  - **Recurrent memory:** after each `think`, store the produced hidden vector into
    `creature.hidden` so the next tick's `think(brain, senses, creature.hidden)`
    reads last tick's hidden layer. (Rule-based `think` ignores it but still returns
    a hidden vector — a zero vector is fine — so the plumbing is identical for the
    Phase 4 swap.)
  - Increment age; apply soft senescence + hard `maxLifespan` ceiling.
  - Index-based iteration throughout; no `Set`/`Object.keys`.
- **Verify:** `tests/sim/determinism.test.ts` (fast-check over seeds): two
  1,000-tick runs from the same seed → bit-identical world (deep structural
  equality). `tests/sim/conservation.test.ts` extended: after **every** tick of a
  1,000-tick run, `totalEnergy(after)===totalEnergy(before)` and `totalWater`
  likewise, exact. This is the load-bearing gate — do not proceed to 0.9 until
  green.
  - **Localized birth-transfer invariant** (births move energy/water between three
    parties and are the most error-prone, most-revisited transfer): a targeted test
    that a **single** birth moves exactly `offspringInvestment` energy from **each**
    parent into the child and nothing more, with both ledgers balanced across just
    that event. The general per-tick conservation test catches only net imbalance;
    this catches conservative-but-wrong bugs (e.g. mom's investment double-counted
    while dad's is dropped) and localizes them.

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
    all compartments, `lastSavedRealTime`, event log (`{ tick, event }` entries —
    **no `realTime`** inside `sim/`), downsampled-history shape (SPEC.md §Lineage —
    part of the v1 schema now so adding it later isn't a migration).
  - **Per-creature fields that MUST be serialized** (or the roundtrip/determinism
    property fails): `parentId` (SPEC.md §Lineage "from commit one"), the diploid
    brain arrays (`weightsA/B`, `enabledA/B`), the recurrent `hidden` vector, and
    **`ruleState`** (target-hysteresis state, Task 0.1.2 — a creature mid-
    `TARGET_COMMIT_TICKS` at the save boundary must resume its committed target, or
    the 500→save→500 ≡ 1000 gate diverges). Explicitly enumerate all of these — do
    not let the "all compartments" phrasing silently drop them.
  - **Do not** serialize the derived brain cache; `deserialize` re-derives it via
    `deriveExpressed` (it is a pure function of the homologs). The `hidden` vector is
    **not** a cache — it is serialized.
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
  - Arg parse (add `--print-every`, default 100); run loop; every `--print-every`
    ticks print `tick, population, plantCount, corpseCount` to stdout.
  - Run via `tsx`/`vite-node` (no bundler, no DOM).
- **Verify:** `pnpm exec tsx scripts/headless.ts --seed 42 --ticks 1000` runs to
  completion and prints changing population counts. If it crashes on a
  DOM/React import, that is the purity gate correctly firing — fix `sim/`, do not
  weaken the runner.

---

## Phase 0.11 — Viability smoke gate (the false-green killer)

**Depends on:** Phase 0.8 (0.10 for a runner).
**Gate:** the default config sustains a living, *interacting* population over a
multi-thousand-tick run — not extinct, not exploded, with real births, kills, and
matings occurring.

### Task 0.11.1: `tests/sim/viability.test.ts`

- **What:** A smoke test that the rule-based world is *alive and dynamic*, not just
  conservative and deterministic.
- **Why:** **Phase 0's other gates all pass on a dead world** — a population that
  collapses to zero on tick 50 conserves energy exactly and replays deterministically.
  Without this gate, the first signal that the rule policy can't bootstrap a
  population arrives only after Phase 1's entire metrics+sweep apparatus is built,
  and even then it's ambiguous (bad constants vs. bad policy). This converts three
  false-greens into a real signal *before* expensive Phase 1 work. This is the
  single highest-value gate in Phase 0.
- **How:** From `createWorld(seed, defaultConfig)`, run ~5,000 ticks over a
  **committed, fixed list of N seeds** (e.g. N=5, seeds pinned as a constant so any
  failure is reproducible and investigable — never "flaky, re-run CI"). Assert, as a
  **quorum, not unanimity** (a viable config can lose one unlucky `spawn`-stream seed
  where founders cluster badly — a quorum stops that reddening the build while still
  catching a genuinely non-bootstrapping policy):
  - on **at least K of N seeds** (e.g. 4 of 5): population never hits 0 and never
    exceeds a sane ceiling (a wide band — smoke, not balance; balancing is Phase 1);
  - and on those seeds, **≥1 birth, ≥1 successful predation (kill via the contest
    path), and ≥1 successful mating** occurred — i.e. the closed ecosystem loop
    actually turns, not just individual actions firing on a fixture (0.6.1's check).
- **This is a bootstrap smoke, not a viability proof.** ~5,000 ticks is only ~5
  days at `TICKS_PER_DAY` and **less than one season** (`DAYS_PER_SEASON`), so it
  never exercises a seasonal turn — that is fine (its job is "does the loop turn at
  all"), but **do not** later mistake a green smoke for long-run viability, which is
  Phase 1's 100k-tick job.
- **Verify:** `pnpm test viability` meets the K-of-N quorum on the pinned seed list.
  **If it fails, the rule policy or the starting constants are wrong — fix them here,
  do not proceed to Phase 1.** (Band edges and K/N are tunable; the *existence* of
  births/kills/matings on a quorum is not.)

---

## Phase 0 exit criteria

All green before any Phase 1 planning:

- [ ] `pnpm build && pnpm test && pnpm biome check` all pass.
- [ ] Determinism property (1,000 ticks, any seed) passes.
- [ ] Energy conservation exact every tick; water conservation exact every tick.
- [ ] Inheritance (sexual + clonal), distance-metric, per-homolog-drift, and
      golden-vector (fixed accumulation order) properties pass.
- [ ] Localized birth-transfer conservation invariant passes.
- [ ] Serialization roundtrip + 500/deserialize/500≡1000 pass.
- [ ] `scripts/headless.ts` runs 1,000 ticks and prints population counts.
- [ ] **Viability smoke gate (0.11) passes** — the default world sustains a living,
      interacting population (births + kills + matings occur). Do not enter Phase 1
      until this is green.
- [ ] `sim/` imports nothing (Layers 1–3 all enforce it).

**Next:** write `docs/plans/phase-1-plan.md` (headless CSV runner, world-health
metrics, sweep script, throwaway ~50-line debug canvas). Phase 1's gate —
"a config oscillates and diversifies for 100k ticks" — governs whether the sim is
balanced enough to proceed to the visible phases.
