# Future Work — deferred features & re-evaluation protocols

The beta definition-of-done is met (Phases 0–5C shipped). This document is the single
home for the work that was **intentionally deferred**, plus the empirical protocols a
future session needs to re-open decisions that were made "for now." It consolidates
material that previously lived scattered across SPEC.md, the phase plans, and
`findings/`, so a future session has one place to pick up.

Nothing here is a bug or a regression — it is planned, out-of-beta-scope work. See
`docs/SPEC.md` §Non-Goals and §Build Order for the authoritative deferral decisions.

---

## 1. Post-beta modes (5D) — Terrarium & Laboratory

Deferred per SPEC §Non-Goals and §Build Order (all 5D exit-criteria checkboxes are
unchecked by design). Full task specs already exist in
`docs/plans/phase-5-plan.md` §"Task 5D.1 / 5D.2" — this section is just the pickup
pointer and the design-home note.

- **Laboratory (forking).** Snapshot at any tick → branch → change one parameter → run
  both → side-by-side world-health compare. The save format was kept fork-ready from
  Phase 0.9, so **no save-format change is required**. Implementation sketch: serialize
  the current world → spawn a second worker from the same snapshot → change one param on
  one branch → reuse the Phase-1 WorldHealth metrics + Phase-3 charts for the compare.
- **Terrarium (stewardship + leaderboard).** A refilling influence budget (seed plant
  cheap, spawn predator expensive, meteor very expensive), scoring worlds by
  *interestingness* (reward oscillation/diversity, punish stagnation) via WorldHealth.
  The leaderboard is the **only** place a serverless function may appear — SPEC
  §Non-Goals states "No backend, no auth, no server-side persistence," so defer any
  backend until this mode is actually built.

**Where the design doc goes.** Per the root planning workflow, an in-flight feature's
session-boundary artifact is `docs/designs/<feature>.md`. That directory exists (with a
`.gitkeep`) but is currently empty — implemented designs were retired into SPEC.md by
sync-docs. A future 5D session should create `docs/designs/laboratory.md` /
`docs/designs/terrarium.md` there (brainstorm → design doc → plan → execute).

---

## 2. NEAT re-evaluation protocol

The Phase-4 verdict was **KEEP THE PATCHBAY** (`docs/findings/phase-4-brain-capacity.md`):
the robust instrument (enable density) said capacity is not the binding constraint, and
heritability passed so behavior can accumulate. NEAT remains out of scope. This section
consolidates the exact conditions and instruments to re-open that decision, which
previously lived in three places (the findings doc, SPEC §"Why not NEAT", SPEC §Open
Questions).

**Re-open the NEAT question if EITHER instrument flips:**

1. **Enable density.** `mean(enabled)` over a long patchbay run climbs toward **0.9+ and
   pins** → evolution wants every arrow → the fixed-skeleton ceiling may bind.
   (The Phase-4 measurement was ~0.27 — far from the ceiling.)
2. **Enlargement experiment.** HIDDEN=10 vs HIDDEN=20 fresh worlds: if the larger brain
   *reliably* improves the world-health proxy, the ceiling binds.

**Trust threshold for the enlargement instrument** (it is noisy at short horizons — do
NOT read a NEAT decision off it below this):

- **≥ 50,000 ticks** per run, and
- **≥ 5 seeds** (report the distribution, not one run).

**Instruments to run:** `scripts/experiment-brain-capacity.ts` (both instruments +
combined verdict; now guards against a double-extinction masking a false "KEEP PATCHBAY")
and `scripts/compare.ts` (A/B rule-vs-patchbay + the heritability gate; now reports N/A
rather than a misleading PASS on an extinct world). Record any re-run verdict in a new
`docs/findings/` entry, not here.

---

## 3. Offline catch-up budget — measured baseline

`MAX_OFFLINE_TICKS` (`src/sim/constants.ts`) is the cap on replayed offline ticks, chosen
so catch-up completes within a ~20 s budget. It is a serialized tunable, so re-deriving
is always safe. Baseline recorded here so a future change to per-tick cost has a number
to compare against:

- **Grid:** 64×64 (the rate is grid-resolution-specific — grid resolution is a
  catch-up-speed knob per SPEC §Space & Fields).
- **Worst realistic tick:** high-population world near `CREATURE_CAP`, dominated by
  per-creature spatial-hash sensing (both brains pay it; it scales with **population**,
  not enable density).
- **Measured rate:** ≤ ~5.5 ms/tick (Phase 4 Task 4.3b); **~5.26 ms/tick with seasons
  ON** (Phase 5C.1 — the O(cells) temperature-field write is negligible against
  per-creature sensing, so seasonal work did not move the worst case).
- **Documented inequality (kept conservative):**
  `MAX_OFFLINE_TICKS × ms/tick = 3600 × 5.5 ms ≈ 19.8 s < 20 s`.

**Re-derive if** you change grid resolution, add per-tick work that scales with
population, or target slower hardware. Re-measure with `pnpm bench` and update the
constant + the derivation comment in `constants.ts`.

---

## 4. Known non-blocking gaps (on record, not scheduled)

Minor items surfaced during QA that are safe today and out of scope for beta — recorded
so they aren't rediscovered as "new":

- **`deGenome` does not clamp trait alleles on load** (`src/sim/serialize.ts`). A
  hand-crafted/corrupt save with an out-of-range allele (e.g. `offspringInvestment < 1`)
  would bypass the mutation-time clamp. Safe in practice: imports are validated on the
  main thread before reaching the worker, and every mutation/founder-seed path clamps. If
  ever hardening against adversarial saves, clamp allele ranges in `deGenome`/
  `dePlantGenome` on load.
- **True cross-engine determinism** would additionally require pinning the movement
  kinematics (`Math.sin/cos/atan2/hypot`) and the Box–Muller `gaussian`, which currently
  use raw transcendentals on state-affecting paths. The determinism guarantee today is
  **same-engine** bit-identity (which these satisfy); the brain path is pinned because it
  is the one reachable cross-engine surface. Only relevant if the project ever needs
  bit-identical runs across different JS engines.
