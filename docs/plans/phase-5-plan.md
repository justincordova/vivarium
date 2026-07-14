# Phase 5+ — Persistence, Depth & Modes Plan

> **Goal:** Complete the beta: persistence + offline catch-up + the "while you were
> away" report (the last DoD clause), observability charts, the pre-evolved cold
> open, then environmental depth (fields/seasons/terrain), speciation/lineage
> views, and finally the post-beta Terrarium/Laboratory modes.
> **Spec:** `docs/SPEC.md` — see **Persistence & Save Format**, **Offline
> Catch-up**, **Lineage & Long-Run Memory**, **Player Experience**, **Space &
> Fields** (seasons/day-night/temperature), **Build Order** (Phase 5+ row).
> **Depends on:** Phase 4 — real brains and a shippable sandbox exist.

## Scope & guardrails

- **Phase 5+ is a *sequenced grab-bag*, not one design** (SPEC.md Phase 5+ row).
  It is split into ordered sub-phases (5A→5D) with real gates. Each sub-phase is a
  candidate for its own detailed just-in-time plan when reached; this document
  fixes the sequence, the spec-decided shape of each, and the gates.
- **`frontend-design` skill APPLIES** to every UI surface below (reports, charts,
  scrubber, lineage tree, mode UIs). Load it before writing those.
- **The save format is already forward-compatible** from Phase 0.9 (`version:1`,
  optional/defaulted fields, migration scaffold, downsampled-history shape, RNG
  live state). Phase 5 *uses* that; it must not require a save-invalidating
  rewrite (SPEC.md §Persistence, §Determinism cross-engine door).
- **Terrarium & Laboratory are post-beta** (SPEC.md §Player Experience) but the
  save format "must not preclude forking" — already satisfied by the self-
  describing snapshot. They come last.

---

## Phase 5A: Persistence + offline catch-up + "while you were away"

**Gate:** close the tab, reopen, and the world is there and has advanced; a report
leads with drama. This completes the DoD.

### Task 5A.1: IndexedDB autosave with rotating slots

- **What:** Autosave the serialized world to IndexedDB via `idb-keyval`, rotating
  slot pair with a `meta` pointer.
- **Why:** DoD: "closes the tab, and finds their world waiting tomorrow." SPEC.md
  §Persistence: rotating `world:a`/`world:b` + `meta` so a crash mid-write loses
  one autosave, not the world.
- **How:** In the worker (owns the World), autosave on an interval (~30s sim time)
  **and** on `visibilitychange`; **never** `beforeunload` (SPEC.md §Persistence).
  Serialize via Phase 0.9 `serialize()`. Store `lastSavedRealTime`. Write to the
  older slot, then flip `meta`. UI prefs → localStorage; nothing in cookies.
- **Verify:** Reload the page → world restores from the newest valid slot; simulate
  a mid-write crash (abort between write and meta-flip) → the prior slot still
  loads; `idb` holds the two slots + meta.

### Task 5A.2: Offline catch-up + progress

- **What:** On load, run the ticks owed since `lastSavedRealTime`, capped at
  `MAX_OFFLINE_TICKS`, stripped down, with progress posted.
- **Why:** SPEC.md §Offline Catch-up: nothing runs while closed; catch-up is
  literally calling `tick()` N times; the cap keeps worst case < ~20s.
- **How:** Exactly the spec snippet: `ticksOwed = min(floor((now −
  lastSavedRealTime)/MS_PER_TICK), MAX_OFFLINE_TICKS)`; loop `tick`. Stripped:
  no rendering, stats every 100th tick, lineage as aggregate counts, post
  `catchupProgress` every ~5,000 ticks. A **toggle** disables catch-up (SPEC.md).
- **Verify:** Set `lastSavedRealTime` in the past → on load the world advances the
  expected capped tick count; progress events fire; worst-case catch-up completes
  under ~20s at the Phase 1 measured rate; toggle off → world resumes without
  catch-up.

### Task 5A.3: Event log + "while you were away" report

