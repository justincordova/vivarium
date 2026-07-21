# Phase 7 — Society (nest / kin / sociality) Plan

> **Goal:** Add the emergent-society primitives from the Living World design — a `nest`
> action (build/claim a home), kin recognition (sense same-lineage neighbors), and a
> `sociality` gene — so packs and territories *emerge* from evolution + terrain, giving
> creatures place-based goals beyond eat/drink/fight/sleep. Ship it pre-formed in a
> re-evolved cold-open.
> **Design:** `docs/designs/living-world.md` §"Emergent homes & packs" (Phase 3).
> **Spec:** `docs/SPEC.md` §"Living World redesign".

## Invariants (do not violate)

- `sim/` imports nothing; nests are World state mutated only inside `tick()` via the
  same compartment-transfer discipline as every other action.
- Energy + water stay closed integer ledgers. A nest **mints/destroys nothing**: any
  benefit is a *rate modulator* (reduced metabolic drain, faster heal) drawn through
  existing named compartment transfers, never a free grant.
- Determinism is bit-exact: index-based iteration only; **never** iterate a `Set` or
  `Object.keys()` in `sim/`; nest lookup is index-based over a stable array; any new
  RNG draw comes from an existing **named sub-stream** (no new stream needed — nesting
  is deterministic given percepts; if a stochastic tie-break is required, draw from
  `resolve`).
