# Vivarium — Agent Context

Browser-based, entirely client-side evolutionary ecosystem simulator: a persistent
world of agents with evolved brains that live, compete, reproduce, and speciate.
TypeScript + Vite + React (chrome only) + a Web Worker running a pure, deterministic
simulation. The interesting artifact is emergent behavior, not the code.

**Status:** early execution. Phase 0 (pure `sim/` core) is being built now; no UI,
worker, or renderer yet. Global conventions (git format, planning workflow) come from
the root `~/agent/AGENTS.md` and are not repeated here.

## Repo layout

- `src/sim/` — the pure simulation (see purity rule below)
- `docs/` — SPEC.md, plans, VERSIONING.md
- `assets/` — brand mark
- `tests/`, `scripts/` — populated per phase (empty scaffold now)

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
  worker attaches it outside the sim. The `sim/` event log is `{tick, event}` only.
- **pnpm 11 + lefthook:** if scripts loop on `runDepsStatusCheck`, the lefthook
  build is unapproved — set `allowBuilds: {lefthook: true}` in `pnpm-workspace.yaml`
  and reinstall.

## Further reading

- **`docs/SPEC.md`** — the full simulation specification (source of truth). Read the
  relevant section before implementing; it preserves the *reasoning*, not just the
  decision.
- **`docs/plans/phase-N-plan.md`** — the current execution plan. Phase 0 is the pure
  core; later phases are gated on empirical results and planned just-in-time.
- **`docs/VERSIONING.md`** — the three version tracks (commits, `v0.x.0` milestone
  tags per phase gate, and the serialized save-format integer).
