# Vivarium — Agent Context

Browser-based, entirely client-side evolutionary ecosystem simulator: a persistent
world of agents with evolved brains that live, compete, reproduce, and speciate.
TypeScript + Vite + React (chrome only) + a Web Worker running a pure, deterministic
simulation. The interesting artifact is emergent behavior, not the code.

**Status:** Phases 0–5C shipped. The **beta definition-of-done is met** (persist +
offline catch-up + "while you were away" report; brains swapped in at Phase 4;
sandbox, renderer, observability, cold open, seasons all live). Post-beta modes
(Terrarium/Laboratory, 5D) are deferred per SPEC §Non-Goals. Global conventions (git
format, planning workflow) come from the root `~/agent/AGENTS.md` and are not repeated
here.

## Repo layout

- `src/sim/` — the pure simulation (see purity rule below)
- `src/worker/` — owns the `World`, runs ticks, persistence (`persistence.ts`
  IndexedDB rotating slots), offline catch-up (`catchup.ts`), the render/stats frame
  builders (`frame.ts`), and the worker↔main protocol (`protocol.ts`)
- `src/render/` — pure canvas renderer (a function of a frame snapshot)
- `src/ui/` — React chrome (charts, timeline, inspector, controls, `share.ts` URL/file)
- `src/store/` — the Zustand store + worker handle (`useSimStore.ts`)
- `docs/` — SPEC.md, plans, VERSIONING.md, `findings/`, `designs/`
- `public/` — `cold-open.viv.gz` (the pre-evolved first-visit snapshot asset)
- `assets/` — brand mark
- `tests/`, `scripts/` — `scripts/` has the headless runner, sweep, A/B compare,
  brain-capacity experiment, and cold-open generator

## Commands

- `pnpm build` — typecheck (`tsc --noEmit`)
- `pnpm test` — Vitest (Node env, never jsdom)
- `pnpm bench` — `vitest bench`
- `pnpm lint` — `biome check .`

The pre-commit gate is: **build, then test, then lint. All must pass before
committing.** (lefthook runs `biome check` on staged files automatically.)

## Tech stack

| Layer | Choice / why non-obvious |
|---|---|
| Language | TypeScript **5.7** (pinned; do NOT let pnpm pull TS7 native compiler) |
| Test | Vitest, `environment: 'node'` — jsdom is banned (see gotchas) |
| Property tests | fast-check — most sim tests are invariants over random inputs |
| Lint/format | Biome 2.x, `indentStyle: space`. `noRestrictedImports`/`noRestrictedGlobals` scoped to `src/sim/**` enforce purity |
| Package manager | pnpm 11 — build-script approvals live in `pnpm-workspace.yaml` `allowBuilds:` |
| UI | React 19 (chrome only) + Zustand store; Recharts for charts; Tailwind 4 |
| Persistence | `idb-keyval` (IndexedDB, worker-side); gzip export via `CompressionStream` |

## Key architectural patterns

- **Layering (never violate the direction):** `sim/` (pure) → `worker/` (owns the
  World, runs ticks) → `render/` (pure fn of a snapshot) → `ui/` (React chrome).
  Outer layers may import inner; never the reverse. `ui/` must never call `tick()`.
- **`sim/` imports nothing.** No React, no DOM, no `window`, no `Math.random()`.
  This one constraint buys deterministic tests, the Web Worker, and the headless
  runner. Enforced in three layers: Biome lint (scoped to `src/sim/**`), the
  determinism test, and the headless runner crashing on a DOM/React import. Layers
  2–3 are the real gate.
- **Everything the sim needs arrives as arguments.** RNG is passed in as named
  sub-streams; config is passed in; no module-level mutable state read by `tick()`.

## Known gotchas

- **jsdom is banned in tests.** A sim test that passes because jsdom supplied a
  `window` has destroyed the guarantee it checks. Vitest defaults to `node`.
- **Determinism is bit-exact and load-bearing.** Never iterate a `Set` or
  `Object.keys()` in `sim/` (insertion order breaks it); all agent iteration is
  index-based over a stable ID array. Never use `Math.tanh`/`sin`/`exp` in the
  brain — use the pinned rational approximation. RNG is seeded sub-streams only.
- **Energy and water are closed integer ledgers.** Every transfer moves quanta
  between named compartments; nothing is minted or destroyed. `totalEnergy` and
  `totalWater` must be exactly equal (`===`, integer) before and after every tick.
  If you add a transfer, name both endpoints.
- **The `hidden` recurrent vector is serialized runtime state**; the derived
  brain-weights pair is a cache and is NOT serialized (re-derived on load). Do not
  confuse them.
- **`realTime` never lives in `sim/`** — it's non-deterministic wall-clock; the
  worker attaches it outside the sim. The `sim/` event log is `{tick, event}` only;
  typed `lineageEvents` (extinction/boom/dominance) are detected on the history
  cadence and narrated by tick/generation, never wall-clock.
- **Save format is `version: 3`** with a forward-migration chain in `serialize.ts`
  (v1→v2 added `brainKind`; v2→v3 added lineage identity/events). A `version: N` reader
  loads any `version: <N` blob (every field optional/defaulted). Bump + migrate on any
  breaking schema change; never tie the save integer to a git tag.
- **Offline catch-up must be bit-identical to live ticks** — it calls the same
  `tick()`+`recordHistory()`, stripping only observation (no frame/stats emission).
  `tests/sim/catchup.test.ts` is the guard; never sneak a side effect into a
  catch-up-only path.
- **pnpm 11 + lefthook:** if scripts loop on `runDepsStatusCheck`, the lefthook
  build is unapproved — set `allowBuilds: {lefthook: true}` in `pnpm-workspace.yaml`
  and reinstall.

## Further reading

- **`docs/SPEC.md`** — the full simulation specification (source of truth). Read the
  relevant section before implementing; it preserves the *reasoning*, not just the
  decision.
- **`docs/plans/phase-N-plan.md`** — the per-phase execution plans (0–5 shipped).
  **`docs/findings/`** records empirical verdicts (e.g. the Phase 4 keep-patchbay
  decision). Post-beta modes (5D) remain planned-but-deferred.
- **`docs/VERSIONING.md`** — the three version tracks (commits, `v0.x.0` milestone
  tags per phase gate, and the serialized save-format integer).
