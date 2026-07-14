# Phase 2 — The Window Plan

> **Goal:** Make the (now-balanced) sim visible: run it in a Web Worker off the
> main thread, render lean snapshots to a real canvas with genome-derived
> appearance, day/night tint, trails, and a pan/zoom camera.
> **Spec:** `docs/SPEC.md` — see **Architecture** (worker/render/ui layering, data
> flow, worker protocol), **Visual Design**, **Build Order** (Phase 2 row).
> **Depends on:** Phase 1 complete — a config that oscillates/diversifies for 100k
> ticks exists and is the default world to render.

## Scope & guardrails

- **Layering is load-bearing** (SPEC.md §Architecture): `sim/` pure, `worker/`
  owns the authoritative World, `render/` is a pure function of a snapshot, `ui/`
  is React chrome that **never calls `tick()`**. Swapping any outer layer never
  touches inner ones.
- **`worker/` never posts the whole World** — only lean typed-array frame
  snapshots + periodic stats. Full creature data crosses only on `inspect`
  (SPEC.md §Architecture, §Data Flow).
- **`frontend-design` skill APPLIES from this phase on.** Before writing any
  `ui/` React or `render/` visual code in this and later phases, **load the
  `frontend-design` skill.** The Visual Design section is strict: grayscale chrome,
  the world is the only saturated thing, monospace numbers, no easing/particles —
  the skill must be applied within those constraints, not against them.
- Phase 2 ships the **window**, not yet the sandbox controls (those are Phase 3).

---

## Phase 2A: The worker boundary

**Gate:** the worker owns the World and runs ticks; main thread receives frames
and never blocks; the app renders a live world.

### Task 2A.1: `worker/protocol.ts`

- **What:** The `Command`/`Event` message types, imported by both worker and main.
- **Why:** Both sides must share one contract; built first so worker and UI code
  compile against it.
- **How:** Implement the sketch in SPEC.md §Architecture verbatim as the starting
  point: `Command` = init/play/pause/speed/inspect/snapshot; `Event` =
  frame/stats/creature/snapshot/catchupProgress. Include the `init` command (the
  Data Flow prose omits it; the sketch includes it — the sketch is canonical).
- **The `frame` snapshot must carry every field `render/palette.ts` (Task 2B.1)
  consumes** — not just position. Per the SPEC.md appearance table, the palette
  reads: position, `hue`, `size`, current energy (saturation), `diet` (shape),
  `armor` + `toxicity` (spikes/ornaments), and `age` (outline ring). Enumerate the
  frame as parallel lean typed arrays: `positions`, `headings`, `hues`, `sizes`,
  `energies`, `diets`, `armors`, `toxicities`, `ages` (+ a plants array and a
  corpses array). These are all *expressed* scalars (means of the diploid alleles),
  computed worker-side; never post full `Creature` objects. This resolves the
  cross-task gap: the frame as enumerated here fully feeds the palette in 2B.1.
- **Define `TraitBins` and the `stats` message shape.** SPEC.md's sketch types
  `stats` as `{ population: number[]; traits: TraitBins }` but never defines either.
  Decide: `population: number[]` is population count **per species cluster** (index
  = cluster id from Phase 1 speciesCount), and `TraitBins` is `Record<geneName,
  number[]>` — a histogram (fixed bucket count, a named constant) of each functional
  trait gene's expressed value across the population. Both are computed in
  `stats.ts`; the worker forwards them.
- **Verify:** `pnpm build` typechecks both `worker/` and a stub main importing
  `protocol.ts`; a type-level check confirms the `frame` payload includes every
  field `render/palette.ts`'s input type requires (palette input type and frame
  type share one source-of-truth interface).

### Task 2A.2: `worker/sim.worker.ts`

- **What:** The worker that owns the authoritative `World`, runs the tick loop,
  and posts lean snapshots + periodic stats.
- **Why:** SPEC.md §Architecture: the sim runs off the main thread so the UI never
  stutters. This is the whole point of the `sim/` purity rule.
- **How:**
  - On `init{seed, config}`: `createWorld` (Phase 0.7), start a tick loop paced by
    `ticksPerFrame`/`MS_PER_TICK`.
  - Each frame: build the lean typed-array snapshot with **exactly the fields
    enumerated in Task 2A.1** (positions/headings/hues/sizes/energies/diets/armors/
    toxicities/ages + plants + corpses, all expressed scalars) and `postMessage` a
    `frame` Event; every N ticks post a `stats` Event (world-health + `population`/
    `TraitBins` from Phase 1 `stats.ts`).
  - `play`/`pause`/`speed` control the loop; `inspect{id}` replies with one full
    `Creature`; `snapshot` replies with a serialized world (Phase 0.9).
  - Imports only from `src/sim/` (+ `protocol.ts`). Never imports `render`/`ui`.
