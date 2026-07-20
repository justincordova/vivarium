# Vivarium — Evolutionary Ecosystem Simulator

> **Status:** Phases 0–5C shipped; the **beta definition-of-done is met** (persist +
> offline catch-up + "while you were away" report), followed by a **welcoming
> observatory UI overhaul** (landing screen, themed chrome, organism rendering — see
> §Visual Design / §Player Experience). A larger **Living World redesign** is now
> approved and in progress (see §Living World redesign below and
> `docs/designs/living-world.md`); until its phases land, the rules in this spec
> describe the current running system. This spec is the source of truth for the
> rules; where the shipped code refined a decision, the relevant section notes it.
> Post-beta modes (Terrarium/Laboratory, LLM naturalist) remain deferred (§Non-Goals).
> **Purpose:** Fully pin the simulation rules — sensors, actions, parameters and
> their costs, removal conditions, plant lifecycle, energy return, contest
> resolution, initial conditions, tick semantics and units — before any code
> exists. Where a decision carries reasoning, the reasoning is preserved so a
> reviewer can evaluate the argument, not just the conclusion.
>
> This document is the **single source of truth** for what gets built. It is
> self-contained: earlier handoff and tooling-update drafts have been folded in and
> removed.

---

## Vision

A browser-based, entirely client-side evolutionary ecosystem simulator: a
persistent world of simulated agents ("numbers in arrays") with evolved neural
brains that live, compete, reproduce, and speciate under shifting environmental
pressure. The interesting artifact is not the code — it is the *behavior that
emerges from it*. Ambush predation, flocking, nocturnal niches, and speciation
should appear without being programmed.

The project succeeds if it produces things the author did not anticipate.

---

## Living World redesign (approved, in progress)

The beta proves the emergence thesis but reads, to a normal player, as "green dots
in an empty petri dish": the world has no *places* worth caring about, and the
chrome is instrument-grade. An approved redesign — **`docs/designs/living-world.md`**
— evolves the existing deterministic engine into a **living world** a newcomer
instantly gets and enjoys, without abandoning the crown jewel (the pure,
deterministic, closed-ledger evolutionary sim). North star: *a newcomer instantly
"gets it" and enjoys it.*

Direction (chosen): **authored terrain, evolved creatures, emergent society.**

- **Authored terrain (immutable during ticks).** A seed-generated per-cell terrain
  layer (biome + elevation + move-cost) added alongside the existing field grid,
  generated once at `createWorld` via a new named `terrain` RNG sub-stream and
  read-only in `tick()`. It **modulates rates only** (growth, movement, cover, drink
  sites) — the closed integer energy/water ledgers are untouched; water bodies are
  authored-wet cells drawn from the reservoir (conserved). The world grows ~4–6×.
- **Biomes as selection pressure.** Water (rivers/lakes), grassland, forest,
  barren/rock — each a real place that changes food, movement, cover, and drinking,
  so lineages diverge by where they live.
- **Procedural creatures from genes.** A real body plan (body, head, eyes,
  appendages, tail) grown from the genome in the pure `render/` layer — evolved,
  unique, reading as animals, not dots. Appearance stays *derived, never designed*.
- **Humanized default UI; science behind a toggle.** Default shows population, a
  legible biome map, a plain-language event feed and creature card; all instrument
  analytics (trait variance, novelty, speciation, lineage IDs, allele editors) move
  behind a **science mode** toggle. Nothing is deleted.
- **Emergent homes & packs.** Added sim primitives (a `nest` action, kin-recognition
  sense, a `sociality` gene) let packs/territories **emerge** from evolution +
  terrain; shipped pre-formed in a re-evolved cold open.

**Cost owned up front:** new terrain/kin **sensory inputs raise `SENSORS`, which
reshapes the pinned patchbay brain geometry** (arrow count = `SENSORS·HIDDEN +
HIDDEN² + HIDDEN·ACTIONS`). This is a *world-creation geometry* change like the
documented HIDDEN bump: **existing evolved brains (user saves + the shipped
cold-open) are not weight-for-weight migratable** — old saves load with fresh brain
wiring (genome traits kept) or are treated as incompatible, and the cold-open is
re-evolved. Batch all new sensors into a single geometry bump to avoid two breaking
migrations. `SAVE_VERSION` bumps (3 → 4) with a `migrateV3toV4` in the existing
scaffold (old blobs default to all-grassland, water-uniform terrain).

**Delivery:** three playable phases on the current engine — (1) terrain foundation
(bigger world, biomes, water bodies, movement cost, terrain sensing, save
migration, regenerated cold-open), (2) procedural creatures + humanized UI split,
(3) social primitives + emergent packs/homes + new cold-open. Determinism, closed
ledgers, `sim/` purity, and the layering direction hold throughout. This section is
the index; the design doc holds the full reasoning and rejected alternatives, and
will be folded into the body sections by sync-docs as phases land.

---

## Goals

- **Definition of done (beta):** A stranger opens a URL, sees a living world with
  visible predator–prey oscillation, clicks a creature and reads its genome,
  adjusts the mutation rate, closes the tab, and finds their world waiting
  tomorrow.
- **Emergence over authorship.** Behaviors are evolved, not scripted.
- **A shareable link.** Static deploy; seed + config live in the URL hash.
- **A headless instrument.** The same `tick()` runs from the terminal at
  thousands of ticks/second for overnight parameter sweeps. This is the decision
  the project succeeds or fails on.
- **Portfolio + learning.** Roughly two months of evenings.

---

## Non-Goals (beta)

- **Neural brains are not in the beta DoD.** Phases 0–3 run *rule-based* agents.
  Brains are Phase 4. Brains on an unbalanced world produce creatures that evolve
  to die efficiently.
- No backend, no auth, no server-side persistence.
- No NEAT / rtNEAT until a measured ceiling binds (see Brain Design).
- No LLM "naturalist," hall-of-fame/leaderboard, phylogenetic-tree UI, PixiJS/
  WebGL, or structure-of-arrays refactor in beta. All deferred.
- No cross-engine bit-determinism guarantee in beta (but the format is
  architected to make it *reachable* later — see Determinism).

---

## Architecture

Browser web app, static deploy, sim runs client-side in a Web Worker. Layered so
that swapping any outer layer never touches the inner ones.

```
sim/      pure. imports nothing. no React, no DOM, no window, no Math.random()
worker/   owns the authoritative World, runs ticks, autosaves, posts lean snapshots
render/   pure function of a snapshot (canvas today, PixiJS/WebGL later)
ui/       React chrome only — panels, charts, inspector. Never calls tick()
```

### Key Components

- **`sim/`** — `constants.ts`, `types.ts`, `rng.ts`, `world.ts`, `tick.ts`,
  `energy.ts`, `genetics.ts`, `brain.ts`, `spatial.ts`, `serialize.ts`,
  `stats.ts`. Zero dependencies. Everything it needs arrives as arguments.
  Both the Phase 0 **rule-based policy** and the Phase 4 **patchbay network**
  implement the `BrainOps<B>` interface and live in `brain.ts` (as
  `RuleBasedBrain` and `PatchbayBrain`); the tick loop calls the active brain via
  `world.config.brainKind` (`'rule' | 'patchbay'`). The brain *representation* is
  confined to `brain.ts`, but the swap was not literally one file: the rule policy
  reads a hand-built `RuleContext` and emits `Intents` directly, so wiring the
  patchbay in also required a **sensor-vector builder** (world → 18 floats) and an
  **action-vector decoder** (7 floats → the same `Intents`) at the `tick.ts` seam.
  Both brains then share the identical resolve path.
- **`worker/`** — `sim.worker.ts` (owns the `World`, runs ticks, autosaves),
  `protocol.ts` (message types, imported by both sides). Never posts the whole
  World — only lean render snapshots (typed arrays) and periodic stats. UI
  requests one creature's full data on click.
- **`render/`** — `canvas.ts` (`draw(snapshot, ctx, camera)`), `camera.ts`,
  `palette.ts` (genome → appearance).
- **`ui/`** — `App`, `SimCanvas` (canvas ref + rAF loop), `ControlPanel`,
  `Charts`, `Inspector`, `Lineage`. Reads a Zustand store.
- **`scripts/`** — `headless.ts` (run N ticks in Node, dump CSV), `sweep.ts`
  (sample K configs, run in parallel, rank by world-health).

### The `sim/` purity rule — load-bearing

**`sim/` imports nothing.** No React, no DOM, no `window`, no `Math.random()`.
This single constraint buys: deterministic unit tests, a Web Worker (UI never
stutters), and a headless Node runner (overnight sweeps). Enforced in three
layers — Biome lint scoped to `src/sim/**` (fast local warning), the determinism
test (catches `Math.random()`), and the headless runner (crashes if `sim/`
touches React/`window`). Layers 2 and 3 are the actual gate.

### Data Flow

`worker` holds the World → runs `tick()` → emits typed-array frame snapshots and
periodic stats to `main` → `render` draws the snapshot → `ui` displays chrome and
sends commands (`play`, `pause`, `speed`, `inspect`, `snapshot`) back to the
worker. On inspect, the worker replies with one creature's full data.

**Worker protocol sketch** (lives in `protocol.ts`, imported by both sides):

```ts
// main → worker
type Command =
  | { t: 'init'; seed: number; config: Config }
  | { t: 'play' } | { t: 'pause' }
  | { t: 'speed'; ticksPerFrame: number }
  | { t: 'inspect'; id: number }
  | { t: 'snapshot' };

// worker → main
type Event =
  | { t: 'frame'; tick: number; positions: Float32Array; /* ...lean typed arrays */ }
  | { t: 'stats'; tick: number; population: number[]; traits: TraitBins }
  | { t: 'creature'; data: Creature }               // reply to `inspect`
  | { t: 'snapshot'; world: SerializedWorld }
  | { t: 'catchupProgress'; done: number; total: number };
```

The worker never posts the whole `World` — only the lean `frame`/`stats` messages
above; a full `Creature` crosses the boundary only in reply to an explicit
`inspect`.

### Tooling (decided — do not relitigate)

