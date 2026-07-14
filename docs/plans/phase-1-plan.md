# Phase 1 — The Instrument Plan

> **Goal:** Turn the invisible `sim/` core into a measurable instrument: headless
> CSV runner, world-health metrics, a parameter sweep, and a throwaway debug
> canvas — enough to find a config that oscillates and diversifies for 100k ticks.
> **Spec:** `docs/SPEC.md` — see **World-Health Metrics**, **Build Order** (Phase 1
> row), **Offline Catch-up** (bench → `MAX_OFFLINE_TICKS`), **Testing**
> (benchmarks).
> **Depends on:** Phase 0 complete and all Phase 0 exit criteria green.

## Scope & guardrails

- **This is the make-or-break phase** (SPEC.md §Goals: "the decision the project
  succeeds or fails on"). Its gate is empirical: **do not proceed to Phase 2 until
  a config oscillates and diversifies for 100k ticks** (SPEC.md Phase 1 row).
- **`sim/` purity still holds.** `stats.ts` lives in `sim/` (pure). The runner,
  sweep, and debug canvas live in `scripts/` and import only from `src/sim/`.
- **Empirically-gated tasks are marked.** Tasks whose *output is a number the sim
  produces* (tick rate, tuned constants, `MAX_OFFLINE_TICKS`) specify a
  **procedure and a gate**, not a guessed value. The tuned constants are written
  back into `constants.ts` as their now-measured values.
- **Constants-ownership rule (applies to every phase).** Any named constant a phase
  introduces (`SPECIES_SPATIAL_RADIUS`, `NOVELTY_SAMPLE`, `TRAIT_BINS`,
  `EXTINCT_SWEET`, `BOOM_WINDOW`, `DOMINANCE_WINDOW`, etc.) is **added to
  `constants.ts` in the task that introduces it**, with a `(tunable)` marker and a
  default, and included in the `constants.ts` presence-check test. `constants.ts` is
  the single home for every magic number across all phases — a later phase extends
  it, it does not fork a private constant.
- **No UI framework yet.** The debug canvas is ~50 throwaway lines of raw canvas
  (no React, no worker) — a debugging tool, not a product surface, so the
  `frontend-design` skill does **not** apply here. (It applies from Phase 2 on.)

---

## Task 1.1: World-health metrics in `stats.ts`

- **What:** Implement `WorldHealth` and the per-metric formulas from SPEC.md
  §World-Health Metrics.
- **Why:** Every ranking in the sweep depends on this being real math; it is the
  scalar the whole phase optimizes. Built first because the runner and sweep both
  consume it.
- **How:**
  - Extend `src/sim/stats.ts` (already holds `totalEnergy`/`totalWater` from Phase
    0.4) with `worldHealth(world, history): WorldHealth` returning the exact
    interface in SPEC.md (survivalTicks, meanPopulation, populationVariance,
    traitVariance, speciesCount, extinctionEvents, behaviorNovelty).
  - Formulas exactly per spec:
    - `traitVariance` = mean over functional trait genes of per-gene population
      variance of the **expressed** value, normalized **per gene by that gene's legal
      range** (from the trait's clamp bounds in `constants.ts`), so each gene
      contributes comparably. Enumerate "functional trait genes" as the `Genome`
      trait fields excluding neutral `hue`.
    - `speciesCount` = number of clusters, recomputed ~every 500 ticks. **Fixed
      algorithm: spatially-restricted, diameter-checked single-linkage.**
      Naive global single-linkage is *wrong for this metric*: its chaining pathology
      collapses a continuous genetic cline (the *expected* structure in a
      drift-driven sim, and the ring-species phenomenon) to a single cluster exactly
      when the world is most diversified — anti-correlating the metric with the
      diversification it's meant to reward. Two fixes, both applied:
      1. **Restrict edges to spatial-hash neighbors** (build the compatibility graph
         only between creatures within a `SPECIES_SPATIAL_RADIUS` of each other, via
         `spatial.ts`). Creatures far apart in space essentially never interbreed, so
         this is more biologically faithful (allopatric speciation is spatial) **and**
         turns the edge build from O(n²) into ~O(n·k). Edge exists when neighbors'
         `distance < SPECIES_COMPAT_THRESHOLD` (the shared Phase 0.1.1 constant).
         **`SPECIES_SPATIAL_RADIUS` changes the metric's *value*, not just its speed**
         (too small → every deme reads as its own species; too large → global chaining
         returns), so it is a named constant **included in the sweep's tunable set**
         (Task 1.5) with its sensitivity checked — `speciesCount` must not be an
         artifact of one hand-picked radius.
      2. **Diameter guard against chaining:** also emit, per cluster, its **max
         intra-cluster pairwise expressed-distance** (`maxDiameter`). A cluster whose
         diameter ≫ `SPECIES_COMPAT_THRESHOLD` is a cline, not one species; the sweep
         ranking (Task 1.5) reads `maxDiameter` so a chained mega-cluster does not
         masquerade as "diversified = 1 species, good." (Report both `speciesCount`
         and the diameters.)
      Union-find over the restricted edge set, index-based on the stable ID array,
      ascending-id tie handling — deterministic.
    - **Cluster *identity* is not stable across recomputations, and the metrics that
      need stable identity must not assume it.** Connected-component labels at tick
      1000 need not correspond to labels at tick 500. `speciesCount` (a count) is
      fine. But any consumer that tracks "*this* species' population over time"
      (Phase 2 `stats.population[]`, Phase 5 `lineageBoom`/`newDominant` events) must
      derive stable identity from **`parentId` ancestry — specifically the
      founder-lineage root**, defined as the single generation-zero founder reached
      by walking `parentId` back up the lineage. (One rule, not "root or MRCA" — a
      creature's founder root is unambiguous.) Use the pruned lineage tree (Task 1.2)
      — no new infrastructure. **Do NOT key identity on
      `hue`:** hue drifts freely and neutrally (SPEC.md §The Genome), so two unrelated
      lineages can drift to the same hue and collide, and a single lineage's hue
      drifts over long horizons — either failure merges/splits species wrongly and
      would make Phase 5's `newDominant` narrate confidently-wrong events. Hue may
      *decorate* a chart (it's what the eye reads) but must never be the join key.
    - `populationVariance` — a *reward* signal (high = good oscillation); document
      it so the sweep's ranking function does not penalize it (SPEC.md: stagnant
      worlds must score *bad*).
    - `behaviorNovelty` — **SPEC.md §Open Questions explicitly defers the precise
      formula.** Implement the named v1 proxy, fully pinned and marked provisional:
      - **Per-creature action histogram** over a trailing window of
        `NOVELTY_WINDOW` ticks (a named constant, default ~500). "Fired" is defined
        per action: the 5 gated actions (eat/drink/attack/mate/emit) count a fire
        when their gate fired that tick; the 2 continuous outputs (turn, accelerate)
        count a "fire" when `|output| > NOVELTY_ACT_EPS` (a named threshold) — so all
        7 have a well-defined fire predicate. Normalize to a distribution over 7.
      - **The window accumulator is per-creature runtime state and MUST be
        serialized** (add to Task 1.2 history + the Phase 0.9 schema) — otherwise
        novelty resets to noise after every autosave/catch-up and the 100k-tick sweep
        (which checkpoints) gets a discontinuous signal.
      - **Metric: subsampled mean pairwise Jensen–Shannon divergence — O(constant),
        and it measures the right thing.** Entropy (a within-distribution spread
        measure) is the *wrong* proxy: a population that has speciated into a hunter
        morph and a grazer morph — the emergent outcome the project exists to produce
        — gives each specialist a *peaked* (low-entropy) histogram, so mean entropy
        reads that as *low* novelty. Between-creature divergence is what "novelty"
        means here, and JSD measures exactly that. To bound cost, **sample
        `min(population, NOVELTY_SAMPLE)` creatures (≈200) by ascending id and compute
        mean pairwise JSD over their action histograms** — O(NOVELTY_SAMPLE²) ≈ 40k
        ops, a *fixed constant* independent of population (cheaper than an O(n)
        per-creature pass for n > 40k, and correct). Result normalized to `[0,1]` by
        dividing by `log(2)` (JSD's max with natural log). Deterministic subsample
        (ascending id), so reproducible.
      - Uses `Math.log` (fine — `stats.ts` is **never** fed back into `tick()`, so it
        is outside the determinism boundary; add a code comment asserting this so a
        future refactor doesn't route a novelty term into selection and silently
        break cross-engine reachability).
      - `NOVELTY_SAMPLE`, `NOVELTY_WINDOW`, `NOVELTY_ACT_EPS` are named constants
        (constants-ownership rule). Document the metric as provisional (the one
        spec-deferred metric; allowed to change).
  - Pure, index-based iteration, no `Set`/`Object.keys`.
- **Verify:** `tests/sim/stats.test.ts`: on hand-built fixtures, each metric
  returns the expected value —
  - `traitVariance`: a monoculture world → near-zero.
  - `speciesCount`: two groups that are **both spatially separated (beyond
    `SPECIES_SPATIAL_RADIUS`) and genetically separated (`> SPECIES_COMPAT_THRESHOLD`)**
    → speciesCount 2. A single-neighborhood genetic **chain** (each within threshold
    of the next) → speciesCount reports 1 cluster **but with `maxDiameter` ≫
    threshold**, and the test asserts the diameter is surfaced so the sweep reads it
    as a cline, not as one healthy species (the guard against single-linkage chaining
    gaming the diversity reward). Do **not** assert "chain → 1 is correct" as a
    desirable outcome — assert that the diameter flags it.
  - `populationVariance`: a flat population → near-zero.
  - `behaviorNovelty`: a population of **identical** action histograms → 0 (pairwise
    JSD of identical distributions is 0, regardless of each distribution's own
    entropy); a population split into two distinct behavioral modes → clearly higher.
  - Determinism: same world → same metrics (incl. the deterministic ascending-id
    novelty subsample and the ~500-tick recompute schedule).

## Task 1.2: History accumulation + downsampling shape

- **What:** The rolling history structure the metrics read (`meanPopulation`,
  `populationVariance` need a window; extinction events need a log).
- **Why:** `worldHealth` needs time-series input; SPEC.md §Lineage requires the
  downsampled-history shape to exist in the `version:1` schema (already stubbed in
  Phase 0.9) so this fills it in without a migration.
- **How:**
  - In `sim/stats.ts` (or a small `sim/history.ts`), accumulate per-sample
    population, per-gene trait means/variances, species count, and the **`sim/`
    event log with `{ tick, event }` entries** (deterministic; **no `realTime`** —
    Phase 5 attaches wall-clock time worker-side, and Phase 5A.3 defines the typed
    `event` union + firing thresholds). This is the **one** event log; Phase 5 does
    not build a second one, it consumes and time-annotates this one.
  - Full detail for a recent window; **downsample older history** to 1 point /
    1,000 ticks; prune dead lineage branches to ancestors-of-living + summaries
    (SPEC.md §Lineage). Shape must match the Phase 0.9 serialized schema.
  - **Serialize the per-creature `behaviorNovelty` action-window accumulator**
    (Task 1.1) so the metric is continuous across save/catch-up boundaries. Add it
    to the Phase 0.9 schema (optional/defaulted, so no migration).
- **Verify:** `tests/sim/history.test.ts`: after N ticks the recent window is full
  detail and older entries are downsampled at the specified rate; serialize→
  deserialize preserves history shape (extends the Phase 0.9 roundtrip test).

## Task 1.3: Headless CSV runner

- **What:** `scripts/headless.ts` upgraded from Phase 0.10 to dump a CSV of
  world-health over time.
- **Why:** The sweep and manual inspection both read CSV; SPEC.md Phase 1 row:
  "run N ticks in Node, dump CSV."
- **How:**
  - Extend the Phase 0.10 runner: args `--seed`, `--ticks`, `--config <path>`,
    `--csv <path>`, `--sample-every` (default 100 per SPEC.md §Offline Catch-up
    stripped-down cadence).
  - Every `sample-every` ticks, append a CSV row of the `WorldHealth` fields +
    tick + population counts. Stripped down: no rendering.
  - Import only from `src/sim/`.
- **Verify:** `pnpm exec tsx scripts/headless.ts --seed 42 --ticks 10000
  --csv /tmp/run.csv` produces a well-formed CSV with the expected columns and one
  row per sample interval; a second identical invocation produces a
  byte-identical CSV (determinism through the instrument).

## Task 1.4: Benchmarks → choose time knobs, A/B the brain cache, bench the metrics path

> **Empirically gated — produces measured numbers, not designed ones.**

- **What:** `vitest bench` over (a) the tick loop, (b) the metrics path, and (c)
  the derived-weights cache A/B; then derive the two time knobs.
- **Why:** SPEC.md §Tick Semantics & §Offline Catch-up: `MS_PER_TICK` and
  `MAX_OFFLINE_TICKS` are chosen *after* the bench. But the tick bench alone is
  insufficient: the metrics (speciesCount, behaviorNovelty) run every ~500 ticks and
  can dominate sweep wall-clock, and the derived-weights cache (Phase 0.6) is an
  unmeasured bet whose payoff depends on `DRIFT_RATE` (only chosen now).
- **How:**
  - `tests/sim/tick.bench.ts` benchmarking `tick(world)` at a representative
    founder population + plant density — **use a realistic population, not a toy
    one** (the per-creature 5+ spatial-hash queries and, later, the 350-arrow
    forward pass are the real hot path).
  - **Bench the metrics path separately** (`worldHealth` recompute at population
    scale) — this is what actually gates sweep throughput, and it will not show up
    in the per-tick bench because metrics don't run every tick.
  - **A/B the derived-weights cache** (Phase 0.6): measure inline-derive vs.
    dirty-flag cache and report the cache **hit-rate**. **Do this at the `DRIFT_RATE`
    the sweep actually selects for the shipped default config, not a pre-sweep
    provisional value** — the cache decision flips with drift (low drift → most
    creatures stay clean → cache wins; high drift → cache thrashes → delete it), and
    `DRIFT_RATE` is a swept axis. So sequence it: sweep → default `DRIFT_RATE` fixed →
    *then* A/B. If hit-rate < ~50%, delete the cache (simpler, faster); record the
    crossover `DRIFT_RATE` so a later re-sweep that drops drift reopens the question.
  - Then set in `constants.ts`: `MS_PER_TICK` (watchable rate) and
    `MAX_OFFLINE_TICKS` (worst-case catch-up **< ~20s** at the measured rate).
    **Set `MAX_OFFLINE_TICKS` PROVISIONALLY** and comment that it must be
    **re-derived after Phase 4** (the 350-arrow `PatchbayBrain.think` is far heavier
    than the rule policy, so the Phase-1 rate over-estimates post-brain throughput
    and would blow the 20s guarantee). Both knobs are serialized, so re-deriving is
    safe.
- **Verify:** `pnpm bench` prints ticks/sec **and** metrics-recompute time **and**
  cache hit-rate; `constants.ts` has concrete `MS_PER_TICK`/`MAX_OFFLINE_TICKS` with
  a comment citing the measured rate and the "re-derive after Phase 4" note; a
  documented-inequality check records `MAX_OFFLINE_TICKS × (measured ms/tick) < 20s`.

## Task 1.5: Parameter sweep

- **What:** `scripts/sweep.ts` — sample K configs, run each headless, rank by
  world-health.
- **Why:** SPEC.md §World-Health Metrics "balance as search, not taste": the
  habitable band is found by search, not tuning by hand. This is how the Phase 1
  gate is actually met.
- **How:**
  - `scripts/sweep.ts`: random-sample a few hundred `Config`s over the *(tunable)*
    ranges (mutation rates, metabolism, regrowth, day length, `solarReservoir`
    size, etc. — the constants marked *(tunable)* in `constants.ts`).
  - Run each headless for 100k ticks (SPEC.md method), collect final `WorldHealth`,
    write a ranked CSV.
  - Ranking function (a scalarization — its *weights* are tunable by design, but its
    *shape* is pinned so two implementers build the same curve): a weighted sum that
    **rewards** `populationVariance`, `traitVariance`, `speciesCount`,
    `behaviorNovelty`; **penalizes stagnation** (high survival + near-zero variance
    ranks *low*); treats `extinctionEvents` as a **tent/band** — reward rises from 0
    to a target `EXTINCT_SWEET` then falls (some drama good, total collapse bad,
    SPEC.md), not monotonic; and **discounts a chained mega-cluster** by reading the
    per-cluster `maxDiameter` from Task 1.1 (a single cluster with diameter ≫
    threshold counts as low diversity, not high — so single-linkage chaining cannot
    game the diversity reward). Parallelize across workers/processes (Node worker
    threads or child processes; `sim/` is pure so this is safe).
  - Deterministic: each sampled config seeded from a master seed so the sweep is
    reproducible.
- **Verify:** `pnpm exec tsx scripts/sweep.ts --n 200 --ticks 100000
  --out /tmp/sweep.csv` produces a ranked CSV; re-running with the same master
  seed produces an identical ranking (reproducible search); a known-stagnant
  hand-config ranks near the bottom (sanity check that the ranking punishes
  boredom).

## Task 1.6: Throwaway debug canvas

- **What:** A ~50-line raw-canvas viewer (no React, no worker) to *watch* a run.
- **Why:** SPEC.md Phase 1 row: "A CSV will not tell you why your world died;
  *watching it die* tells you in ten seconds." This is the debugging tool for the
  balance work, explicitly throwaway.
- **How:**
  - `scripts/debug-canvas.html` + a tiny inline/`scripts/debug-canvas.ts`: import
    `createWorld`/`tick` from `src/sim/`, run ticks in a `requestAnimationFrame`
    loop on the main thread, draw creatures as dots (position, hue) and plants as
    faint marks. No camera, no polish, no abstraction — deliberately disposable
    (it is replaced by the real renderer in Phase 2).
  - Keep it under ~50 lines; do not build render abstractions here.
- **Verify:** Open the page (via `vite`/a static server), see creatures moving and
  populations changing; confirm visually that a swept "good" config oscillates and
  a "bad" config collapses. This is a human-in-the-loop check, not an automated
  test.

---

## Phase 1 exit criteria (the gate for Phase 2)

- [ ] `worldHealth` metrics implemented and unit-tested.
- [ ] Headless CSV runner produces deterministic, well-formed CSV.
- [ ] `vitest bench` run recorded; `MS_PER_TICK` and `MAX_OFFLINE_TICKS` set from
      the measured rate (worst-case catch-up < ~20s).
- [ ] Sweep runs reproducibly and ranks stagnant worlds low.
- [ ] Debug canvas renders a live run.
- [ ] **THE GATE:** at least one config found (via the sweep + watching) that
      **oscillates and diversifies for 100k ticks**. SPEC.md: do not proceed to
      Phase 2 until this holds. If nothing in the sweep qualifies, the balance is
      wrong — iterate on `sim/` constants/costs (this may mean revisiting Phase 0
      values), not on this plan.

**Next:** `docs/plans/phase-2-plan.md` (Web Worker, real canvas renderer,
genome-derived appearance, day/night tint, trails, camera). The winning config
from this phase's gate becomes the default world Phase 2 renders.
