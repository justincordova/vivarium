# Living World — terrain, procedural creatures, humanized UI, emergent society

## Context

Vivarium's beta is a faithful *emergence instrument*: point-creatures with evolved
patchbay brains moving over a 200×200 grid of uniform scalar fields (light, water,
fertility, plant-energy), under bit-exact determinism and closed integer
energy/water ledgers. It proves the thesis — unscripted behavior from evolution —
but to a normal player it reads as "green dots in an empty petri dish": the world
has no *places* worth caring about, water is a featureless uniform field, and the
chrome is instrument-grade (trait variance, behavior novelty, speciation charts,
lineage IDs). The owner wants a **living world** a newcomer instantly gets and
enjoys: real terrain (rivers, biomes), creatures that look like animals, homes and
packs, and a UI that hides the science by default.

This redesign **evolves the existing deterministic engine** rather than replacing
it. The crown jewel — the pure, deterministic, closed-ledger evolutionary sim — is
preserved. Terrain is *authored* (seed-generated, immutable during ticks) so the
world has real structure and becomes selection pressure, while creatures still
**evolve freely** on top of it and homes/packs **emerge** from behavior. It is
delivered in three playable phases on top of today's sim.

North star (unchanged): **a newcomer instantly "gets it" and enjoys it.**

## Goals

- A bigger world (~4–6×) with **authored terrain**: water bodies (rivers/lakes),
  grassland, forest, barren/rock — each a real place that matters to survival.
- Terrain as **emergent selection pressure**: biomes modulate food, movement,
  cover, and drink sites, so lineages diverge by where they live.
- **Procedural creatures grown from genes** with a real body plan (body, head,
  eyes, appendages, tail) — evolved, unique, and reading as animals, not dots.
- A **humanized default UI**: population, a legible biome map, a plain-language
  event feed and creature card. All instrument analytics move behind a **science
  mode** toggle (nothing deleted).
- **Emergent homes & packs** from added primitives (nest action, kin sense,
  sociality gene) — unscripted, and present in the shipped cold-open.
- Preserve determinism, closed ledgers, `sim/` purity, and the layering direction
  throughout. Each phase ships playable.

## Non-Goals

- No abandoning the evolutionary engine; **appearance stays derived from genes** (no
  designed sprites/archetypes).
- No fully-emergent terrain (no runtime water-flow/erosion sim) — terrain is
  authored once and immutable during ticks.
- No authored/scripted packs or homes as first-class rule-objects — they emerge.
- No server/multiplayer; still static client-side.
- No deletion of the scientific readouts — they move behind a toggle.
- Phases 2–3 detail may be refined after Phase 1 ships and is felt.
- **Not weight-for-weight save compatibility across the geometry bump.** Adding
  sensors reshapes brain geometry; old evolved brains are not preserved arrow-for-
  arrow (this is an accepted major-version world change, not a bug).

## Design

> **Architecture invariants (binding).** `sim/` imports nothing and never mutates
> terrain during a tick; terrain is a read-only argument like config. Energy and
> water stay closed integer ledgers — terrain modulates *rates/multipliers*, it
> mints/destroys nothing. New RNG consumers use **named sub-streams** so existing
> seeds aren't perturbed. All visual work runs under the **frontend-design skill**.
> Determinism stays bit-exact (index-based iteration, pinned activation, no Set/key
> iteration in `sim/`).

### Terrain model & world scale (chosen approach: static typed-grid layer)

Add a parallel per-cell `terrain` layer to the existing field grid. Each cell
carries:
- `biome` — water | grassland | forest | barren | rock (an enum/Int8).
- `elevation` — for water pooling and visual relief.
- derived `moveCost` / `passable` and rate multipliers (growth, cover).

Generated **once** at `createWorld` from the seed via a new named `terrain` RNG
sub-stream (value-noise → elevation → water pools into lows → moisture → biomes),
then **immutable during `tick()`**. Water bodies are seeded by placing extra water
quanta into low cells at creation, **drawn from the reservoir** (conserved) and
refilled toward a target each tick from the reservoir — so they remain part of the
closed water ledger, just spatially concentrated instead of uniform.

World scale bumps `worldWidth/Height` ~200 → ~800–1200 with grid resolution scaled
proportionally. The spatial hash and renderer already scale with world size.