TypeScript · Vite · **pnpm** · React · Zustand · Tailwind · Recharts (+ d3 for the
phylo tree only) · `idb-keyval` · **Biome** (lint+format, `indentStyle: "space"`)
· **Vitest** (`environment: 'node'` default — never jsdom) · **fast-check**
(property tests) · **`vitest bench`** · **lefthook** (`biome check` pre-commit
only; tests in CI) · Deploy: Vercel / Netlify / Cloudflare Pages.

---

## Tick Semantics & Units

The vocabulary every balancing conversation depends on. These live in
`constants.ts` with comments. Values marked *(tunable)* are starting points to be
swept, not law.

| Symbol | Meaning | Starting value |
|---|---|---|
| `dt` | fixed timestep | 1 tick, no sub-stepping |
| `TICKS_PER_DAY` | ticks in a full day/night cycle | 1000 *(tunable, sweepable)* |
| `DAYS_PER_SEASON` | day/night cycles per season | 30 *(tunable)* |
| `MS_PER_TICK` | how fast world-time flows in real time | chosen after benchmarking |
| `MAX_OFFLINE_TICKS` | catch-up ceiling | chosen so worst-case catch-up < ~20s |
| age | increments by 1 per tick per creature | — |
| distance/tick | max travel = `speed` gene mapped to world units/tick | see Parameters |
| energy/tick | see Energy & Costs | integer quanta |

**`MS_PER_TICK` and `MAX_OFFLINE_TICKS` are independent knobs** and are chosen
*after* `vitest bench` reports the real headless tick rate. Guessing produces
either a 14-minute loading bar or a world that barely advances.

**Rule:** a tick is atomic and ordered as `sense → think → act → resolve` (see
Tick Loop). Aging, metabolism, and field updates all advance exactly one `dt`.

---

## Determinism

**Baseline: on-machine determinism.** Two runs from the same seed on the same
build produce bit-identical state after N ticks. This is asserted in a property
test and is the primary bug detector alongside energy conservation.

**Cross-engine determinism is a non-goal for beta but is kept *reachable*** so a
future shared leaderboard (a seed that reproduces identically in someone else's
browser) does not require a save-invalidating rewrite. Four decisions preserve
that door, all made now because each one sizes the genome or the save format:

1. **Energy is integer quanta**, not floats. Conservation becomes exact (`===`,
   not "within epsilon"), and integer accounting is engine-independent. This is a
   serialization-format decision and is therefore fixed before the first save.
2. **RNG is seeded `mulberry32` with named sub-streams** (see RNG Discipline).
3. **The neural activation function is pinned** (see Brain Design). `Math.tanh`,
   `Math.sin`, `Math.exp` are *not* bit-identical across engines; the activation
   function is specified as a fixed rational/polynomial approximation so a later
   cross-engine push does not invalidate every saved brain.
4. **Forward-pass accumulation order is fixed and index-based** (never Map/Set
   iteration).

**Never iterate a `Set` or `Object.keys()` in `sim/`.** Insertion order silently
breaks determinism. All iteration over agents is index-based over a stable array
of IDs.

### RNG Discipline (overlooked-item fix)

A single global RNG stream is a determinism hazard: inserting one new `rng()`
call earlier in the tick shifts every downstream draw, changing every existing
seed's world and breaking every shareable-seed URL and the cold-open snapshot.

**Decision:** the RNG is organized as **named sub-streams**, one per subsystem.
The full v1 set is:

| Sub-stream | Consumers |
|---|---|
| `motion` | movement jitter, any stochastic locomotion |
| `mutation` | all mutation draws + disabled-arrow drift |
| `mating` | gamete formation (per-arrow homolog pick) |
| `resolve-shuffle` | the seeded-shuffle order of conflict resolution |
| `resolve` | contest draws (escape check, attacker-wins roll) |
| `field-noise` | field diffusion/decay noise |
| `spawn` | founder placement + founder genome jitter, plant seeding, seed dispersal |

`resolve-shuffle` (the *order* agents are processed) and `resolve` (the contest
*coin-flips*) are **deliberately separate streams**: were they one, adding a
contest draw would shift the shuffle sequence and break every existing seed.
Adding a consumer inside one subsystem does not perturb the draw sequence of any
other. Seed compatibility is nonetheless **tied to the save version**: a documented
guarantee that seeds reproduce within a sim version, not necessarily across
versions. The sub-stream layout itself is part of the serialized snapshot (see
Persistence), so a save is self-describing about which streams existed.

---

## The Genome

A genome is diploid: two aligned copies of everything functional, plus one
neutral appearance marker.

```ts
interface Genome {
  // Brain (see Brain Design) — diploid
  weightsA: Float32Array;   // one homolog
  weightsB: Float32Array;   // the other homolog
  enabledA: Uint8Array;     // 0/1 mask homolog A
  enabledB: Uint8Array;     // 0/1 mask homolog B

  // Trait genes — diploid (two alleles each; expressed value defined below)
  size: [number, number];
  speed: [number, number];
  senseRadius: [number, number];
  metabolism: [number, number];
  aggression: [number, number];
  diet: [number, number];              // 0 = pure herbivore, 1 = pure carnivore
  circadian: [number, number];         // 0 = diurnal, 1 = nocturnal
  nightVision: [number, number];
  armor: [number, number];
  toxicity: [number, number];
  offspringInvestment: [number, number];
  matingThreshold: [number, number];
  maxLifespan: [number, number];
  digestionEfficiency: [number, number];

  // Appearance — neutral, drifts freely, carries lineage. Diploid so hybrids
  // are visibly hybrid.
  hue: [number, number];               // 0..360
}
```

**Allele expression.** Continuous trait genes express as the **mean of the two
alleles** unless otherwise noted. This gives smooth blending inheritance while
diploidy still hides recessive variation in the enable mask (below).

**Brain weight expression.** Each arrow has two homolog weights (`weightsA[k]`,
`weightsB[k]`). The value the forward pass multiplies is their **mean**:
`w[k] = (weightsA[k] + weightsB[k]) / 2` — the same blending rule as trait genes.
The arrow's active bit is `enabled[k] = enabledA[k] | enabledB[k]`
(dominant-enabled). The forward pass therefore operates on a single derived
`weights`/`enabled` pair computed from the two homologs; the two homologs are what
gets stored, inherited, and mutated. Wherever this spec writes `weights[k]` in the
forward pass, it means this derived mean.

**The derived pair is cached, not recomputed per tick.** Recomputing 350 means
and OR-ed bits for every creature on every `think` would dominate the tick budget
that sizes `MAX_OFFLINE_TICKS` (see Benchmarks). The derived `weights`/`enabled`
arrays are computed once at **birth** (after crossover + mutation assemble the
homologs) and re-derived **only when a homolog changes** — i.e. after the
per-tick disabled-arrow drift fires on that creature (the sole per-tick homolog
mutation). Drift therefore sets a dirty flag that triggers re-derivation before
the next forward pass; a creature with no drift event that tick reuses its cached
derived pair. The cache is a pure function of the two homologs and so is **not
serialized** — `deserialize()` re-derives it from the stored homologs, keeping the
save format canonical (two homologs only) and determinism intact.

**The `hue` gene** has *zero* effect on survival. It is a neutral marker that
drifts down each lineage; after many generations, color similarity *is*
relatedness — phylogeny read directly off the screen, no computation. It is
diploid so hybrids look intermediate. **It exists from the first save**, because
no archived world can retroactively gain it.

### Enable-bit diploidy — diploid mask, dominant-enabled

A connection is active if **either** copy has it on:
`enabled[i] = enabledA[i] | enabledB[i]`. Recessive "off" alleles accumulate
silently; two carriers can produce offspring that lose a connection both parents
expressed. This is real genetic load and a reservoir of latent architectures that
can resurface when conditions change — a mechanism for escaping stagnation. The
alternative (dominant-disabled: active only if both are on) is too harsh; haploid
mask is simpler but cannot hide topology.

---

## Brain Design — the "patchbay"

Only **agents** get brains — things that must choose among incompatible actions
under uncertainty. **Fields** (water, temperature, light, scent, fertility) and
**passive organisms** (plants) do not; their behavior is a formula.

### The network

Fixed-skeleton feed-forward with recurrence. A shared address space: **arrow #k is
the same arrow in every creature that ever lives.** This is what makes sexual
crossover and the species-distance metric both trivial and correct — it dissolves
the competing-conventions problem that NEAT needs historical markings to solve.

**Starting skeleton — 18 sensors, 10 hidden, 7 actions:**

| Connection group | Arithmetic | Arrows |
|---|---|---|
| sensors → hidden | 18 × 10 | 180 |
| hidden → hidden (memory / recurrence) | 10 × 10 | 100 |
| hidden → actions | 10 × 7 | 70 |
| | | **350** |

Every creature stores, per homolog, `weights: Float32Array(350)` and
`enabled: Uint8Array(350)`. Diploid ≈ 350 × (4 + 1) × 2 ≈ 3.5 KB/creature of
brain. Hidden-neuron count (10) is a free parameter with a memory cost; it is the
subject of the enlargement experiment (below).

> **Turning is one signed output, not a heading.** A single neural output is a
> bounded scalar. Mapping it to an absolute 0–360° heading creates a wraparound
> seam (values near 0° and 360° are the same heading but maximally far apart in
> output space), which mutation handles badly. Instead the `turn` output is a
> signed **angular velocity** capped at a max turn rate per tick; the creature
> steers continuously toward *any* of the full 360°, composing turns across ticks
> via the recurrent hidden layer. Left/right is the control axis, not the set of
> reachable directions.

**Forward pass** masks disabled arrows:
`sum += input * weights[k] * enabled[k]`. Same matrix shape for every creature →
vectorizable. Accumulation order is fixed and index-based (determinism).

**Activation function (pinned).** Hidden and output activations use a **fixed
rational approximation of `tanh`** rather than `Math.tanh`, so activations are
engine-independent and cross-engine determinism stays reachable. The exact
approximation is a named constant in `constants.ts`; changing it later
invalidates saved brains, so it is fixed now.

**Newborns are sparse** — ~15% of arrows enabled *(tunable)*. Mutation flips
enable bits on (brain grows) and off (brain prunes): genuine topology evolution
within a fixed address space.