- **Verify:** With a temporary main-thread harness, `init` then observe a stream of
  `frame` messages with correct tick progression; `pause` stops them; `inspect`
  returns a full creature; the main thread stays responsive (no long tasks).

## Phase 2B: The renderer

**Depends on:** Phase 2A.
**Gate:** a snapshot renders as a legible, saturated world on grayscale chrome
with day/night tint and trails.

### Task 2B.1: `render/palette.ts` — genome → appearance

- **What:** The pure genome→appearance mapping.
- **Why:** SPEC.md §Visual Design: "appearance is derived, never designed." Built
  before the draw call so `canvas.ts` just consumes it.
- **How:** Map exactly per the SPEC.md appearance table: size←`size`; hue←`hue`;
  saturation←current energy (starving = washed out); shape round↔angular←`diet`
  interpolated; spikes/ornaments←`armor`/`toxicity`; faint outline ring←age. Pure
  function of the (lean) snapshot fields; no state.
- **Verify:** `render/palette.test.ts` (node env — pure fn): known genome →
  expected color/shape params; starving creature → desaturated; two hues → two
  distinguishable colors.

### Task 2B.2: `render/camera.ts` + `render/canvas.ts`

- **What:** `camera.ts` (pan, zoom, screen↔world) and `canvas.ts`
  (`draw(snapshot, ctx, camera)`), a pure function of a snapshot.
- **Why:** SPEC.md §Architecture: `render/` is a pure function of a snapshot;
  swapping canvas→PixiJS later touches only this folder.
- **How:**
  - **Load the `frontend-design` skill first.**
  - `camera.ts`: pan/zoom state + screen↔world transforms.
  - `canvas.ts`: `draw(snapshot, ctx, camera)` — draw creatures via `palette`,
    plants as faint marks, corpses distinctly. **Trails:** do not clear each frame;
    fill a low-alpha black rect for motion blur (SPEC.md §Visual Design). Day/night:
    a single color multiply / translucent overlay from the snapshot's light level.
    Fields as a low-opacity offscreen underlay redrawn every N ticks. No easing, no
    particles — "the only thing that moves is the simulation."
- **Verify:** `render/canvas.test.ts` where feasible (pure transforms in camera);
  visual verification in the app (Task 2C.2): a live world renders legibly at
  density, trails read as motion, day/night tint cycles.

## Phase 2C: Minimal app shell

**Depends on:** 2A, 2B.
**Gate:** `pnpm dev` opens a page showing the live simulated world with a working
rAF render loop and pan/zoom.

### Task 2C.1: Store + worker wiring (`store/useSimStore.ts`, `main.tsx`)

- **What:** A Zustand store holding UI/sim-config state and the worker handle; app
  bootstrap.
- **Why:** SPEC.md §Architecture: `ui/` reads a Zustand store and sends commands;
  never calls `tick()`.
- **How:** Zustand store for play/pause/speed/seed/camera + latest snapshot ref.
  `main.tsx` spins up the worker, sends `init` with the Phase 1 winning config,
  wires `frame`/`stats` events into the store.
- **Verify:** Store updates on each `frame`; sending `pause` via the store stops
  updates. No `tick()` call anywhere in `ui/`/`store/` (grep + Biome boundary).

### Task 2C.2: `ui/App.tsx` + `ui/SimCanvas.tsx`

- **What:** The React shell and the canvas component (canvas ref + rAF loop
  calling `render/canvas.draw`).
- **Why:** The window the DoD's "stranger opens a URL, sees a living world" needs.
- **How:**
  - **Load the `frontend-design` skill first.**
  - `SimCanvas.tsx`: holds the canvas ref, runs a `requestAnimationFrame` loop that
    draws the latest snapshot via `render/`. Never runs sim logic.
  - `App.tsx`: grayscale dark chrome, monospace numbers, the canvas as the only
    saturated element (SPEC.md §Visual Design). Minimal for now: just the world +
    a play/pause + speed control (full controls are Phase 3).
  - Tailwind per SPEC.md §Tooling.
- **Verify:** `pnpm dev` → a living world renders; pan/zoom works; play/pause/speed
  work; UI stays smooth while the sim runs (worker offloads it). This satisfies the
  first clause of the DoD ("sees a living world with visible predator–prey
  oscillation").

---

## Phase 2 exit criteria (the gate for Phase 3)

- [ ] Worker owns the World; main thread renders lean snapshots without stutter.
- [ ] Worker protocol implemented; full creature crosses only on `inspect`.
- [ ] Genome-derived appearance, day/night tint, trails all render per Visual
      Design; chrome is grayscale, world is the only saturated thing.
- [ ] Pan/zoom camera; play/pause/speed.
- [ ] `frontend-design` skill was loaded before writing `render`/`ui` code.

**Next:** `docs/plans/phase-3-plan.md` — the sandbox: inspector, param sliders,
spawn/delete/paint, follow-cam, pause/step/speed. Phase 3 ends with "**Ship it.**"