**Save format:** terrain is new serialized state → bump `SAVE_VERSION` (currently 3)
with a `migrateV3toV4` in the existing scaffold; a `version < 4` blob loads with a
default all-grassland, water-uniform terrain (today's behavior). Note the RNG layout
is itself part of the self-describing save: adding a named `terrain` sub-stream is a
save-format change, and `deserializeRng` defaults a stream missing from an old blob
to `mulberry32(0)` (not the salt-derived seed) — harmless here because a loaded world
already carries its serialized terrain, and a fresh world derives the stream properly
at `createWorld`.

### Biomes as selection pressure (rate modulation only)

- **Water bodies:** authored-wet, refilled toward target (conserved). Deep water is
  impassable/costly (drowning) → creatures path around lakes and to shorelines to
  drink. Makes water real geography vs. a uniform field.
- **Grassland:** high plant-growth multiplier → food-rich, contested, exposed.
- **Forest:** medium growth + `cover` (reduces others' sense radius against you) →
  shelter/ambush; the natural cradle for emergent homes.
- **Barren/rock:** low/zero growth, high move-cost/impassable → organic barriers
  that channel migration and drive speciation (the walls-drive-speciation decision,
  made organic).

Every one of these is a multiplier the per-cell tick step already reads alongside
`fields.fertility`; we add `terrain[cell]` as another read. No new ledger.

### Movement, sensing & terrain-awareness (the one brain-I/O change)

- **Movement cost** per cell applied as a multiplier in the existing
  position-integration step (rock slow, deep water impassable). No ledger change.
- **New brain sensory inputs** (kept minimal): local biome, water direction,
  elevation gradient. **This is a breaking brain-geometry change, not a clean
  add.** `SENSORS` (currently 18) is a *world-creation geometry* constant: the
  patchbay arrow count is `SENSORS*HIDDEN + HIDDEN*HIDDEN + HIDDEN*ACTIONS`, and the
  weight-vector index layout is pinned and load-bearing for determinism
  (`brain.ts` §"fixed arrow layout"; golden-vector test). Raising `SENSORS`
  reshapes every genome's weight vector, exactly like the documented "a HIDDEN=10
  save cannot migrate to HIDDEN=20" case. **Consequence:** existing evolved brains —
  including all current user saves and the shipped cold-open — **cannot be migrated
  weight-for-weight.** Old saves must either load as a fresh-geometry world (keeping
  genome traits but re-seeding brain wiring) or be treated as incompatible; the
  cold-open must be **re-evolved** under the new geometry. This is acceptable (a
  major-version world change) but must be planned for in Phase 1/3, not hand-waved.
  Prefer to batch ALL new sensors (terrain in Phase 1, kin in Phase 3) into a single
  geometry bump if possible, to avoid two breaking migrations.
- **Drink** becomes a real evolved *pathing-to-water* behavior since water is now
  localized. Inputs are read-only functions of terrain + position (determinism-safe).

### Procedural creatures from genes (pure render layer)

A real body plan grown from the genome, entirely in `render/` (sim untouched):
body (size/elongation from `size`+`diet`), head + eye (forward), appendages
(fins/legs whose count/shape derive from genes — e.g. speed→fin size), tail for
orientation, plus existing spikes/armor and hue/energy color. Still 100% derived —
evolution drives appearance; every creature unique; reads as an animal. Gene→feature
mapping lives in `palette.ts` (pure, testable); drawing in `canvas.ts`; perf-gated
under density. May add 1–2 expressed channels to the frame (additive to the
frame↔palette contract; no sim-behavior change).

### Humanized default UI (science behind a toggle)

- **Default view:** population, a legible biome/water map, a **plain-language event
  feed** ("a pack formed near the northern lake", "the blue lineage is thriving"),
  and a plain-language **creature card** on click ("a fast forest hunter, well-fed,
  3 offspring") instead of raw allele sliders.
- **Science mode toggle:** reveals today's instrument panels (trait variance,
  novelty, speciation charts, lineage IDs, enable-density, allele editors). Nothing
  deleted — just not in a newcomer's face.
- Reuses existing `lineageEvents` + narration and existing frame/inspect data;
  mostly a UI-layer reorganization + a store flag.

### Emergent homes & packs (added primitives, unscripted outcome)

- **Sim primitives:** a `nest` action (claim/build at a spot), **kin recognition**
  (a lineage-proximity sense input), and a `sociality` gene. Packs/territories
  **emerge** from evolution + terrain (defensible forest / near-water spots become
  homes). New actions/genes/inputs → save-version bump; all deterministic.
- **Ships in the cold-open:** the pre-evolved snapshot is regenerated so a
  first-time visitor sees packs/homes immediately (emergence, not potential).

### Phasing (each phase ships playable)

1. **Terrain foundation** — bigger world, terrain grid, biomes, water bodies,
   movement cost, terrain sensing, save-version + migration, regenerated cold-open.
2. **Creatures + humanized UI** — procedural body-plan rendering; default/science
   UI split.
3. **Society** — nest/kin/sociality primitives; emergent packs/homes; new cold-open.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| World model | Authored terrain, evolved creatures | Real places + kept evolutionary engine; terrain = selection pressure |
| Terrain representation | Static typed-grid layer, seed-generated, immutable in tick | Minimal change that preserves determinism + closed ledgers; cheap |
| Terrain vs ledgers | Terrain modulates rates only | Energy/water stay closed; nothing minted/destroyed |
| Water bodies | Authored-wet cells drawn from reservoir, refilled toward target | Real geography while staying in the closed water ledger |
| Creatures | Procedural body plan from genes | Look like animals, stay evolved/unique, no sprites |
| Science UI | Hidden by default behind a science-mode toggle | Normal players first; power users keep everything |
| Homes/packs | Emergent from added primitives (nest/kin/sociality) | True to the thesis; drama unscripted; shipped via cold-open |
| World scale | ~4–6× larger + proportional grid | Room for rivers/regions/migration |
| Delivery | 3 playable phases on the current engine | Lowest risk; feel each phase before the next |
| Brain I/O | Minimal terrain/kin sensory inputs added | Reshapes `SENSORS` geometry → **breaking** for evolved brains; batch all new sensors into one geometry bump; re-evolve cold-open |
| Save/brain migration | New world geometry, not weight-migratable | Old saves load with fresh brain wiring (traits kept) or are incompatible; documented, planned per phase |

## Rejected Alternatives

- **Fully-emergent terrain (runtime water-flow/erosion, self-organizing biomes).**
  Rejected: slow to pay off, hard to make look designed, and every flow rule risks
  the conservation invariants.
- **Terrain as entities (river/tree objects).** Rejected: thousands of entities
  blow up per-tick cost and the save format; fights the cheap-many-agents design.
- **Designed species archetypes with genetic variation.** Rejected: decouples
  appearance from evolution and caps visual diversity; violates "derived, never
  designed."
- **Authored packs/homes as first-class rule-objects.** Rejected: scripted behavior,
  a departure from the emergence thesis.
- **Delete the scientific readouts.** Rejected: they're valuable to power users;
  hiding behind a toggle keeps both audiences.
- **One big-bang redesign.** Rejected: too much to pin down before feeling Phase 1;
  higher revision risk.

## Edge Cases & Constraints

- **Determinism:** terrain gen uses a new named `terrain` RNG sub-stream so existing
  seeds' creature/spawn streams are unperturbed; terrain is read-only in `tick()`;
  keep index-based iteration.
- **Ledger conservation:** water bodies and refills are transfers from the reservoir
  (named endpoints); `totalEnergy`/`totalWater` must stay `===` before/after every
  tick. **Extend** the existing `tests/sim/conservation.test.ts` to cover terrain
  water seeding/refill (do not add a parallel test file).
- **Save format:** bump version; forward-migrate old blobs to a default terrain;
  the `hidden` recurrent vector vs. derived brain-weights distinction still holds.
- **Brain skeleton change (Phase 1/3):** new inputs invalidate old evolved brains'
  I/O layout → regenerate the cold-open; migration defaults new inputs to neutral.
- **Performance:** bigger world × more cells × richer creature rendering — keep the
  spatial hash, cull to viewport, perf-gate rich rendering under density; verify
  the headless runner and `pnpm bench` stay green.
- **Offline catch-up** must remain bit-identical to live ticks (same `tick()`),
  including terrain reads.
- **Water underlay rendering** already fixed to normalize against the live field max
  (uniform water reads faint; pooling/flood/drought stand out) — the biome map in
  Phase 1 supersedes it with real water-body rendering.

## Open Questions

- None blocking. Exact world dimensions, biome ratios, creature-feature gene
  mapping, and the precise new sensory-input set are tuned during Phase 1/2
  execution against the north star.