**Disabled arrows keep drifting.** Drift operates on the **stored homologs**
(`weightsA`/`weightsB`), not the derived array — a change to the derived cache
would be overwritten on the next re-derivation and never inherited or serialized.
It draws from the `mutation` sub-stream, per homolog:
```ts
// mut = the `mutation` RNG sub-stream. Run per homolog h ∈ {A, B}.
for (let i = 0; i < N; i++) {
  if (!enabledH[i] && mut() < DRIFT_RATE) {
    weightsH[i] += gaussian(mut) * DRIFT_SIGMA;   // DRIFT_SIGMA = 0.2 (tunable)
    dirty = true;                                  // triggers cache re-derivation
  }
}
```
Whether a homolog's arrow counts as "disabled" for drift uses that homolog's own
mask bit (`enabledH[i]`), not the OR-ed expressed bit — drift is a per-homolog
neutral process. Weights of unplugged arrows wander neutrally, unseen by selection,
for many generations; when re-enabled they return carrying whatever they drifted to
— a pseudogene reactivating, a reservoir of silent variation. Keep it.

### Crossover, mutation, distance

Reproduction is diploid, so crossover is **meiosis**: each parent contributes one
*gamete* (a haploid pick across its two homologs, per arrow), and the child's two
homologs are the two gametes. This is done per arrow for both the weight array and
the enable mask:

```ts
// mating: the `mating` RNG sub-stream (see RNG Discipline).
// Each parent forms a gamete: per arrow, pick one of its two homolog alleles.
function gamete(hA: Float32Array, hB: Float32Array, mA: Uint8Array, mB: Uint8Array, mating: RNG) {
  const w = new Float32Array(N), m = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const takeA = mating() < 0.5;              // independent per arrow (no linkage in v1)
    w[i] = takeA ? hA[i] : hB[i];
    m[i] = takeA ? mA[i] : mB[i];
  }
  return { w, m };
}

// Child assembles one gamete from each parent into its two homologs.
const gm = gamete(mom.weightsA, mom.weightsB, mom.enabledA, mom.enabledB, rng.mating);
const gd = gamete(dad.weightsA, dad.weightsB, dad.enabledA, dad.enabledB, rng.mating);
child.weightsA = gm.w;  child.enabledA = gm.m;
child.weightsB = gd.w;  child.enabledB = gd.m;
```

Trait genes and `hue` segregate the same way (one allele per parent → the child's
two alleles). This makes the **sexual Inheritance** property test (every allele in
a creature child came from one of its two parents) well-defined and true by
construction. (Plant seeds use the separate clonal Inheritance property — see
Plant Lifecycle and Testing.)
Mutation (see Mutation) is applied to the child's homologs *after* assembly. There
is no chromosomal linkage in v1 — each locus segregates independently; adding
linkage later is a version bump.

**Genetic distance** operates on the **expressed** brain (mean weights, OR-ed
masks) so two creatures that compute the same function are close regardless of
which homolog carries what: Euclidean over expressed weights + Hamming over
expressed enable masks (weighted sum, coefficients in `constants.ts`). This *is*
the species compatibility metric, so two populations can speciate by **thinking
differently**, not just looking different. The metric is symmetric and
zero-on-identity (asserted by property test).

### Mutation

Mutation is applied to a child's homologs after crossover assembly. Every mutable
locus and its rate/distribution is enumerated here; all rates are *(tunable)* and
draw from the `mutation` RNG sub-stream. The genome-space these define is the
search space evolution explores.

| Locus | Rule |
|---|---|
| Brain weight (per homolog, per arrow) | with prob `WEIGHT_MUT_RATE`, add `gaussian(rng) × WEIGHT_MUT_SIGMA` |
| Enable-bit flip **on** (per homolog, per arrow) | with prob `ENABLE_ON_RATE`, set a 0 → 1 (brain grows) |
| Enable-bit flip **off** (per homolog, per arrow) | with prob `ENABLE_OFF_RATE`, set a 1 → 0 (brain prunes) |
| Disabled-arrow drift | the neutral drift rule (`DRIFT_RATE`) already specified above |
| Trait gene (per allele) | with prob `TRAIT_MUT_RATE`, add `gaussian(rng) × TRAIT_MUT_SIGMA[gene]`, clamped to the gene's legal range |
| `hue` (per allele) | with prob `HUE_MUT_RATE`, add `gaussian(rng) × HUE_DRIFT` (small), wrapped mod 360 — the only wraparound in the sim, and it is harmless because hue is neutral |

**The DoD "mutation rate" slider** scales a single global multiplier
`MUT_GLOBAL` applied to *every* per-locus rate above (not the sigmas). One knob,
uniform pressure; the individual rates set the *relative* mutability of each locus.
This is the referent the definition of done points at ("adjust the mutation rate").

### Why not NEAT (yet), and how to measure the swap

NEAT assumes generational replacement this sim doesn't have (continuous
overlapping generations, no fitness function — survival *is* fitness), and its
historical markings exist to solve the competing-conventions problem the shared
address space already avoids. The cost of the patchbay, stated honestly: a hard
ceiling on hidden-neuron count, no new layers, and memory paid for arrows nobody
plugged in.

Brains sit behind an interface so the swap is cheap:
```ts
interface BrainOps<B> {
  create(rng: RNG): B;                      // caller passes the `spawn` sub-stream
  think(brain: B, senses: Float32Array, memory: Float32Array): Float32Array;
  mutate(brain: B, rng: RNG): void;         // caller passes the `mutation` sub-stream
  crossover(mom: B, dad: B, rng: RNG): B;   // caller passes the `mating` sub-stream
  distance(a: B, b: B): number;             // pure, no RNG
  serialize(brain: B): ArrayBuffer;
}
```
**The single `rng: RNG` parameter is always the specific named sub-stream the tick
loop selects for that operation** — `create` gets `spawn`, `mutate` gets
`mutation`, `crossover` gets `mating` (matching the RNG discipline). The interface
takes one stream, not the whole bundle, precisely so an implementation cannot reach
for the wrong stream; wiring the correct stream is the caller's responsibility and
is fixed by this contract. `PatchbayBrain` is implemented (Phase 4); `NeatBrain`
later. Two instruments, in `stats.ts` (`meanEnabled`, and the enlargement run in
`scripts/experiment-brain-capacity.ts`), decide when (if ever) to swap:

- **Enable density** — track `mean(enabled)` over time. Climbs to 0.9+ and pins →
  evolution wants every arrow. Plateaus ~0.4 → capacity was never the constraint.
- **The enlargement experiment** — same seed, 10 hidden vs. 20 hidden. World-
  health improves meaningfully → the ceiling binds. Indistinguishable → NEAT buys
  nothing. (`HIDDEN` is world-creation geometry — it reshapes the arrow count and the
  `hidden` vector length — so the experiment runs fresh worlds at each `HIDDEN`; a
  `HIDDEN=10` save cannot migrate into a `HIDDEN=20` build.)

**Phase 4 verdict (measured, not designed — see `docs/findings/phase-4-brain-
capacity.md`): keep the patchbay.** Enable density plateaus well below 0.5 (robust
across seeds) → capacity is not the constraint; the enlargement instrument is
seed-noisy and inconclusive at short horizons and does not override that. A separate
**heritability gate** (mean parent↔child expressed-brain distance / mean pairwise
distance ≤ `HERITABILITY_MAX`) passes, so behavior can accumulate under selection
despite meiotic resampling of the expressed brain. NEAT stays out of beta, gated on a
long-horizon re-run of these instruments.

### The sensor/action ladder — walk in order, do not jump to the top

Richer behavior is added one rung at a time. The v1 skeleton (18 sensors, 7
actions) sits on rungs 1–3; higher rungs are post-beta version bumps. This ladder
is the referent behind every "deferred to the sensor/action ladder" note elsewhere
in this spec.

1. **More senses.** Cheapest path to richer behavior: ray-cast vision returning
   distance + type, richer internal state (gestation, etc.). Every sensor is a new
   dimension evolution can exploit with *zero* architecture change — but it widens
   the fixed input vector, so each addition is a version bump.
2. **Memory.** Feed last tick's hidden layer back as inputs. **Already present in
   the patchbay skeleton** as the hidden→hidden group — recurrence *evolves* rather
   than being handed over, because those arrows start disabled. Creatures can flee
   for several ticks after a predator leaves view.
3. **Signals.** An output that emits into a scent/sound field and an input that
   reads it. **Already present in v1** as `emit scent` (action 6) + the scent
   sensors (16/17). Nobody codes what a signal means; alarm calls — and *deceptive*
   alarm calls that scare rivals off food — may evolve. A second signal channel is
   a later rung (version bump).
4. **Evolving architecture (NEAT / rtNEAT).** Only after the measured ceiling binds
   (see the two instruments above). This is the one rung that changes the brain
   representation rather than the umwelt.
5. **Multiple brains per creature.** Diminishing returns. Skip.

> ⚠️ **Add sensors slowly and observe — change one thing at a time.** Going from 18
> inputs to 40 in one commit means weird behavior cannot be attributed to any one
> cause. **The debugging tool in this project is watching**, and that only works
> when a single variable changes per experiment. This is why the umwelt is fixed at
> 18 now with some inputs fed zeros, enabled one at a time (see Sensors).

---

## Sensors — the umwelt (18 inputs)

This list **is** what a creature can perceive; evolution can only exploit what is
here. It fixes the input-vector length permanently. Reserved now; some may be fed
zeros initially and enabled one at a time to honor "change one thing at a time."
All distance sensors (5/7/9) are normalized as `clamp(dist / senseRadius)` — a
hard perception cap. **Polarity is fixed and counterintuitive on purpose: `0` = the
object is adjacent (dead on top of the creature), `1` = at or beyond the perception
limit ("nothing there").** Closer means a *smaller* sensor value. This is the
single canonical rule for every distance sensor; do not invert it per-sensor. A
value of exactly `1.0` is indistinguishable from "no such object in range," which
is intended — absence and maximum distance read identically. The `own age` sensor
normalizes against the **expressed** `maxLifespan` (mean of the two alleles).

**Every `0..1` sensor has a named normalization referent** *(all tunable constants
in `constants.ts`)*: own energy / hydration / health against their maxima
(`maxEnergy` is an expressed function of `size`, grounded in the Parameters table's
"larger energy store"; `maxHydration` likewise; `maxHealth` per Removal & Corpses);
temperature against `TEMP_MIN..TEMP_MAX`; light against `LIGHT_SENSOR_MAX`; scent
against `SCENT_SENSOR_MAX`; local water/fertility against
`WATER_CELL_MAX`/`FERTILITY_CELL_MAX`. No sensor normalizes against an undefined
quantity.