- The `hidden` recurrent vector stays serialized; derived brain-weights stay a cache.
- This phase makes a **single breaking brain-geometry bump** (ACTIONS 7→8, SENSORS
  21→24). That is the documented, accepted major-version world change: it re-baselines
  the golden vector and forces a cold-open regen. Batch BOTH the new action and all
  three kin sensors into this one bump (design §"batch all new sensors into one
  geometry bump").
- Gate after every task: `pnpm build` → `pnpm test` → `pnpm lint`. Commit per task.

---

## Phase 7A: Society in the sim (BREAKING geometry — one bump)

**Gate:** nest entity + action, kin sensors, and sociality gene all live; golden
vector re-baselined; determinism + conservation green at the new geometry; all
existing tests pass or are intentionally re-baselined.

### Task 1: Geometry constants + enums (the single bump)
- **What:** Raise `ACTIONS` 7→8 and `SENSORS` 21→24; add the new enum members; fix
  `ARROWS`.
- **Why:** Everything downstream (decoder, sensor fill, brain, tests) keys off these;
  bump them first so the geometry is consistent before wiring behavior.
- **How:**
  - `src/sim/types.ts` `enum Action` (currently ends `EmitScent = 6`, `src/sim/types.ts:533-541`):
    append `Nest = 7`.
  - `src/sim/types.ts` `enum Sensor` (currently ends `WaterDirY = 20`, `src/sim/types.ts:506-530`):
    append `KinDirX = 21`, `KinDirY = 22`, `KinDensity = 23`. Update the doc comment
    "The 21 sensor input indices" → 24.
  - `src/sim/constants.ts`: `SENSORS = 24` (`src/sim/constants.ts:88`), `ACTIONS = 8`
    (`src/sim/constants.ts:92`). Recompute `ARROWS` (`src/sim/constants.ts:99`):
    `SENSORS*HIDDEN + HIDDEN*HIDDEN + HIDDEN*ACTIONS = 24*10 + 10*10 + 10*8 =
    240 + 100 + 80 = 420`. Set `ARROWS = 420` (plain literal per the "do not compute"
    rule) and update the structural-relation comment `420 === 240+100+80`.
  - Update the `SENSORS` doc comment to note "Phase 7A added 3 kin senses: 21 → 24".
- **Verify:** `pnpm build` (types compile); `tests/sim/constants.test.ts` — the
  `ARROWS === SENSORS*HIDDEN + HIDDEN*HIDDEN + HIDDEN*ACTIONS` assertion (`:8`) must pass.
  This test **hard-codes** the values in three places that must be updated:
  `expect(ARROWS).toBe(380)` → `420` (`constants.test.ts:9`), `SENSORS` `21` → `24`
  (`:13`), `ACTIONS` `7` → `8` (`:15`); `HIDDEN` stays `10`. Update the `380/210+100+70`
  comment (`:6-7`) to `420/240+100+80`.

### Task 2: `sociality` gene (diploid trait)
- **What:** Add a `sociality` allele to `Genome`, seeded in founders, mutated, expressed,
  serialized. It is NOT auto-enumerated — the codebase drives traits off explicit
  name-lists, so it must be added to **all six** of them (QA-confirmed).
- **Why:** The gene is the heritable knob nest/kin behavior selects on; define it before
  the nest benefit that reads it.
- **How:** Expressed range `sociality ∈ [0,1]` (0 = solitary, 1 = gregarious). Add it to
  every explicit list (each verified as the real mechanism):
  - `src/sim/types.ts` `interface Genome` (`src/sim/types.ts:28-54`): add
    `sociality: Allele;` after `matingThreshold`.
  - `src/sim/genetics.ts` `TRAIT_GENES` name-list (`src/sim/genetics.ts:22-37`): add
    `"sociality"`. **Required** — `crossover` (`genetics.ts:134-137`) and `mutate`
    (`genetics.ts:209-219`) loop this list; without it the gene never inherits/mutates.
  - `src/sim/genetics.ts` `TRAIT_RANGE` table (`src/sim/genetics.ts:41-56`): add
    `sociality: [0, 1]`. This is the per-gene clamp `mutate` applies at `genetics.ts:216`.
  - `src/sim/constants.ts` `TRAIT_MUT_SIGMA` (`src/sim/constants.ts:167-182`): add a
    `sociality` sigma (mirror `aggression`/`diet` scale, consistent with the [0,1] range).
  - `src/sim/serialize.ts` `TRAIT_KEYS` list (`src/sim/serialize.ts:120-135`): add
    `"sociality"`. `serGenome` (`serialize.ts:148`) and `deGenome` (`serialize.ts:229`)
    both loop `TRAIT_KEYS`, so this one add serializes it end-to-end (Task 6 relies on it).
  - `src/sim/world.ts` `makeFounderGenome` (`src/sim/world.ts:150`, `seedGene` calls at
    `:183-195`): `seedGene("sociality", 0.5)` (neutral midpoint).
  - `tests/sim/constants.test.ts`: the "TRAIT_MUT_SIGMA has an entry for every diploid
    trait gene" test hard-codes the gene-name list (`constants.test.ts:30-45`) — add
    `sociality` so it stays in sync.
- **Verify:** `pnpm build`; `tests/sim/genetics.test.ts` — a founder genome carries
  `sociality` in [0,1] and mutation keeps it clamped; `tests/sim/constants.test.ts` green
  with the extended gene list. Any determinism/golden fixture that pins exact
  post-mutation values is re-baselined in Task 7 (a new gene shifts `mutation`-stream draw
  counts), not here.

### Task 3: Nest entity + World state
- **What:** A `Nest` entity type and a `nests: Nest[]` array on `World`, with a stable id.
- **Why:** The nest action needs somewhere to write; define the data model before the
  action and before serialize.
- **How:**
  - `src/sim/types.ts`: add
    ```ts
    export interface Nest {
      id: number;
      x: number;
      y: number;
      lineage: number;   // founder-lineage-root that owns it (world.lineageRoots value)
      strength: number;  // integer 0..NEST_MAX_STRENGTH; decays, reinforced by nesting
    }
    ```
    Add `nests: Nest[];` to `interface World` (`src/sim/types.ts:447-499`, near
    `creatures`/`corpses`). Nests are NOT ledger-bearing (no energy/water field) — like
    corpses' position, they carry no water; `strength` is a non-conserved modulator
    counter, not a quantum ledger.
  - `src/sim/constants.ts`: add `NEST_MAX_STRENGTH`, `NEST_DECAY` (strength lost per
    tick), `NEST_REINFORCE` (strength gained per nest action), `NEST_CLAIM_RADIUS`
    (distance under which an existing same-lineage nest is reinforced rather than a new
    one created), `NEST_THRESHOLD` (gated-action fire threshold, mirroring
    `EAT_THRESHOLD`…), `NEST_SHELTER_METAB_MULT` (<1: metabolic-drain multiplier when
    resting on your lineage's nest), and `NEST_CAP` (hard ceiling on nest count, a
    memory bound like `CREATURE_CAP`). Mirror each into the `Tunables` interface
    (`src/sim/types.ts:321-416`) AND copy it in `defaultTunables()`
    (`src/sim/config.ts:17`, which `makeDefaultConfig()` at `:121` calls) so they are
    self-describing tunables read via `t.X` (`world.config.tunables`), never imported into
    `tick()` directly. (Verified chain, e.g. `EAT_THRESHOLD`: constants.ts:307 →
    types.ts:370 → config.ts:67 → read `t.EAT_THRESHOLD` tick.ts:379.)
  - `src/sim/world.ts` `createWorld`: initialize `world.nests = []`.
- **Verify:** `pnpm build`; a founder world has `world.nests` `=== []`.

### Task 4: Kin sensors (fill the 3 new slots)
- **What:** Populate `KinDirX/KinDirY/KinDensity` in the sense step.
- **Why:** Kin recognition is the perceptual half of "packs emerge"; needed before the
  cold-open can evolve pack behavior.
- **How:**
  - In the sense builder (`src/sim/tick.ts`, the `senses` fill block that currently ends
    at the terrain senses `src/sim/tick.ts:284-290`), add a bounded, deterministic
    same-lineage neighbor scan. Mirror the `nearest` closure at `src/sim/tick.ts:163`,
    which calls `snap.hash.queryWithin(self.x, self.y, senseRadius)` (`tick.ts:168`) and
    iterates the returned indices index-based via `snap.byId.get(...)` (`tick.ts:169-180`).
    (`nearest` is a local closure, not an exported fn — replicate its `queryWithin` loop;
    `localDensity` from `src/sim/spatial.ts:172` is the reusable count primitive.) For
    the focal creature:
    - Resolve its lineage root via `world.lineageRoots[self.id]`.
    - Over neighbors within `senseRadius` (reuse the same neighbor query the food/mate
      scan uses — index-based over the hash bucket, NOT a Set), consider only those whose
      `world.lineageRoots[other.id]` equals the focal root and `other.id !== self.id`.
    - `KinDirX/Y` = unit vector toward the nearest such kin (0,0 if none), mirroring the
      `WaterDirX/Y` normalization at `src/sim/tick.ts:288-290`.
    - `KinDensity` = `min(1, kinCount / (2*REPRO_CROWD_LIMIT))`, mirroring the
      `LocalDensity` normalizer at `src/sim/tick.ts:272`.
  - Read-only over `world.lineageRoots` (a `Record<number,number>` — look up by id, never
    iterate its keys in `sim/`). Deterministic: the neighbor list comes from the spatial
    hash in index order.
- **Verify:** `pnpm build`; add to `tests/sim/` a focused test: a hand-built world with
  two same-root creatures adjacent yields `KinDensity > 0` and a `KinDir` pointing at the
  kin; two different-root neighbors yield `KinDensity === 0`. Determinism test re-baseline
  handled in Task 7.

### Task 5: Nest action (build/claim/reinforce) + shelter benefit
- **What:** Wire `Action.Nest` through the decoder and apply it in `applyCreature`;
  apply the shelter rate-modifier; decay nests each tick.
- **Why:** This is the behavior itself; depends on Tasks 1–4.
- **How:**
  - Add `nest: boolean` to the `Intents` interface at **`src/sim/brain.ts:280-287`**
    (fields: turn, accelerate, eat, drink, attack, mate, emit).
  - `decodeActions` (`src/sim/tick.ts:375-385`): add
    `nest: (actions[Action.Nest] as number) > t.NEST_THRESHOLD` to the returned object.
  - The rule policy `ruleThink` constructs an `Intents` object literal at
    **`src/sim/brain.ts:310-318`** — add `nest: false` there so it compiles (nesting is a
    patchbay-era behavior; the rule brain never nests).
  - In `applyCreature` (the gated-action block, `src/sim/tick.ts:609-641`), after the
    `emit` handler, add a `nest` handler:
    - Compute the creature's lineage root `root = world.lineageRoots[c.id]`.
    - Scan `world.nests` (index-based) for a nest with the same `lineage` within
      `NEST_CLAIM_RADIUS`. If found, `strength = min(NEST_MAX_STRENGTH, strength +
      NEST_REINFORCE)` (reinforce). Else, if `world.nests.length < NEST_CAP`, push a new
      `Nest { id: world.nextId++, x: c.x, y: c.y, lineage: root, strength: NEST_REINFORCE }`.
    - Charge a small **energy cost** for the nest action through a real transfer
      (`transferUpTo(fieldCompartment(c,"energy"), reservoir, toQuantum(NEST_COST))`) so
      building is not free — mirror the attack-cost transfer at `src/sim/tick.ts:699`.
      Add `NEST_COST` to constants/tunables.
  - **Shelter benefit (rate modulator, ledger-safe):** in the metabolic-drain step
    (the baseline metabolic transfer around `src/sim/tick.ts:534`, and/or the healing
    block at `src/sim/tick.ts:599-607`), if the creature is within `NEST_CLAIM_RADIUS` of
    a same-lineage nest, scale the metabolic drain by `NEST_SHELTER_METAB_MULT` (<1).
    This changes only how much energy is transferred `creature → reservoir` — it mints
    nothing; the creature simply keeps more of its own energy by sheltering. Do NOT add
    energy to the creature; only reduce an outbound transfer.
  - **Nest decay:** add a small `resolveNests(world, t)` and call it from the `tick()`
    orchestration block at **`src/sim/tick.ts:478-487`** (alongside the existing
    `resolveRemovals`/`resolvePlants`/`resolveFields` calls there — those are the CALL
    sites; the function *definitions* live further down at `:831`/`:917`/`:983`, do not
    edit there). In `resolveNests`, iterate nests index-based, `strength -= NEST_DECAY`,
    then drop dead nests using the codebase's actual removal convention — a
    **filter/partition reassign** (`world.nests = world.nests.filter(n => n.strength > 0)`),
    mirroring `world.creatures = survivors` at `src/sim/tick.ts:889` /
    `world.plants = plantSurvivors` at `:912`. (Note: removal here is filter-reassign,
    NOT swap/pop — the codebase has no swap/pop removal.) Decay is a pure counter, no
    ledger.
  - Determinism: all nest iteration is index-based over `world.nests`; ties (two nests in
    range) resolve by first index. No `Set`, no key iteration.
- **Verify:** `pnpm build`; `tests/sim/` nest test — a creature that fires `nest` creates
  exactly one nest; firing again within `NEST_CLAIM_RADIUS` reinforces (count stays 1,
  strength rises); a nest decays to removal after `ceil(strength/NEST_DECAY)` ticks with
  no reinforcement; **conservation**: extend `tests/sim/conservation.test.ts` to run N
  ticks in a world where creatures nest and shelter, asserting `totalEnergy`/`totalWater`
  stay exactly `===` before/after every tick (the shelter modifier and nest cost must not
  leak the ledger).

### Task 6: Serialize nests + sociality (save v4 → v5)
- **What:** Persist nests and the `sociality` gene; migrate old saves.
- **Why:** Nests + the new gene are world/genome state; a reload must restore them, and
  pre-Phase-7 saves must still load.
- **How:**
  - `src/sim/serialize.ts`: bump `SAVE_VERSION = 5` (`src/sim/serialize.ts:48`).
  - `SaveBlob` (`src/sim/serialize.ts:51-72`): add `nests?: Nest[]` (plain
    `{id,x,y,lineage,strength}[]`). `sociality` is already handled by Task 2's add to
    `TRAIT_KEYS` (`src/sim/serialize.ts:120-135`) — `serGenome` (`serialize.ts:148`, NOT
    `enGenome`; that name does not exist) and `deGenome` (`serialize.ts:229`) both loop
    `TRAIT_KEYS`, so no per-gene serialize edit is needed here beyond that list entry.
  - Serialize `world.nests` directly (they're already plain objects). In `deserialize`,
    restore `world.nests` (default `[]` when absent).
  - Migration: add `migrateV4toV5(b)` and extend the `migrate` chain
    (`src/sim/serialize.ts:312-320`, following `migrateV3toV4` at `:286`): a `version < 5`
    blob defaults `nests` to `[]` and defaults each genome's `sociality` to a neutral
    `[0.5, 0.5]` allele-pair. Follow the exact defaulting shape `deTerrain`
    (`src/sim/serialize.ts:272-283`) uses for "absent field → sane default".
  - **Brain geometry re-seed (resolve the QA gap — no reusable RNG-seeded factory exists,
    and `deGenome` has no RNG; do NOT import `world.ts` into `serialize.ts` — risk of an
    import cycle).** Because ACTIONS/SENSORS changed, a pre-v5 genome's `weightsA/B`
    (length 380) mismatches the new `ARROWS` (420). Handle it **inside `deGenome`**
    deterministically and RNG-free: when `serialized.weightsA.length !== ARROWS`, build
    the new homolog arrays at length `ARROWS` as **zero-filled `Float32Array(ARROWS)`**
    for `weightsA/weightsB` and **zero-filled `Uint8Array(ARROWS)`** for `enabledA/enabledB`
    (all arrows disabled). This yields a valid, inert brain of correct geometry with zero
    RNG draws (determinism-safe on the load path) — genome *trait* alleles are preserved,
    only the brain wiring is reset. A creature that loads inert will behave as a blank
    slate and re-evolve; this matches the design's "traits kept, brain wiring re-seeded"
    intent without needing world.ts. Document this in the migration comment. (The shipped
    cold-open is regenerated fresh in Task 9, so real users never see inert brains from
    the cold-open; only hand-carried pre-v5 personal saves load inert, which is the
    accepted major-version consequence.)
  - **Verify:** `tests/sim/serialize.test.ts` — round-trip a v5 world with nests +
    sociality → identical `nests` array and `sociality` alleles; a synthetic v4 blob
    (no `nests`, no `sociality`, 380-length brain) loads with `nests === []`, `sociality`
    `[0.5,0.5]`, `weightsA.length === ARROWS` (420) all-zero/all-disabled, no throw, and
    `version` reads 5.

---

## Phase 7B: Observe + narrate + ship

**Gate:** nests render; the event feed narrates pack/home formation; the cold-open is
re-evolved under the new geometry and boots.

### Task 7: Re-baseline determinism + golden vectors
- **What:** Regenerate the pinned test fixtures the geometry bump invalidates.
- **Why:** The golden brain vector and any determinism fixture that hard-codes an action
  vector / genome layout are now stale by design; this is the intentional, reviewed break.
- **How:**
  - `tests/sim/brain.test.ts` golden vector (`tests/sim/brain.test.ts:312-325`):
    regenerate the expected `actions` array (now length 8) under the 24-sensor / 420-arrow
    geometry. Update the comment to "Phase 7A re-baseline (SENSORS 21→24, ACTIONS 7→8,
    ARROWS 380→420)".
  - `tests/sim/determinism.test.ts`: if it pins exact post-run hashes/values, re-baseline
    them (the `mutation`-stream draw order shifts because `sociality` is a new gene and
    `nest` a new action). If it only asserts *run-to-run equality* (same seed → same
    result), it needs no value change — just confirm it still passes.
  - Confirm `tests/sim/constants.test.ts` passes with `ARROWS = 420`.
- **Verify:** `pnpm test` fully green with the re-baselined fixtures.

### Task 8: Nest rendering + kin/pack narration
- **What:** Draw nests on the canvas and add plain-language pack/home lineage events.
- **Why:** Make the emergent society *visible* and legible — the whole point of the
  complaint ("they don't build anything" must become observable when they do).
- **How:**
  - Frame: `src/worker/protocol.ts` `RenderFrame` (`src/worker/protocol.ts:78`) — add
    `nests: Float32Array` (packed `[x,y,strength]` triples) or a small
    `{x,y,strength,lineage}[]`; whichever matches the existing frame style (biome uses a
    typed array — prefer a packed `Float32Array` + push its buffer to
    `frameTransferables`, `src/worker/frame.ts:174,196-197`). Populate it in
    `src/worker/frame.ts` from `world.nests`.
  - Renderer: `src/render/canvas.ts` — add a `drawNests(...)` pure function (a small
    home marker sized by `strength`, tinted by owning lineage hue if cheap), called from
    `draw` under creatures; cull to viewport and perf-gate like `drawTerrain`
    (`src/render/canvas.ts:59,282`).
  - Narration: extend the typed lineage-event detection in `src/sim/history.ts` (where
    `newDominant`/`lineageBoom` are detected) with a `packFormed`-style event when a
    lineage first accumulates ≥K nests, OR keep it lighter and push a plain
    `pushEvent(world, "nest:<lineage>")` from the nest handler and surface it in the
    existing feed. Prefer the lighter `pushEvent` route first (no new `LineageEvent`
    variant, no save-shape change beyond nests) unless the design wants a typed event.
    If a typed event IS added, extend the `LineageEvent` union (`src/sim/types.ts:284-287`)
    and its narration, and re-baseline any lineage-event test.
  - `src/ui/HelpLegend.tsx`: add a nest legend row.
- **Verify:** `pnpm build`; `tests/worker/frame.test.ts` — frame carries `nests`;
  `pnpm test tests/render` green; manual `pnpm dev` shows nest markers (deferred to user
  smoke-test).

### Task 9: Regenerate the cold-open
- **What:** Ship a pre-evolved world where packs/homes already exist.
- **Why:** A first-time visitor must see emergent society immediately (design
  §"Ships in the cold-open"), not an empty potential.
- **How:** Run the generator `scripts/make-cold-open.ts` under the new geometry/world
  size to produce `public/cold-open.viv.gz`. Evolve long enough that nests appear
  (may need to confirm the generator runs enough ticks for nesting to establish; bump its
  tick budget if nests are absent). Confirm it deserializes at `version: 5` and boots via
  the landing "Enter the living world" path.
- **Verify:** `pnpm exec tsx scripts/make-cold-open.ts` succeeds; loading it in `pnpm dev`
  shows creatures nesting/clustering by kin (deferred to user smoke-test); prod build
  green.

---

## Final wrap-up (after 7A + 7B)
- `pnpm build && pnpm test && pnpm lint` all green; `pnpm bench` not materially
  regressed (kin scan reuses the existing spatial hash; nest decay is O(nests)); headless
  purity run green (`pnpm exec tsx scripts/headless.ts --ticks 500 --seed 42`).
- Tag the milestone per `docs/VERSIONING.md` (a phase gate = minor bump).
- Suggest `sync-docs` to fold Phase 3 of the Living World design into SPEC.md and retire
  the design doc.