- **What:** The typed event log and a report UI that leads with drama.
- **Why:** SPEC.md §Offline Catch-up: "the retention mechanic."
- **How:**
  - **Load `frontend-design` skill first.**
  - **`realTime` must NOT live in `sim/`.** The `sim/` event log (built in Phase 0,
    serialized in the `version:1` schema) stores **deterministic entries only:
    `{ tick, event }`** — a wall-clock timestamp inside `sim/` would break the
    determinism + roundtrip properties. The **worker** (outside `sim/`) attaches
    `realTime` when it observes an event, keeping a parallel `{ tick, realTime }`
    map in worker-owned (non-`sim/`) state or reconstructing real-time from `tick` ×
    `MS_PER_TICK` + `lastSavedRealTime`. The report reads `sim/`'s `{tick,event}` +
    the worker's real-time association. This resolves the determinism contradiction:
    `sim/` stays pure and reproducible; `realTime` is presentation, not simulation.
  - **Define the event entry type (a discriminated union) and firing thresholds** —
    these are `sim/` logic (deterministic) even though the report is UI:
    - `{ kind: 'extinction', tick, species }` — fires when a species cluster's
      population drops to 0 (using Phase 1 `speciesCount` clusters).
    - `{ kind: 'lineageBoom', tick, species, factor }` — fires when a cluster's
      population ≥ doubles versus its value `BOOM_WINDOW` ticks ago (a named
      constant).
    - `{ kind: 'newDominant', tick, species }` — fires when a different cluster
      becomes the largest by population fraction and holds it for `DOMINANCE_WINDOW`
      ticks.
    - Enumerate these kinds + thresholds so the log is not free-form prose.
  - After catch-up, render a report from the log: "Generation N. The northern
    herbivores are extinct. A new predator lineage doubled in size." Grayscale,
    monospace numbers.
- **Verify:** `tests/sim/events.test.ts`: a scripted extinction/boom/dominance
  fixture fires exactly the expected entries at the expected ticks (deterministic,
  in `sim/`); the serialized log contains no `realTime` field; the report (worker+UI)
  surfaces drama after a catch-up that includes an event; no catch-up → no report.

### Task 5A.4: URL-hash shareable world + file export

- **What:** Seed+config in the URL hash; export/import worlds & creatures as
  gzipped file downloads.
- **Why:** SPEC.md §Goals ("a shareable link") + §Persistence (URL hash;
  `CompressionStream` gzip export).
- **How:** Encode seed+config in `#seed=..&mut=..`; on load, hydrate from the hash.
  Export a serialized world/creature via `CompressionStream` (gzip) file download;
  import reverses it. All through the Phase 0.9 pure `serialize`/`deserialize`.
- **Verify:** Copy the URL to a fresh tab → same world boots; export a world, import
  it in another session → identical world (roundtrip through the file path).

## Phase 5B: Observability + the cold open

**Depends on:** 5A. **Gate:** first-load shows emergence in ~8 seconds; charts and
a timeline scrubber make the world legible.

### Task 5B.1: Timeline scrubber + richer charts

- **What:** The timeline scrubber with extinction tick-marks; expand the Phase 3
  charts with the now-mature history/event data.
- **Why:** SPEC.md §Visual Design: "Timeline scrubber with tick marks at extinction
  events." Deferred from Phase 3 because it needs the history/event log (5A.3).
- **How:** **Load `frontend-design` skill first.** Scrubber reads the downsampled
  history + event log; tick-marks at extinction events; charts read the same.
- **Verify:** Scrubber shows extinction marks at the right ticks; scrubbing updates
  the view; charts stay always-visible.

### Task 5B.2: Pre-evolved cold open + onboarding captions

- **What:** Ship a generation-2,000 snapshot where predators already hunt; load
  into it with a few corner captions.
- **Why:** SPEC.md §Player Experience: mandatory retention hedge — "the first eight
  seconds show emergence, not potential"; "onboarding is a cold open, not a
  tutorial."
- **How:** **Load `frontend-design` skill first.** Generate a gen-2,000 snapshot
  from a good Phase 4 seed (run headless, serialize, commit as an asset). On first
  visit (no saved world), load it; show a few unobtrusive grayscale captions, then
  get out of the way.
- **Verify:** A brand-new visitor lands in a living, hunting world within seconds;
  captions appear then fade; a returning visitor loads their own saved world
  instead.

## Phase 5C: Environmental depth