> **Design decision (not derived from prior text).** Only `maxEnergy ∝ size` is
> grounded in the original spec ("larger energy store"). `maxHydration ∝ size` and
> `maxHealth`'s dependence on `size`/`armor` are new modeling choices added here to
> give those sensors concrete referents; they were not implied by earlier sections.
> Both are tunable defaults, not derivations.

| # | Sensor | Range | Notes |
|---|---|---|---|
| 0 | bias | constant 1.0 | |
| 1 | own energy | 0..1 normalized | |
| 2 | own hydration | 0..1 normalized | thirst axis |
| 3 | own age | 0..1 of expressed `maxLifespan` | |
| 4 | own health | 0..1 | damage state |
| 5 | nearest-food distance | 0..1 of `senseRadius` | |
| 6 | nearest-food angle | −1..1 relative to heading | |
| 7 | nearest-threat distance | 0..1 of `senseRadius` | |
| 8 | nearest-threat angle | −1..1 | |
| 9 | nearest-mate distance | 0..1 of `senseRadius` | compatible mate only |
| 10 | nearest-mate angle | −1..1 | |
| 11 | local population density | 0..1 | `localDensity(pos)` normalized; same function as density-dependent removal |
| 12 | light level | 0..1 | day/night — the circadian sensor |
| 13 | local temperature | 0..1 normalized | |
| 14 | local water | 0..1 | water-field sample (drives `drink` seeking) |
| 15 | local fertility | 0..1 | fertility-field sample (soil richness) |
| 16 | scent value at self | 0..1 | emitted-signal field |
| 17 | scent gradient direction | −1..1 | direction of increasing scent — **fed 0 in v1** (the one reserved sensor deferred per "add sensors slowly"; all other 17 are live) |

**Field sampling at continuous positions uses nearest-cell lookup** (deterministic
and cheap), not bilinear interpolation. Vision is **nearest-object scalars, not
ray-casts** in v1; ray-casting is deferred to the sensor ladder because it
balloons the skeleton and violates "add sensors slowly."

### What counts as food / threat / mate

Sensors 5–10 classify nearby entities from the *perceiving* creature's point of
view. The classification is relative — two creatures can legitimately disagree
about each other. All "nearest" queries run over the spatial hash within
`senseRadius`, ties broken by ascending entity `id` (deterministic).

- **Food** = any entity satisfying the canonical edible predicate
  `effectiveCapture(entity, creature) > 0` (see Diet) — a plant if
  `plantYield(diet) × digestionEfficiency > 0`; a corpse or huntable creature if
  `meatYield(diet) × digestionEfficiency > 0`. Because `digestionEfficiency` is
  clamped strictly positive, this reduces to `typeYield(diet) > 0`, so a pure
  carnivore does not perceive plants as food, and vice versa. The sensor and the
  `eat` action use this identical predicate.
- **Threat** = any *living agent* within radius whose attack power
  (`aggression × size`) exceeds this creature's own defensive scale
  (`armor × size`, floored at `size`) — i.e. something that would probably win a
  contest against it. This is self-relative, so a large armored creature perceives
  few threats and a small one perceives many.
- **Mate** = any *living agent* within radius whose genetic distance to this
  creature is below the species-compatibility threshold **and** whose energy is
  above its own `matingThreshold` (it must be a viable partner). Mutual by
  construction of the distance metric, though each party's `matingThreshold` gate
  is checked independently at resolve.

A single entity can satisfy more than one classifier (a compatible mate that is
also large enough to be a threat); each sensor reports its own nearest
independently.

---

## Actions (7 outputs)

| # | Action | Type | Effect |
|---|---|---|---|
| 0 | turn | signed scalar | angular velocity, capped at max turn rate/tick |
| 1 | accelerate | signed scalar | forward/brake; rest = accelerate ≈ 0 (no separate rest output) |
| 2 | eat | gated | consume nearest food (plant or corpse) in reach if diet permits |
| 3 | drink | gated | restore hydration from local water field |
| 4 | attack | gated | initiate combat with nearest agent in reach (see Contests) |
| 5 | mate | gated | attempt reproduction with nearest compatible mate in reach |
| 6 | emit scent | intensity | write into the scent field at own position |

Gated actions fire when their output exceeds a threshold *(tunable)*. No
`rest`, `share/give-energy`, or second signal channel — deliberately excluded to
keep the skeleton narrow; adding one later is an accepted version bump.

**Output-clamp-then-scale ordering (fixed).** Every raw neural output is first
clamped to its canonical range by the activation function (`turn` and
`accelerate` land in `[−1, 1]`; gated outputs in `[0, 1]`). The `metabolism`
multiplier is applied **after** that clamp, to the per-tick *physical* cap, not to
the raw output:
```
appliedTurn  = clamp(rawTurn,   −1, 1) × MAX_TURN_RATE × metabolism
appliedAccel = clamp(rawAccel,  −1, 1) × MAX_ACCEL × metabolism / mass
mass         = 1 + K_SIZE × size + K_ARMOR × armor
```
The brain always steers within a normalized control range and never has to "know"
its own metabolism; metabolism raises the ceiling (and its cost) beneath a control
signal that stays in `[−1, 1]`. The `size`- and `armor`-slower-acceleration costs
from the Parameters table are realized here, through the `mass` divisor on
acceleration (heavier bodies accelerate less per unit control) — this is the single
place acceleration is computed. `MAX_ACCEL`, `K_SIZE`, `K_ARMOR` are named
constants *(tunable)*.

> **Design decision (not derived from prior text).** The Parameters table words the
> size cost as "slower accel per unit `speed`," which is looser than the `1/mass`
> divisor chosen here: this formula makes acceleration scale with `1/(1 + K_SIZE ×
> size + K_ARMOR × armor)` and does **not** couple the accel penalty to the `speed`
> gene. That is a deliberate simplification — the `speed²` movement-energy cost
> (Parameters table) already prices `speed` separately, so double-coupling it into
> the kinematic cap would tax `speed` twice. Turn rate is not mass-divided in v1
> (turning is treated as costless-to-mass steering). Both are tunable modeling
> choices, not consequences of earlier sections; revisit during the Phase 1 sweep.

This clamp-then-scale ordering is fixed because reversing it (scaling before clamp)
would let metabolism be silently clipped away, changing selection on the gene.

### Diet & the eat-efficiency curve

`diet` (0 = pure herbivore, 1 = pure carnivore) sets how efficiently a creature
extracts energy from each food type. The curves are **continuous**, so there is no
cliff a mutation cannot cross and omnivores (diet ≈ 0.5) are viable:

```
plantYield(diet) = (1 − diet)          // fraction of a plant's energy captured
meatYield(diet)  = diet                // fraction of a corpse's energy captured
```

Both are further scaled by `digestionEfficiency` (an independent gene, its own
cost). Effective capture = `foodEnergy × typeYield(diet) × digestionEfficiency`;
the **uncaptured remainder transfers to the local fertility field** (Energy
step 3), so the books close regardless of diet match.

**Plant `toughness` reduces `foodEnergy`, not the yield split.** When a plant is
grazed, `toughness` withholds a fraction of the plant's energy from the transfer
entirely; the withheld quanta **stay in `plant.energy`** (the plant keeps them —
they are never removed from that compartment). Only the *released* portion
`foodEnergy = plant.energy × (1 − toughnessFraction)` enters the capture split
above (creature ← effective capture, fertility ← uncaptured remainder). Nothing is
minted or destroyed: released energy is fully partitioned between creature and
fertility, and withheld energy never leaves the plant.

**One canonical "edible for this creature" predicate.** Both the food *sensor*
classifier and the `eat` *action* target use the **same** test:
`effectiveCapture(entity, creature) > 0`, i.e. `typeYield(diet) × digestionEfficiency > 0`.
`digestionEfficiency` is clamped to a strictly positive minimum *(tunable)* so it
is never exactly 0 — this keeps the sensor and the action from ever disagreeing
about what counts as food (the two must use one predicate, not two).

**Corpse (scavenging) eligibility is a soft consequence of this curve, not a hard
gate:** a pure herbivore (diet = 0) gets `meatYield = 0` and so gains nothing from
a corpse (it will not fire `eat` on one usefully), while an omnivore or carnivore
does. Nothing is hard-forbidden; evolution climbs the gradient. `eat` targets the
nearest food-eligible entity in reach per the canonical predicate above.

---

## Parameters & Costs — every trait has a cost

The single most important rule: **every functional trait has a cost**, or
evolution maxes it and nothing is learned. Values *(tunable)* are starting points
for the sweep.

| Gene | Effect | Cost |
|---|---|---|
| `size` | wins contests; larger energy store | ↑ metabolic drain/tick; slower accel per unit `speed`; more energy to reach maturity |
| `speed` | max velocity | movement energy scales with speed² |
| `senseRadius` | detection range | per-tick upkeep ∝ radius (or radius²) |
| `metabolism` | scales how much a creature acts per tick: max acceleration and max turn rate are multiplied by `metabolism` (a high-metabolism creature moves and reacts more per tick) | baseline per-tick energy drain ∝ `metabolism` (faster living costs more even at rest) |
| `aggression` | attack power; initiates combat | energy per attack; injury risk on failed attack |
| `diet` (0..1) | sets plant vs meat capture via the continuous eat-efficiency curve (see Diet) | specializing gives high yield on one food and near-zero on the other; omnivores pay by being mediocre at both |
| `circadian` (0..1) | activity phase | off-phase activity → reduced sense & efficiency |
| `nightVision` | preserves vision in dark | flat upkeep even in daylight |
| `armor` | reduces damage taken | added mass → ↑ metabolism + slower accel |
| `toxicity` | damages/deters attacker | per-tick upkeep to maintain toxin |
| `offspringInvestment` | energy packed per offspring | fewer offspring per unit energy; parental depletion |
| `matingThreshold` | energy required to mate | high = safe but rare; low = risky, may mate near starvation |
| `maxLifespan` | hard age ceiling | longer life → ↑ cumulative senescence cost |
| `digestionEfficiency` | fraction of consumed energy captured | ↑ efficiency → ↑ baseline metabolic upkeep |

