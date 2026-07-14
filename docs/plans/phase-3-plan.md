# Phase 3 — The Sandbox Plan

> **Goal:** Turn the window into the Aquarium sandbox — inspector, parameter
> sliders (incl. the DoD mutation-rate slider), spawn/delete/paint god-powers,
> follow-cam, and pause/step/speed. Then **ship it**.
> **Spec:** `docs/SPEC.md` — see **Player Experience** (Aquarium), **Build Order**
> (Phase 3 row: "Ship it"), **Visual Design**, **Mutation** (the mutation-rate
> slider = `MUT_GLOBAL`), **Architecture** (inspector via `inspect`).
> **Depends on:** Phase 2 complete — worker, renderer, camera, play/pause/speed.

## Scope & guardrails

- **`frontend-design` skill APPLIES.** Load it before writing any panel,
  inspector, slider, or control UI in this phase.
- **Never hide information** (SPEC.md §Player Experience): full stats always
  visible; information is the reward. The sandbox exposes, it does not gate.
- All god-powers are **commands to the worker** (the worker owns the World); the
  UI never mutates World state directly (SPEC.md §Architecture). New commands are
  added to `protocol.ts`.
- Phase 3 is the **first shipped product** (SPEC.md Phase 3 row: "Ship it") — but
  persistence/catch-up and the cold-open snapshot are Phase 5. This phase ships the
  *interactive sandbox*; the retention hedges land in Phase 5.

---

## Task 3.1: Extend the worker protocol with god-power + step commands

- **What:** New `Command` types for inspect-driven UI, stepping, spawn/delete,
  genome edits, terrain paint, and param changes.
- **Why:** Every Phase 3 interaction is a worker command; built first so the UI
  wires against a stable contract.
- **How:** Extend `worker/protocol.ts`:
  - `{ t: 'step'; ticks: number }` (single/N-step while paused).
  - `{ t: 'spawn'; genome; pos }`, `{ t: 'delete'; id }`.
  - `{ t: 'editGenome'; id; patch }` (live genome edit).
  - `{ t: 'paint'; field; cell; value }` (terrain/field paint, e.g. drought =
    lower water/fertility).
  - `{ t: 'setParam'; key; value }` (drag a slider → change a *(tunable)* constant
    live; includes `MUT_GLOBAL` for the DoD mutation-rate slider).
  - Worker applies each inside the tick boundary (never mid-resolve) so
    determinism/conservation are preserved; a spawn/paint injects energy from the
    correct compartment (never mints — routes through `solarReservoir`/fields per
    the Energy ledger).
- **Verify:** `pnpm build` typechecks; a harness sends each command and observes
  the expected World change in the next `frame`/`stats`; conservation assertion
  still holds the tick after a spawn/paint (no minting).

## Task 3.2: Inspector (`ui/Inspector.tsx`)

- **What:** Click a creature → panel showing its genome, brain, energy/health/age,
  offspring, lineage id.
- **Why:** DoD: "click a creature and reads its genome." SPEC.md §Architecture:
  inspect returns one creature's full data.
- **How:**
  - **Load `frontend-design` skill first.**
  - Click on canvas → dispatch `inspect{id}` → worker replies `creature{data}` →
    render genome (both alleles per gene, expressed value), brain summary
    (enable density, notable arrows), vitals. Monospace numbers (SPEC.md §Visual
    Design).
  - Live genome edit fields dispatch `editGenome`.
- **Verify:** Clicking a creature opens its genome; values match the worker's full
  creature; editing a gene visibly changes the creature next tick; monospace
  numeric styling.

## Task 3.3: Control panel + parameter sliders (`ui/ControlPanel.tsx`)

- **What:** Pause/step/speed, seed, and sliders for the *(tunable)* params —
  centrally the mutation-rate slider.
- **Why:** DoD: "adjusts the mutation rate." SPEC.md §Mutation: the slider scales
  the single global multiplier `MUT_GLOBAL` across every per-locus rate.