**Depends on:** 5B. **Gate:** seasons/day-night/temperature exert visible selection
pressure; speciation is viewable.

### Task 5C.1: Seasons, day/night, temperature pressure

- **What:** Turn on the environmental cycling the sim already models as fields.
- **Why:** SPEC.md §Space & Fields + §World-Health "known stabilizers":
  environmental cycling ("the optimum *moves*") is the anti-stagnation mechanism;
  day/night is selection pressure, not decoration.
- **How:** Fields (light, temperature) already exist and update in the tick loop
  (Phase 0.8). Enable seasonal modulation of day length / temperature over
  `DAYS_PER_SEASON`; confirm circadian/size respond (nocturnal niches, nocturnal
  size cost). Day length is a swept config parameter. These are `sim/` changes
  gated by the same conservation/determinism tests.
- **Verify:** Over a season, temperature/day-length shift; nocturnal or
  cold-adapted lineages appear in a sweep; conservation still exact.

### Task 5C.2: Speciation charts & lineage tree

- **What:** Species-over-time charts and the phylogenetic tree (d3).
- **Why:** SPEC.md §Lineage; §Tooling (d3 only for the phylo tree).
- **How:** **Load `frontend-design` skill first.** Read emergent species (Phase 1
  clustering) over time; render the lineage tree from `parentId` + the pruned/
  downsampled history (5A). d3 for the tree only; Recharts elsewhere.
- **Verify:** Species count chart tracks diversification; the lineage tree renders
  living lineages + notable extinct summaries; hue similarity visually matches tree
  proximity (the neutral-marker phylogeny read directly off the screen).

## Phase 5D: Post-beta modes

**Depends on:** 5C. **Gate:** Terrarium and Laboratory work without a save-format
change.

### Task 5D.1: Laboratory (forking)

- **What:** Snapshot at any tick, branch, change one parameter, run both, compare.
- **Why:** SPEC.md §Player Experience: "the killer feature nobody builds"; the save
  format was kept fork-ready from Phase 0.9.
- **How:** **Load `frontend-design` skill first.** Fork = serialize current world →
  spawn a second worker from the same snapshot → change one param on one branch →
  run both → side-by-side world-health compare (reuse Phase 1 metrics + Phase 3
  charts). No save-format change required.
- **Verify:** Fork at tick T, double mutation on one branch, run both → two
  divergent worlds compared side by side; both reproducible from the shared
  snapshot.

### Task 5D.2: Terrarium (stewardship + leaderboard)

- **What:** A stewardship-budget mode scoring worlds by *interestingness*, with a
  shareable-seed leaderboard.
- **Why:** SPEC.md §Player Experience (opt-in mode); scoring philosophy: "how
  strange can you make it?" not "survive longest."
- **How:** **Load `frontend-design` skill first.** A refilling influence budget
  (seed plant cheap, spawn predator expensive, meteor very expensive); score via
  the WorldHealth metrics (reward oscillation/diversity, punish stagnation). The
  leaderboard is the one place a serverless function may appear (SPEC.md §Non-Goals:
  "not a backend framework; a function") — defer the backend until this mode is
  actually built.
- **Verify:** Budget refills; expensive actions cost more; a stable multi-species
  world scores higher than an immortal monoculture; shareable seeds rank.

---

## Phase 5+ exit criteria

- [ ] Persistence + catch-up + "while you were away" work → **DoD fully met** (the
      stranger's world is waiting tomorrow, advanced, with a report).
- [ ] Shareable URL + file export/import roundtrip.
- [ ] Cold open shows emergence in ~8s for new visitors.
- [ ] Seasons/day-night/temperature exert measured selection pressure.
- [ ] Speciation charts + lineage tree render; hue tracks phylogeny.
- [ ] Laboratory forking and Terrarium mode work with no save-format change.
- [ ] `frontend-design` skill loaded before every UI surface.

**Beyond beta (explicitly deferred, SPEC.md §Non-Goals):** LLM naturalist,
hall-of-fame backend, PixiJS/WebGL, rtNEAT, structure-of-arrays refactor,
cross-engine bit-determinism (only if a shared leaderboard ships). Each is gated on
a measured need, not a hunch.