**Baseline metabolic cost** is deducted every tick regardless of action, scaled
by `size` and `metabolism`. **Action costs** (move, attack, mate, emit) are
deducted at resolve time. All costs are in integer energy quanta.

---

## Energy — closed system

**Total energy is conserved and asserted in a property test** — energy is only
ever *moved* between compartments, never created or destroyed. Conservation is
exact because energy is integer quanta. The word "closed" is meant literally: the
sim has **no source and no sink**. Sunlight is not new energy and metabolic heat
does not vanish; both are transfers to and from a finite reservoir that is itself
part of the conserved sum.

### The conserved quantity

`stats.ts` exposes one authoritative function, `totalEnergy(world)`, which the sim
and the conservation test both call. It is the exact integer sum over every
compartment:

```
totalEnergy(world) =
    solarReservoir                     // the "sky": finite pool sunlight is drawn from
  + Σ creature.energy                  // living agents
  + Σ plant.energy                     // plants
  + Σ corpse.energy                    // corpses awaiting decay/scavenging
  + Σ fertilityField[cell]             // soil
  + Σ lightField[cell]                 // light emitted this day, not yet absorbed
```

The invariant is `totalEnergy(after) === totalEnergy(before)` — exact equality,
every tick. There is no epsilon.

### The energy cycle (every transfer names both endpoints)

1. **Solar reservoir → light field (daytime only).** Each tick a fixed budget is
   **transferred out of `solarReservoir` into the light field**, distributed over
   day-lit cells. At night no transfer occurs (the reservoir just holds), which is
   what makes day/night meaningful. Light is not minted — it is drawn from a
   finite sky, so a long night depletes nothing and a long day cannot exceed the
   reservoir.
2. **Light field → plants.** Plants convert light in their cell (plus local
   fertility, see step 6) into stored energy, up to a genome-determined maximum
   size. A plant cannot photosynthesize in darkness.
   **Unabsorbed light decays back to the solar reservoir.** Each tick, a fixed
   fraction *(tunable, `LIGHT_DECAY`)* of every light-field cell's contents is
   **transferred back into `solarReservoir`** (unabsorbed sunlight radiates away).
   Without this, `solarReservoir` would drain monotonically into an
   ever-accumulating `lightField` and day/night would stop meaning anything after
   the first few days. Photons the plants miss are not lost from the closed sum —
   they return to the sky. This makes the light field a genuine *this-day* buffer
   (matching the `totalEnergy` comment) rather than a permanent sink, and it is the
   light-side mirror of metabolic heat (step 4).
3. **Plants → creatures.** `eat` transfers energy from a plant to the creature,
   scaled by the diet-efficiency curve (see Actions / diet). **Energy lost to
   inefficiency is not destroyed** — it transfers to the local fertility field
   (digestive return).
4. **Metabolic heat → solar reservoir.** Every per-tick cost (baseline
   metabolism, movement, action costs, senescence) is **not destroyed**: the
   burned energy is transferred **back into `solarReservoir`** as heat. This is
   the sink half of the closed loop and the single most important accounting rule
   in the sim — without it, the conservation test fails on tick 1. (Physically:
   metabolism radiates heat to the sky; the sky re-emits it as tomorrow's
   sunlight.)
5. **Creatures → corpses → {scavengers | soil}.** On death a creature's remaining
   energy becomes a **corpse object** at its position (see Removal & Corpses).
   Each tick an un-eaten corpse transfers a fraction of its energy into its local
   fertility cell and loses exactly that amount; at 0 it is removed. A scavenger
   `eat`-ing a corpse transfers corpse energy to itself (diet-scaled, inefficiency
   → fertility, as in step 3).
6. **Fertility field → plants.** Plants draw fertility to grow (step 2), closing
   the loop back to the reservoir via metabolism and decay.
7. **Parents → offspring (birth).** A newborn's starting energy is **transferred
   from its parent(s)**, never minted: `offspringInvestment` sets the quantum moved
   per parent into the child at birth (both parents contribute in sexual
   reproduction; the single parent pays in plant clonal seeding). This is the
   "parental depletion" cost in the Parameters table. A birth that a parent cannot
   afford does not occur. Because the energy is moved, not created,
   `totalEnergy` is unchanged by any birth.

`solarReservoir` is **mutable World state** (a single integer that rises and falls
every tick as energy flows in and out), not a `Config` value and not a build-time
constant. Its *initial* size is set at world creation so daytime influx and
metabolic/decay efflux reach a rough steady state; that initial size is *(tunable)*
and lives in `Config`, but the running reservoir balance is part of the serialized
World snapshot alongside the fields it exchanges energy with.

### Water — a second independent closed ledger

Hydration is tracked and conserved **separately** from energy; the two never mix.
Water lives in two compartments only, and `stats.ts` exposes `totalWater(world)`:

```
totalWater(world) = Σ waterField[cell] + Σ creature.hydration
```

- `drink` transfers water from the local water-field cell into the creature's
  hydration store.
- Hydration decays each tick (loss) and the lost amount transfers **back into the
  local water-field cell** — nowhere else. There is no atmosphere/evaporation
  compartment in beta.
- On death, a creature's hydration transfers back to its local water cell (so the
  water books close on removal); its *energy* routes through the corpse path
  independently.
- **At birth, a newborn's starting hydration is transferred from the parent(s)**,
  never minted — the water mirror of the energy birth-transfer (Energy step 7). A
  newborn with zero starting hydration is permitted (it must `drink` immediately),
  but any nonzero starting hydration must come out of a parent's store so
  `totalWater` is unchanged by the birth. Plants hold no hydration, so plant
  seeding moves no water.

The invariant is `totalWater(after) === totalWater(before)`, exact, every tick.

> **Clouds/rain and evaporation are explicitly out of beta.** They would require a
> third (atmosphere) water compartment with evaporation and rainfall transfer
> rules; until those are specified, water is a strict field↔hydration system. See
> Space & Fields.

---

## Plant Lifecycle

Plants are passive organisms: genomes and evolution, but no brain. Their
"decision" is a formula.

- **Growth.** Each tick, if `light > LIGHT_THRESHOLD` and `fertility >
  FERTILITY_THRESHOLD` at the plant's cell (both named constants in `constants.ts`,
  *(tunable)*), the plant converts a bounded amount of light + fertility into stored
  energy. The per-tick conversion is capped by both a rate constant
  `PLANT_GROWTH_MAX` *(tunable)* and by the plant's remaining storage headroom
  (`maxSize` expressed value minus current `plant.energy`). **The transfer is
  headroom-limited, so no energy is destroyed at the size cap:** the plant draws
  from `lightField` and `fertilityField` **only** the quanta it can actually store,
  leaving the unabsorbed remainder in those fields (light then decays back to the
  reservoir per Energy step 2). A plant at `maxSize` draws nothing. The gain to
  `plant.energy` exactly equals the sum drawn from the two fields.
  **Plants never touch the water ledger** — they gate on the fertility field, not
  the water field. Water is a strict creature-only system (`drink` → hydration →
  decay → water field), so adding plants as a water consumer is a version bump,
  not a beta feature. This keeps `totalWater` conservation (see Water) trivially
  closed over exactly two compartments.
- **Height competition.** Plants have a `height` gene. Taller plants capture more
  light in a shared cell; shorter neighbors are shaded (receive reduced light).
  This is a real evolutionary arms race with zero neurons — cost of height is
  slower maturation / higher fertility demand.
- **Seeding.** On reaching reproductive size a plant spends energy to spawn seeds.
  A `dispersal` gene controls seed placement (near = dense stands, far = colonize
  refuges), drawn from the `spawn` sub-stream. Seeds are energy-costed so a plant
  cannot seed for free. **Plant reproduction is asexual (clonal) in v1:** a seed
  copies the parent's two homologs verbatim, then the `mutation` sub-stream applies
  the same per-allele trait/`hue` mutation rules used for creatures. There is no
  plant meiosis, no plant crossover, and no pollination in beta — a single plant is
  a seed's only parent. (Sexual plants are a deliberate later addition; adding them
  is a version bump, not a beta feature.) Because seeds carry both parent homologs,
  plant diploidy still hides recessive variation via the mean-expression rule even
  without sex.
- **Grazing to local extinction is possible.** Nothing protects a stand from being
  eaten out; recolonization depends on surviving seeds/dispersal.
- **Plant death & decomposition.** A plant is removed when its energy reaches `0`
  (fully grazed) or when it reaches a genome-determined `maxAge` *(tunable per
  gene, optional in v1 — a plant with no age ceiling simply lives until grazed)*.
  **A plant does not leave a corpse** — corpses are meat, and plants are not meat.
  On death, any residual plant energy transfers **directly into the local fertility
  field** (decomposition), the same destination as corpse decay's soil return, then
  the plant is removed. This keeps plant energy on the closed ledger without adding
  a plant-corpse compartment to `totalEnergy` (which lists only `corpse.energy`).
  A plant removed at exactly `0` energy transfers nothing.
- **Defenses evolve in response to herbivory.** Plants carry a `toughness` gene
  that reduces energy yielded when grazed, at a growth cost — an arms race against
  herbivore `digestionEfficiency`. (Named `toughness`, not `toxicity`, to keep it
  distinct from the creature `toxicity` gene, which has combat counter-damage
  semantics that do not apply to plants.)

**Plant genome (typed, so `serialize.ts` has a schema).** Plants are diploid like
creatures (two alleles per gene, expressed as the mean) but have **no brain
arrays** — the entire genome is trait genes plus the neutral `hue` marker:

```ts
interface PlantGenome {
  maxSize: [number, number];        // reproductive/energy-storage ceiling
  height: [number, number];         // light-capture vs. shading (arms race)
  dispersal: [number, number];      // seed placement: near (dense) ↔ far (refuge)
  toughness: [number, number];      // energy withheld when grazed; growth cost
  seedInvestment: [number, number]; // energy packed per seed
  maxAge: [number, number];         // hard age ceiling; high value ≈ effectively immortal-until-grazed
  hue: [number, number];            // neutral lineage marker, 0..360 (as creatures)
}
```

