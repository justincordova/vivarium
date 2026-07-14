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
    - `speciesCount` = number of clusters, recomputed ~every 500 ticks, via a
      **fixed clustering algorithm: single-linkage connected components** — build a
      graph over living creatures with an edge between any pair whose
      `distance(a,b) < SPECIES_COMPAT_THRESHOLD` (the **same** constant that gates
      mate compatibility, Phase 0.1.1), then count connected components (union-find,
      index-based over the stable ID array). Single-linkage is chosen because it
      matches the biology: species = who *can* interbreed, and interbreeding is
      transitive-by-chaining under the compatibility threshold. This is fixed here so
      two implementers cannot get different counts.
    - `populationVariance` — a *reward* signal (high = good oscillation); document
      it so the sweep's ranking function does not penalize it (SPEC.md: stagnant
      worlds must score *bad*).
    - `behaviorNovelty` — **SPEC.md §Open Questions explicitly defers the precise
      formula.** Implement the named v1 proxy and mark it as provisional in code:
      per creature, accumulate a normalized histogram over the 7 actions (fraction of
      ticks in a trailing window each action fired); the metric is the **mean
      pairwise Jensen–Shannon divergence** across the population's action histograms
      (a single scalar in `[0,1]`, higher = more behavioral diversity). Pick
      Jensen–Shannon (not "variance or entropy") so the choice is unambiguous;
      document that this proxy may be revisited (it is the one metric the spec leaves
      open, so it is allowed to change without invalidating anything).
  - Pure, index-based iteration, no `Set`/`Object.keys`.
- **Verify:** `tests/sim/stats.test.ts`: on hand-built fixtures, each metric
  returns the expected value — a monoculture world → near-zero traitVariance; two
  groups separated by `> SPECIES_COMPAT_THRESHOLD` with intra-group distances below
  it → speciesCount exactly 2 (and a chain of creatures each within threshold of the
  next → speciesCount 1, proving single-linkage); a flat population → near-zero
  populationVariance; identical action histograms → behaviorNovelty 0. Determinism:
  same world → same metrics.

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

## Task 1.4: Tick-loop benchmark → choose `MS_PER_TICK` and `MAX_OFFLINE_TICKS`

> **Empirically gated — produces measured numbers, not designed ones.**

- **What:** A `vitest bench` over the tick loop at a representative population,
  then derive the two time knobs from the measured rate.
- **Why:** SPEC.md §Tick Semantics & §Offline Catch-up: both `MS_PER_TICK` and
  `MAX_OFFLINE_TICKS` are "chosen *after* `vitest bench` reports the real headless
  tick rate." Guessing produces "a 14-minute loading bar or a world that barely
  advances."
- **How:**
  - `tests/sim/tick.bench.ts` benchmarking `tick(world)` at a representative
    founder population + plant density (from a representative `Config`).
  - Record ticks/sec. Then set, in `constants.ts`:
    - `MS_PER_TICK` — chosen so world-time flows at a watchable rate.
    - `MAX_OFFLINE_TICKS` — chosen so worst-case offline catch-up is **under ~20s**
      at the measured rate (SPEC.md §Offline Catch-up).
  - Replace the Phase 0.1 placeholder comments on these two constants with the
    measured values and a note recording the bench result they came from.
- **Verify:** `pnpm bench` runs and prints ticks/sec; `constants.ts` now has
  concrete `MS_PER_TICK`/`MAX_OFFLINE_TICKS` with a comment citing the measured
  rate; a comment-check test asserts `MAX_OFFLINE_TICKS × (measured ms/tick) < 20s`
  (documented inequality, even if the rate is hard-coded from the bench run).

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
  - Ranking function: rewards `populationVariance`, `traitVariance`,
    `speciesCount`, moderate `extinctionEvents`; penalizes stagnation (high
    survival + near-zero variance must rank *low*). Parallelize across workers/
    processes (Node worker threads or child processes; `sim/` is pure so this is
    safe).
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