- **How:**
  - **Load `frontend-design` skill first.**
  - Play/pause/step(N)/speed controls (step dispatches `step`); seed field
    (re-init world).
  - Mutation-rate slider → `setParam{key:'MUT_GLOBAL', value}` (SPEC.md §Mutation:
    one knob, uniform pressure). Additional sliders for other *(tunable)* constants
    (metabolism, regrowth, day length, etc.).
  - Grayscale chrome; the slider affects the world, the only saturated thing.
- **Verify:** Dragging mutation-rate visibly changes trait drift over time; step
  advances exactly N ticks while paused; speed changes `ticksPerFrame`; seed
  re-inits.

## Task 3.4: Spawn / delete / paint god-powers

- **What:** Canvas tools to spawn creatures, delete them, and paint terrain/fields
  (e.g. trigger a drought).
- **Why:** SPEC.md §Player Experience: "Full god powers: paint terrain, spawn
  creatures, edit genomes live, drag sliders, trigger a drought."
- **How:**
  - **Load `frontend-design` skill first.**
  - Tool palette (grayscale): spawn (place a genome), delete (click a creature),
    paint (brush a field cell — water down = drought). Each dispatches the
    matching Task 3.1 command.
  - Painting respects the ledger (paint moves quanta between field and reservoir;
    it does not mint).
- **Verify:** Spawn adds a creature at the click; delete removes one; painting
  water down causes a visible drought response (creatures seek water / die);
  conservation still holds.

## Task 3.5: Follow-cam (`render/camera.ts` + UI)

- **What:** Click to lock the camera to one creature; announce its death, age, and
  offspring count.
- **Why:** SPEC.md §Player Experience: a mandatory retention hedge — "it stops
  being a population and becomes an animal."
- **How:**
  - **Load `frontend-design` skill first.**
  - Extend `camera.ts` with a follow target (id); the rAF loop centers on that
    creature's latest snapshot position. On its removal, surface a small
    grayscale caption: age, offspring count (from lineage stats), cause of death
    (from the event log).
  - No easing on the camera itself beyond what legibility needs (SPEC.md: only the
    sim moves) — a hard lock is fine.
- **Verify:** Clicking a creature locks the camera to it; it stays centered as the
  creature moves; on death a caption reports age + offspring; unfollowing returns
  to free camera.

## Task 3.6: Charts always-visible (`ui/Charts.tsx`)

- **What:** Population + trait-distribution charts, first-class and always visible.
- **Why:** SPEC.md §Visual Design: "Charts first-class and always visible";
  §Player Experience: information is the reward. Also the DoD's oscillation is read
  off the population chart.
- **How:**
  - **Load `frontend-design` skill first.**
  - Recharts (SPEC.md §Tooling) fed by the worker's `stats` events: population over
    time (shows predator–prey oscillation), trait distributions. Grayscale chrome,
    monospace axes.
  - (Timeline scrubber with extinction tick-marks is noted in Visual Design but
    depends on the event log / history depth — implement the always-visible charts
    here; defer the scrubber to Phase 5 where catch-up/history matures.)
- **Verify:** Population chart visibly oscillates on the balanced config; trait
  charts update live; charts never hidden behind a tab.

---

## Phase 3 exit criteria — SHIP IT

- [ ] Inspector shows genome/brain/vitals on click (DoD clause).
- [ ] Mutation-rate slider scales `MUT_GLOBAL` and visibly changes evolution (DoD
      clause).
- [ ] Spawn/delete/paint god-powers work and respect the energy ledger.
- [ ] Follow-cam locks to a creature and announces its death/age/offspring.
- [ ] Population + trait charts always visible; oscillation legible.
- [ ] `frontend-design` skill was loaded before each UI task.
- [ ] **Deployable:** static build works on Vercel/Netlify/Cloudflare Pages
      (SPEC.md §Tooling). This is the "Ship it" milestone.

**Next:** `docs/plans/phase-4-plan.md` — swap rule-based agents for patchbay neural
brains and compare against the same seed (the headline result). Everything up to
here ran on `RuleBasedBrain`; Phase 4 makes the brains real.