Plant energy is part of the closed pool: light that becomes plant energy, energy
grazed away, and energy returned via corpses/decay all balance.

---

## Removal Conditions & Corpses

A creature is removed from the world when **any** of:

1. **Starvation** — energy reaches 0.
2. **Dehydration** — hydration reaches 0.
3. **Lethal damage** — health reaches 0 (from combat or toxicity).
4. **Old age** — age reaches `maxLifespan`. Aging is **soft senescence with a
   hard ceiling**: metabolic cost rises and efficiency falls as age approaches
   `maxLifespan`, and `maxLifespan` is an absolute backstop. "No aging" produces
   immortal creatures and breaks everything, so aging is mandatory.

**On removal:** the creature's remaining energy becomes a **corpse object** at its
position, entered into the spatial hash, serialized, rendered, and counted in
`totalEnergy` (as `corpse.energy`). Its hydration transfers back to the local
water cell (Water ledger) **in full at the moment of death**. **A corpse carries
energy but never water** — it has no `hydration` field and contributes nothing to
`totalWater`. The two ledgers are decoupled at death by construction: energy takes
the slow corpse→fertility path, water evacuates instantly to the water field.
Adding `corpse.hydration` would silently break `totalWater` conservation, so it is
explicitly forbidden. Corpses are scavengeable (a creature whose diet yields
> 0 on meat may `eat` a corpse — see diet curve), which creates a scavenger niche
for free. Un-eaten corpses transfer energy into the local fertility field each
tick (Energy step 5). **Corpse decay per tick is
`decayed = max(1, floor(corpse.energy × CORPSE_DECAY_FRACTION))`**, clamped so it
never exceeds the corpse's remaining energy — the `max(1, …)` floor guarantees a
corpse with ≥1 quantum always loses at least one quantum, so integer fractional
decay still reaches `0` in finite ticks (a plain `floor(fraction × 1)` would round
to 0 and strand the corpse forever). A corpse is removed the tick its energy
reaches exactly `0`; the final tick transfers whatever remains (≤ the fraction
would give) so the corpse gives up all quanta and is removed. No "≈": exact integer
accounting throughout.

**Health has a defined maximum.** A creature's `health` ranges `0..maxHealth`,
where `maxHealth` is an expressed function of `size` and `armor` *(exact form a
named constant in `constants.ts`, tunable)* — bigger, more armored creatures have
more hit points. Sensor #4 ("own health, 0..1") is `health / maxHealth`. Removal
condition #3 fires when `health` reaches `0`.

> **Design decision (not derived from prior text).** The original spec named
> `health` as a `0..1` sensor and a removal condition but never stated what sets its
> maximum. Tying `maxHealth` to `size` and `armor` is a new modeling choice made to
> give the sensor a concrete referent; it is plausible (armored/large creatures take
> more punishment) but not a consequence of any earlier section. Tunable — revisit
> if it distorts the combat balance during the sweep.

Without a defined `maxHealth` the
sensor normalization and the damage system have no referent, so it is fixed here.

**Health regeneration.** Damage is not a one-way ratchet. When a creature's energy
is above a *(tunable)* threshold, health regenerates a small amount per tick (never
above `maxHealth`), and the regenerated health is **paid for in energy** — the
transfer names **both** endpoints: `creature.energy` is decremented by exactly the
heal cost and `solarReservoir` is incremented by the same amount (heat, per Energy
step 4). A heal the creature cannot afford does not occur. Below the energy
threshold, no regeneration: a starving creature cannot also heal. This keeps
`armor`/`toxicity` from being the only viable defenses and lets wounded prey recover
between predator encounters — a precondition for sustained predator-prey
oscillation rather than a monotonic slide to extinction.

**Density-dependent removal** (a stabilizer): local crowding imposes a
disease/competition penalty scaling with local population density, raising damage
or metabolic cost — nature's main brake on monoculture explosion. **This penalty
and sensor #11 read the same density from one canonical function**
(`localDensity(pos)` in `spatial.ts`, a spatial-hash query over living agents
within a fixed radius, *(tunable)*). There is exactly one density definition in the
sim: the sensor and the removal rule must never diverge into two. Sensor #11 is
that value normalized to `0..1`; the removal penalty is a function of the same raw
count.
Any such damage that kills routes energy through the corpse path; any metabolic
surcharge routes to the solar reservoir as heat.

---

## Contests (predation & combat resolution)

This single mechanic determines whether predator–prey oscillation happens at all,
so it is fully specified.

**Ranges & reach (distinct quantities, both in world units, both named in
`constants.ts`):**
- **`senseRadius`** (a gene) — how far a creature *perceives*. Sensor distances
  5/7/9 are normalized to `0..1` as `clamp(dist / senseRadius)`; anything beyond
  `senseRadius` is not perceived (reported as 1.0 / "nothing"). This is a hard
  perception cap.
- **Interaction reach** — how close a creature must be to `eat`/`drink`/`attack`/
  `mate`. Reach = `REACH_BASE + REACH_PER_SIZE × size` (a small constant plus a
  size term); it is *not* a separate gene in v1. Reach ≪ `senseRadius` always.

When a creature fires `attack` on a target in reach:

1. **Escape check first.** The target may evade. Functional form (exact constants
   *(tunable)* in `constants.ts`):
   `P(escape) = sigmoid( k_speed × (target.speed − attacker.speed) + k_angle × offHeading )`,
   where `offHeading ∈ [0,1]` is how far the target is off the attacker's heading
   (0 = dead ahead, 1 = behind). A successful escape ends the contest; **the
   attacker still pays the attack energy cost** (a failed attack is not free —
   this is what keeps aggression in check). The draw uses the `resolve` sub-stream.
2. **Contest, if not escaped.** Attacker power = `aggression × size`; defender
   resistance = `armor × size` (+ `toxicity` contributes counter-damage). Outcome
   is probabilistic:
   `P(attacker wins) = power / (power + resistance)`, drawn from the `resolve`
   sub-stream.
3. **On attacker win.** The attacker deals damage to the target (may be lethal →
   target removed via corpse path). The attacker gains energy only by
   subsequently `eat`-ing the corpse — the kill itself does not teleport energy,
   keeping the books closed and rewarding actual feeding.
4. **On defender win / toxicity.** The attacker takes counter-damage scaled by
   the defender's `toxicity` and `armor`; both pay their action costs.

All contest *outcome* draws (escape, attacker-wins) come from the seeded `resolve`
sub-stream; the *order* in which contests are processed is the seeded
`resolve-shuffle` order (see RNG Discipline). The two streams are independent, so
adding a contest draw never perturbs the processing order.

---

## The Tick Loop

`sense → think → act → resolve`, double-buffered.

1. **Sense (double-buffered).** Every agent reads its 18 sensors from an
   **immutable snapshot** of the previous world state. No agent sees another's
   move this tick → no first-mover advantage.
2. **Think.** Each brain runs its forward pass (or the rule-based policy in
   Phases 0–3) on its senses + recurrent memory, producing 7 action outputs.
3. **Act.** Intended actions are collected (not yet applied).
4. **Resolve.** Applied as a **fixed sequence of sub-phases**, so the whole tick is
   deterministic end to end:

   1. **Agent actions**, processed in **seeded-shuffle order** drawn from the
      `resolve-shuffle` sub-stream (randomized but reproducible): movement, eat,
      drink, attack/contests, mate/births, emit scent. Conflicts (two creatures
      eating the same plant, attacking the same target) are decided by this order.
   2. **Removals**, processed in **ascending entity `id` order** (not shuffle
      order — a fixed, total, deterministic order): creature starvation, dehydration,
      lethal damage, old age; and plant death (fully grazed or `maxAge`). Each
      creature removal spawns its corpse and returns hydration to the water cell;
      each plant removal returns residual `plant.energy` to the local fertility cell
      (decomposition). Ascending-`id` ordering makes simultaneous deaths writing the
      same fertility/water cell fully reproducible.
   3. **Plant updates**, processed in **ascending plant `id` order**: photosynthesis
      (`lightField` + `fertilityField` → `plant.energy`, headroom-limited per Plant
      Lifecycle) and seeding (parent `plant.energy` → seed `plant.energy`, placement
      via the `spawn` sub-stream). Plants are passive, not agents, so they are not in
      sub-phase 1; giving them their own fixed-order sub-phase keeps the tick
      deterministic. This runs **before** field updates so plants photosynthesize
      against the light present at the *start* of the tick.
   4. **Field updates**, in this fixed order: corpse decay → hydration decay →
      diffusion/decay of all fields → solar→light influx → unabsorbed-light decay
      back to the reservoir.

   The **field updates run after all agent and plant field-reads/writes** (sub-phases
   1–3), so a plant photosynthesizes against the light present at the *start* of the
   tick and the day's fresh influx lands afterward — a fixed, unambiguous ordering
   rather than an interleaving whose outcome depends on agent or plant index.

**Every energy and water transfer named anywhere in this spec — eat, drink,
metabolism, movement, action costs, healing, senescence, corpse decay, solar
influx, unabsorbed-light decay, hydration decay, density surcharges, plant
photosynthesis, plant seeding, plant decomposition, and birth energy/water
transfers — happens inside resolve** (in the sub-phase named above for each). The
`totalEnergy(after) === totalEnergy(before)` and `totalWater(after) ===
totalWater(before)` assertions are evaluated at the tick boundary, *after* resolve
completes. No transfer occurs in sense, think, or act. This is what makes the
conservation invariant well-defined: there is exactly one phase in which the
conserved sums may move, and they must net to zero across it.

Iteration everywhere is index-based over a stable ID array. Never a `Set` or
`Object.keys()`.

---

## Initial Conditions

Generation zero is **hand-seeded and spatially clustered**, not pure noise,
because a noise-seeded *sexual* world may never bootstrap: the first creature to
eat must do so by chance *and* find a compatible mate before starving, and the
Allee effect makes small populations spiral.

- **Founders:** 40–100 creatures *(tunable)*, drawn as lightly-randomized copies
  of a small number of viable seed genomes. **Both the genome jitter and the
  placement of founders draw from the `spawn` sub-stream** — world creation is
  entirely pre-tick and self-contained on one stream, so seed reproducibility of
  generation zero is well-defined.
