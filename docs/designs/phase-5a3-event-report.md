# Phase 5A.3 — Typed Event Log + "While You Were Away" Report

## Context

Phase 5A-core persists + catches up, but reopening after a long absence shows no
*narrative* of what changed — the retention hook the DoD calls for ("Generation 4,802.
The northern herbivores are extinct."). This adds a **deterministic typed event log**
keyed on stable lineage identity, and a report the worker surfaces after catch-up.

The prerequisite the earlier plan assumed ("stable `founderLineageRoot` from Phase 1.1")
does **not** exist in `sim/` — a cumulative `rootOf` map exists only in the worker
(`frame.populationByLineageRoot`), is not serialized, and is rebuilt on reload. That is
insufficient: events must fire *during* replayed catch-up ticks, deterministically, so
lineage identity + event detection must live in `sim/` and be serialized.

## Goals

- Stable per-creature founder-lineage-root identity in `sim/`, serialized (survives
  catch-up + reload).
- Deterministic typed events (`extinction`, `lineageBoom`, `newDominant`) fired on the
  existing history cadence — identical live or during catch-up.
- A "while you were away" report the worker posts after a catch-up that produced events,
  rendered grayscale, narrated by **generation/tick** (never wall-clock — invalid across
  a catch-up boundary).

## Non-Goals

- Per-lineage naming / the LLM naturalist (post-beta).
- A full lineage tree / speciation chart (later 5B/5+ task).
- Changing the free-form `eventLog` (`birth:`/`kill:`/`extinct`) — kept for back-compat;
  typed events go in a new parallel array.

## Design

### Lineage roots in `sim/` (serialized)

`World` gains `lineageRoots: Record<number, number>` (creature id → founder root id),
cumulative. Populated at the two points creatures are born:
- founders in `world.ts` (`parentId === null` ⇒ root = own id),
- births in `tick.ts` `tryMate` (root = parent's root, falling back to own id).

It is never pruned (a dead parent's root still resolves its children). Serialized as a
`{id: root}` map (small: one int pair per creature ever born within the retained
horizon — pruned lazily to living + recently-dead if it ever grows, deferred).

The worker's `rootOf` map is removed; `frame.populationByLineageRoot` reads
`world.lineageRoots` instead (one source of truth).

### Typed event detection (deterministic, in `history.ts`)

A new `world.lineageEvents: LineageEvent[]` (serialized). On each `recordHistory` sample
(the existing ~`HISTORY_SAMPLE_INTERVAL` cadence, already called per tick by both the
live loop and catch-up), compute per-root live population and compare to the trailing
history to fire:

```ts
type LineageEvent =
  | { kind: 'extinction'; tick: number; lineage: number }
  | { kind: 'lineageBoom'; tick: number; lineage: number; factor: number }
  | { kind: 'newDominant'; tick: number; lineage: number };
```

- **extinction** — a root whose population was > 0 at the previous sample and is 0 now.
- **lineageBoom** — a root whose population ≥ doubled vs. its value `BOOM_WINDOW` ticks
  ago (named constant; measured against the retained history samples).
- **newDominant** — a different root becomes the largest by population fraction and holds
  it for `DOMINANCE_WINDOW` ticks (tracked via a small serialized "current dominant +
  since-tick" pair on `World`).

All three are pure functions of sampled per-root populations, so they are deterministic
and fire identically during catch-up. They append to `world.lineageEvents`.

Event log growth is bounded: `lineageEvents` is capped to the most recent `N` (a ring),
so an ancient world does not accumulate unbounded events.

### The report (worker → UI)

The worker records `world.tick` at boot *before* catch-up. After catch-up completes, it
slices `lineageEvents` with `tick >= bootTick` (the events that happened while away) and,
if non-empty, posts `{ t: 'report', sinceTick, nowTick, events }`. The UI renders a
dismissible grayscale panel: a headline generation/tick + up to a few of the most
dramatic lines ("Generation 4,802. Lineage #17 is extinct. Lineage #42 tripled.").

No report when catch-up produced no events, or when there was no catch-up.

### Save version 2 → 3

New serialized fields (`lineageRoots`, `lineageEvents`, dominant tracker). The v2→v3
migration defaults them (empty map / empty array / null) — a v2 save loads and simply
starts tracking from reload (no historical events reconstructed, which is correct: we
cannot invent a past we didn't record).

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Lineage identity location | `sim/`, serialized | Events must fire deterministically during catch-up; worker-only `rootOf` can't. |
| Event detection hook | `recordHistory` cadence | Already called per tick by live loop AND catch-up; keeps one deterministic path. |
| Typed events storage | New `lineageEvents` array | Doesn't disturb the free-form `eventLog` or `countExtinctionEvents`. |
| Narration basis | generation/tick, never wall-clock | `tick × MS_PER_TICK` is invalid across a catch-up boundary. |
| Report trigger | after catch-up, events since bootTick | The retention hook is specifically "what changed while away." |
| Save format | bump 2 → 3, defaulted migration | New serialized runtime state; old saves load and start fresh tracking. |

## Rejected Alternatives

- **Keep lineage tracking in the worker** — not serialized, rebuilt on reload; can't fire
  events during catch-up. Rejected.
- **Reconstruct events from `world.history`** — history is downsampled + lacks per-root
  detail; can't reliably detect booms/extinctions. Rejected.
- **Wall-clock timestamps in events** — forbidden in `sim/` and wrong across catch-up.
- **Detect events inside `tick()`** — pollutes the hot loop with derived bookkeeping and
  a per-tick per-root scan; the history cadence is the right granularity.

## Edge Cases & Constraints

- **Determinism** — event detection reads only sampled per-root populations (no RNG, no
  wall-clock); the existing determinism + catch-up bit-identical tests must still pass,
  now including `lineageRoots`/`lineageEvents` in the fingerprint.
- **Unbounded growth** — `lineageEvents` is a bounded ring; `lineageRoots` grows with
  total creatures ever born (acceptable for beta; a prune-to-living pass is a noted
  follow-up if saves bloat).
- **v2 save** — loads, tracks from reload; no fabricated history.
- **Dominance flapping** — requires holding dominance `DOMINANCE_WINDOW` ticks before
  firing, so a tie that flips each sample does not spam events.

## Testing

- `tests/sim/lineage-events.test.ts` — scripted fixtures: a lineage going extinct fires
  exactly one `extinction` at the right tick; a doubling fires `lineageBoom`; a sustained
  lead fires `newDominant` (and a brief lead does not). Deterministic, `sim/` only.
- Extend `tests/sim/catchup.test.ts` fingerprint to include `lineageRoots` +
  `lineageEvents` — proves events replay bit-identically during catch-up.
- Extend `tests/sim/serialize.test.ts` — v2→v3 migration defaults the new fields; a
  round-trip preserves lineage roots + events.

## Open Questions

- (none — resolved.)