- **Clustering:** founders spawn in a few spatial demes so compatible mates are
  findable despite the Allee effect.
- **Plants:** pre-seeded at moderate density so the first eaters do not starve by
  chance.
- **Seed brains (Phase 4, shipped).** Under `brainKind:'patchbay'`, founder brains
  are **minimal and clumsy** — a small purposeful sub-circuit overlaid on the sparse
  random base (food/mate angle → a hidden neuron → turn; bias → forward drive; bias →
  eat/mate gates), enough to forage and seek mates, nothing more. Everything
  interesting still evolves from there; a non-random generation zero does not cheapen
  emergent behavior. Under `brainKind:'rule'` the founder template is left as the
  sparse random base (the rule policy ignores brain arrays), so rule-world founder
  fingerprints are unchanged.
- A **pure-noise start** is offered as a config option for those who want to watch
  bootstrapping succeed or fail.
- Note: in Phases 0–3 agents are rule-based, so the founder-brain decision only
  becomes live at Phase 4. Clustering + plant pre-seeding are needed from Phase 0.

---

## World-Health Metrics (balance as search, not taste)

The goal is **interesting, not surviving**. A world kept trivially alive (crank
regrowth, drop metabolism) is immortal and boring and must score *low*.

```ts
interface WorldHealth {
  survivalTicks: number;        // reached the horizon?
  meanPopulation: number;       // neither starving nor exploding
  populationVariance: number;   // oscillation — HIGH is good
  traitVariance: number;        // genetic diversity maintained?
  speciesCount: number;         // did it diversify?
  extinctionEvents: number;     // some drama good, total collapse bad
  behaviorNovelty: number;      // hardest to define
}
```

- `traitVariance` = mean, over functional trait genes, of the population variance
  of each gene's expressed value (normalized per gene).
- `speciesCount` = number of clusters under the genetic-distance metric,
  recomputed ~every 500 ticks by threshold clustering on the compatibility
  distance.
- `populationVariance` is **rewarded, not penalized** — a stagnant world scores
  high on survival and near-zero on variance, and that must read as *bad* or the
  sweep optimizes into the boring corner.
- `behaviorNovelty` is acknowledged as the hardest to define; a starting proxy is
  the variance/entropy of realized action-distributions across the population.

**Method:** random-sample a few hundred configs → run each headless for 100k
ticks → dump CSV → rank. Expect the habitable band to be narrow and strangely
shaped.

**Known stabilizers, all in scope:** density-dependent effects (crowding/disease),
spatial heterogeneity (fertile valleys, barren ridges → refuges for losing
strategies), non-transitive trait trade-offs (fast-small beats slow-large beats
medium-armored beats fast-small — rock-paper-scissors is the most reliable
anti-stagnation mechanism), and environmental cycling (seasons long enough that
summer adaptation is winter maladaptation — the optimum *moves*).

---

## Space & Fields

- **Continuous** agent positions and headings; agents move by velocity. A
  **spatial hash** for neighbor queries exists from day one.
- **Gridded fields** — water, temperature, light, scent, fertility — each a typed
  array the size of the grid, updated by diffusion/decay rules. **Ledger-bearing
  fields use an integer typed array, not `Float32Array`:** light, fertility, and
  water carry integer quanta and back the exact-`===` conservation sums, so they are
  `Int32Array` (or `Uint32Array`) to avoid the ≥2²⁴ precision loss a `Float32Array`
  would introduce into a large integer sum. Non-conserved modulator fields
  (temperature, scent) may remain `Float32Array` since they never enter a
  conservation assertion. **Clouds/rain are out of beta** — they would open the
  water ledger with an atmosphere compartment that is not specified here.
- **World dimensions and grid resolution are part of the serialized `Config`,
  not build-time constants** (overlooked-item fix) — otherwise loading an old
  save after changing them corrupts neighbor queries and field indexing. Grid
  resolution is simultaneously a fidelity knob, a save-size knob, and a
  catch-up-speed knob.
- **Edges are walls + terrain, not a torus.** Edge effects — isolation, refuges,
  chokepoints — are *desirable*; they drive speciation. A torus is cleaner and
  biologically boring.
- **Day/night is selection pressure, not decoration.** Plants photosynthesize only
  in light; temperature drops at night (small creatures lose heat faster → a
  nocturnal size cost); vision shrinks in the dark unless `nightVision` pays for
  it; scent is light-independent. With a `circadian` gene and a light sensor,
  nocturnal species evolve unprompted. Day length is a swept config parameter.
- **Temperature is a cost modulator, not its own gene axis in v1.** Creatures do
  not carry a `preferredTemperature` gene; instead local temperature modulates the
  *existing* metabolic cost as a function of `size` (small bodies lose heat faster,
  so cold cells tax small creatures more) and activity phase (`circadian`). This
  makes temperature a real, heritable selection pressure — responded to through
  `size` and `circadian` — without adding a gene. A dedicated thermoregulation
  gene is a deliberate later addition (version bump), not a v1 axis. Any
  temperature surcharge is metabolic and routes to the solar reservoir as heat
  (Energy step 4).

---

## Persistence & Save Format

| What | Where |
|---|---|
| Seed + config (the shareable world) | URL hash — `#seed=8412&mut=0.03` |
| UI preferences | localStorage |
| Saved snapshots, autosave | IndexedDB (`idb-keyval`) |
| Exported worlds / creatures | File download, gzip via `CompressionStream` |
| Nothing | Cookies |

**Rules:**

- `serialize()` / `deserialize()` live in `sim/`, pure and versioned. Autosave,
  download, and headless checkpointing all call the same two functions.
- **A `version` in every snapshot from the first write** (started at `1`; **now
  `3`**). v1→v2 (Phase 4) defaults a missing `config.brainKind` to `'rule'` so a
  pre-brain save keeps running the rule policy; v2→v3 (Phase 5A.3) defaults the
  lineage-identity + typed-event fields (`lineageRoots`, `lineageEvents`, `dominant`,
  `rootPopSnapshots`) so an older save loads and simply starts lineage tracking from
  reload (no fabricated history). Rotating-slot autosave + offline catch-up are live:
  the worker autosaves to IndexedDB (`world:a`/`world:b` + `meta`, write-older-then-flip)
  on a ~30 s wall-clock timer and on tab-hide; on reopen it replays the ticks owed since
  the save (capped at `MAX_OFFLINE_TICKS`) using the same `tick()` — bit-identical to
  live ticks (`tests/sim/catchup.test.ts`).
- **Save-migration policy (overlooked-item fix, decided now):** forward migrations
  live in `serialize.ts` as `migrate_vN_to_vN+1()` functions; `deserialize()`
  detects an older `version` and upgrades in place before use. Old worlds are
  never silently discarded. Every serialized field is individually optional/
  defaulted so a `version: N` reader can load a `version: <N` blob. Seed
  reproducibility is guaranteed *within* a version, not necessarily across.
  (`deserialize()` also spread-copies mutable per-creature sub-objects like
  `ruleState`, so two loads of one blob never alias shared state — a determinism
  bug found and fixed during Phase 4.)
- **World dimensions, grid resolution, all tunable constants, and the RNG
  sub-stream layout are part of the serialized snapshot**, so a save is
  self-describing.
- **Each RNG sub-stream's *live internal state* is serialized, not just the
  seed.** `mulberry32` is a single 32-bit integer of state per stream; the
  snapshot stores the current state word of every named sub-stream. This is what
  makes the serialization-roundtrip property hold across a save boundary —
  resuming continues each stream mid-sequence rather than restarting it. Storing
  only the seed would replay already-consumed draws and diverge on the first tick
  after load.
- **The derived brain `weights`/`enabled` cache is *not* serialized** (see Brain
  weight expression) — it is re-derived from the stored homologs on load, keeping
  the canonical save shape to two homologs per creature.
- **Rotating slot pair** (`world:a`, `world:b`) with a `meta` record pointing at
  the newest valid one — a crash mid-write loses one autosave, not the world.
- Autosave on an interval (~30s sim time) **and** on `visibilitychange`. **Never
  rely on `beforeunload`** (doesn't fire when a mobile browser kills the tab).
- Store `lastSavedRealTime` in the snapshot (needed for catch-up).
- **Free test:** 500 ticks → serialize → deserialize → 500 more ≡ a straight
  1000-tick run. Passing proves the save system *and* determinism.

---

## Offline Catch-up

Nothing runs while the tab is closed — no server, no service worker. There is no
closed-form shortcut (evolution is chaotic); catch-up means literally calling
`tick()` N times:

```ts
const ticksOwed = Math.min(
  Math.floor((Date.now() - snapshot.lastSavedRealTime) / MS_PER_TICK),
  MAX_OFFLINE_TICKS
);
for (let i = 0; i < ticksOwed; i++) tick(world);
```

- **`MAX_OFFLINE_TICKS` is mandatory** and chosen (after benchmarking) so the
  worst case is under ~20 seconds of catch-up.
- **Catch-up runs stripped down:** no rendering, stats sampled every 100th tick,
  lineage recorded as aggregate counts (not tree nodes), progress posted every
  ~5,000 ticks.
- **"While you were away" report** — the retention mechanic. Lead with drama
  ("Generation 4,802. The northern herbivores are extinct. A new predator lineage
  doubled in size."), powered by an event log `{ tick, realTime, event }` stored
  alongside the snapshot.
- **A toggle** disables catch-up for users who want a world that advances only
  while watched.

---

## Lineage & Long-Run Memory

- **`parentId` is stored on every creature from commit one** — phylogeny cannot be
  reconstructed after the fact.
- **Species are emergent** from the mating-compatibility threshold; derived
  clustering for charts is recomputed ~every 500 ticks.
- **Unbounded memory is a designed-for failure mode.** Keep full detail for a
  recent window; **downsample older history** (1 point / 1,000 ticks) and prune
  dead lineage branches, retaining only ancestors of living creatures plus
  summaries of notable extinct lineages. The downsampled-history shape is part of
  the `version: 1` snapshot schema so adding it later is not a migration.

---

## Testing (invariants, not examples)

Vitest with `environment: 'node'` (never jsdom — a sim test that passes because
jsdom supplied a `window` has destroyed the guarantee it checks). Mostly
**invariants over random inputs** via **fast-check**, which shrinks to the
minimal failing case.

| Property | Statement |
|---|---|
| Determinism | For any seed, two 1,000-tick runs produce identical state |
| Serialization roundtrip | `tick^N → serialize → deserialize` ≡ `serialize → deserialize → tick^N` |
| Energy conservation | Total energy after a tick equals before, **exactly** (integer quanta) |
| Water conservation | Total water after a tick equals before, exactly |
| Distance metric | `distance(a,b) === distance(b,a)` and `distance(a,a) === 0` |
| Inheritance (sexual) | For a creature child, every gene allele came from one of its two parents |
| Inheritance (clonal) | For a plant seed, every gene allele equals the single parent's corresponding allele (pre-mutation) |

**Benchmarks (`vitest bench`)** cover the tick loop at a representative
population size — needed to choose `MAX_OFFLINE_TICKS` from the real tick rate and
to catch quiet performance regressions on the commit that introduces them.

---

## Build Order

Brains are **Phase 4, not Phase 1** — brains on an unbalanced world evolve to die
efficiently.

| Phase | Contents |
|---|---|
| **0 — invisible** | `constants.ts`, `types.ts`, `rng.ts`, `world.ts`, `energy.ts`, `genetics.ts`, `tick.ts`, `brain.ts` (with `RuleBasedBrain` implementing `BrainOps`). Vitest determinism + energy/water-conservation assertions. Population counts printed to terminal. No rendering. Rule-based agents. Clustered founders + pre-seeded plants. |
| **1 — the instrument** | Headless runner, world-health metrics, sweep script, throwaway ~50-line debug canvas. **Do not proceed until a config oscillates and diversifies for 100k ticks.** |
| **2 — the window** | Web Worker, real canvas renderer, genome-derived appearance, day/night tint, trails, camera. |
| **3 — the sandbox** | Inspector, param sliders, spawn/delete/paint, follow-cam, pause/step/speed. **Ship it.** |
| **4 — brains** ✅ shipped | Config-selectable `PatchbayBrain` (fixed-skeleton forward pass, pinned activation, recurrence); sensor/action seam in `tick.ts`; same-seed A/B vs rule (`scripts/compare.ts`); brain-capacity instruments + verdict (`docs/findings/phase-4-brain-capacity.md`). **Verdict: keep patchbay.** Save format bumped v1→v2. |
| **5A–5C** ✅ shipped | Persistence (IndexedDB rotating slots) + offline catch-up + "while you were away" report → shareable URL + gzip export/import → observability (timeline scrubber, lineage-population speciation view) + pre-evolved cold open → seasonal/day-night temperature (a cold metabolic surcharge selecting through `size`). **Beta DoD met.** |
| **5D+** (post-beta) | Terrarium / Laboratory modes → LLM naturalist → hall-of-fame backend. Deferred (§Non-Goals); gated on demand. |

---

## Player Experience (beta scope)

- **Aquarium (default sandbox).** No goal, no score. Full god powers: paint
  terrain, spawn creatures, edit genomes live, drag sliders, trigger a drought.
  Full stats always visible — **never hide information; information is the
  reward.**
- Retention hedges, all mandatory: a **pre-evolved cold open** (ship a
  generation-2,000 snapshot where predators already hunt — the first eight seconds
  show emergence, not potential); **follow-cam** (click to lock the camera to one
  creature; announce its death, age, and offspring count); and **persistence + the
  "while you were away" report**.
- **A real front door.** The app opens on a welcoming landing screen (a live,
  dimmed sim rendering behind it) whose primary action — "Enter the living world" —
  drops the visitor into the **pre-evolved cold open** (emergence, not an empty
  founder world). Secondary "Start a fresh world" (evolution from scratch, honestly
  labeled) and "Continue" (shown only when a save exists) are offered. A shared-URL
  deep link skips the landing and enters that world directly. The world source is
  chosen by the caller via an additive `boot` source selector (`continue` /
  `cold-open` / `fresh`); an absent selector preserves the historical precedence
  (saved > cold-open > founders). *(This supersedes the earlier boot-straight-in
  behavior.)*
- **Onboarding welcomes, then gets out of the way** — not a forced tutorial, but a
  newcomer must be able to understand the world. A **persistent, reopenable legend**
  decodes the visual language (hue = lineage, angular = carnivore, spikes =
  armor/toxicity, washed-out = starving, ring = age); a reopenable **help/controls**
  affordance and **on-screen zoom controls** make interaction discoverable; and a
  short, dismissible, **re-openable** first-run coachmark points at both. *(This
  supersedes the one-shot fade-out cold-open captions: comprehension is now
  recoverable, honoring "never hide information; information is the reward.")*
- **Terrarium** (stewardship budget, leaderboard) and **Laboratory** (forking:
  snapshot, branch, change one parameter, run both, compare) are **deferred to
  post-beta** but the save format must not preclude forking.

---

## Visual Design

A **beautiful, welcoming observatory** — a living world someone is glad to look at
and can actually understand. The design goals are **legibility under density** and
**a newcomer instantly "getting it" and enjoying it**. Beauty and warmth are
first-class here, not incidental. *(This supersedes the earlier "scientific
instrument, grayscale-only chrome, no game UI" direction.)*

- **The world is the richest thing on screen, but the chrome is themed, not
  austere.** A single token source (CSS custom properties + Tailwind theme) defines
  a deep-space base, translucent blurred panel surfaces, one bioluminescent
  teal→cyan **accent** (deliberately *not* the purple-on-white cliché), and sparse
  semantic colors. Theme via tokens; never hardcode.
- Dark UI chrome, and the world has a full day/night tint (a single color
  multiply / translucent overlay).
- Deliberate, non-generic design (executed under the frontend-design skill):
  purposeful typography, spacing, depth, and **sparing** motion — landing preview,
  panel transitions, coachmarks. Motion serves the design and respects
  `prefers-reduced-motion`; the simulation is still the star, never buried under
  animated chrome.
- **Monospace for all numbers**; a display face with character (not
  Inter/Roboto/system-default) for headings. Charts first-class and always visible.
- **Layout is a responsive app shell** (grid: top bar / canvas / bottom timeline;
  collapsible, scrollable left+right docks) — panels never clip or overlap, and the
  canvas is never squeezed off-screen. *(This supersedes the floating
  absolute-positioned panels.)*
- **Trails:** don't fully clear the canvas each frame — fill with a low-alpha
  black rect for near-free motion blur.
- Fields drawn as a low-opacity underlay to an offscreen canvas every N ticks.
- Timeline scrubber with tick marks at extinction events.

**Creature appearance is derived, never designed** — procedurally from the genome.
The pivot makes rendering *prettier* (soft radial gradient + glow tinted by hue,
clean tapered spikes, a subtle heading cue), but appearance stays a function of the
genes below — no designed sprites — so the visuals remain meaningful and the legend
can decode them. Gradient/glow work degrades past a creature-count threshold to hold
frame rate under density:

| Visual | Source |
|---|---|
| Size | `size` |
| Hue | `hue` (neutral lineage marker) |
| Saturation | current energy (starving = washed out) |
| Shape (round ↔ angular) | `diet`, interpolated |
| Spikes / ornaments | defense & display genes (`armor`, `toxicity`) |
| Faint outline ring | age |

---

## Key Decisions (index)

| Decision | Choice | Rationale |
|---|---|---|
| Platform | Browser, static, client-side | A clickable link beats an uncloned repo |
| `sim/` purity | Imports nothing | Buys tests, worker, headless runner |
| Space | Continuous agents, gridded fields | Motion looks alive; fields stay cheap |
| Edges | Walls + terrain | Edge effects drive speciation |
| Reproduction | Sexual, diploid, from commit one | Speciation *is* the breakdown of interbreeding; deferring sex forces a later rewrite of reproduction + species + save format |
| Brain | Fixed-skeleton patchbay | Shared address space dissolves competing-conventions; crossover is trivial |
| NEAT | Deferred, measured | Gated on enable-density + enlargement experiment |
| Energy | Closed, **integer quanta** | Exact conservation = best bug detector; keeps cross-engine reachable |
| Hydration | Second closed ledger | `drink` action + thirst need make water meaningful terrain |
| Turning | Signed angular velocity | No wraparound seam; reaches full 360° |
| Update order | Double-buffered sense, shuffled resolve | No first-mover advantage; reproducible conflict resolution |
| Determinism | On-machine baseline, cross-engine reachable | Pinned activation fn, integer energy, named RNG sub-streams |
| RNG | `mulberry32`, named sub-streams | Adding a consumer doesn't perturb other seeds |
| Persistence | URL hash + IndexedDB + file export | `version:1` from first write; forward migrations |
| Aging | Soft senescence + hard ceiling | "No aging" breaks everything |
| Corpses | Scavengeable object → fertility decay | Closes the energy loop; creates a scavenger niche |
| Contests | Escape check → probabilistic contest → eat-to-gain | Determines whether oscillation happens; failed attack still costs |
| Initial conditions | Hand-seeded, clustered founders | Noise-seeded sexual worlds may never bootstrap |

---

## Open Questions (deferred, non-blocking)

These do not block `types.ts` and can be resolved during the relevant phase:

- Exact numeric tuning of every *(tunable)* constant — the point of the Phase 1
  sweep; deliberately not fixed here.
- `behaviorNovelty` precise formula beyond the action-distribution-entropy proxy.
- Whether the pure-noise start ever becomes the default (empirical, Phase 1).
- Whether to add ray-cast vision, a second signal channel, or a share-energy
  action (each a version bump; deferred to the sensor/action ladder).
- When (if ever) to swap PatchbayBrain → NeatBrain (gated on the two instruments).
  **Interim answer (Phase 4): keep the patchbay** — enable density plateaus below 0.5;
  the enlargement instrument is inconclusive at short horizons. Revisit after a
  long-horizon (≥50k-tick, multi-seed) re-run. See `docs/findings/phase-4-brain-
  capacity.md`.
- Cross-engine determinism: whether to actually pay for it (only if a shared
  leaderboard ships).

---

## References

- Lineage of ideas: Conway's Life, SimEarth, Karl Sims' Evolved Virtual Creatures,
  NEAT / rtNEAT (Stanley), Braitenberg vehicles.
