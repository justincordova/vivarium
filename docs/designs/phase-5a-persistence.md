# Phase 5A-core — Persistence + Offline Catch-up

## Context

Phase 4 shipped real brains and a shippable sandbox (`v0.5.0`). The last DoD clause
is persistence: a stranger opens a URL, watches a world, closes the tab, and finds it
**there and advanced** on return. This design covers the *core* of Phase 5A — IndexedDB
autosave (5A.1) and offline catch-up (5A.2) — the tightest cohesive unit that closes
"close tab, reopen, world advanced." The "while you were away" report (5A.3) and the
URL-hash share + file export (5A.4) are explicitly deferred to later sessions.

The worker already owns the authoritative `World`, runs a fully-synchronous tick loop,
and has `serialize`/`deserialize` from Phase 0.9. This design extends the worker's boot
path and message protocol; it does not touch `sim/` computation.

## Goals

- Autosave the world to IndexedDB crash-safely, so a reopened tab restores the world.
- On reopen, replay the ticks owed since the last save (capped at `MAX_OFFLINE_TICKS`),
  so the world has *advanced* while away — with visible progress.
- A user toggle to disable catch-up (world resumes at its saved tick instead).
- Preserve the two load-bearing invariants: `sim/` purity (no `realTime` inside it) and
  determinism (catch-up ticking is bit-identical to normal ticking).

## Non-Goals

- The typed event-log union (extinction/boom/dominance) and stable `founderLineageRoot`
  identity — a 5A.3 prerequisite, not built here.
- The dramatic "while you were away" report UI (5A.3).
- URL-hash shareable worlds + gzip file export/import (5A.4).
- A nightly-CI long-horizon determinism test (deferred; noted below).
- Save/restore rollback UX, multi-slot history (post-beta).

## Design

### Ownership & boot flow

The worker owns persistence end-to-end (storage, lifecycle, catch-up). No world crosses
the thread boundary just to save — serialization stays where the World lives.

A new `boot` command replaces the cold `init` as the default entry; `init` is retained
for explicit new-world / reset:

```
main thread                          worker
   │  boot { seed, config, catchup }    │
   ├───────────────────────────────────▶│  1. load meta + newest valid slot (IndexedDB)
   │                                     │  2. saved world? deserialize it : createWorld(seed,config)
   │   catchupProgress { done, total }   │  3. if catchup && ticksOwed>0: run owed ticks
   │◀───────────────────────────────────│     stripped-down, post progress
   │              ready                  │  4. emit first live frame + stats
   │◀───────────────────────────────────│  5. begin normal ticking (existing loop, unchanged)
```

### Storage layer — `src/worker/persistence.ts` (worker-only, wraps `idb-keyval`)

Keys:

```
world:a  → SaveBlob        world:b → SaveBlob
meta     → { newest: 'a'|'b', lastSavedRealTime: number, savedTick: number }
```

**Write (`autosave`), write-older-then-flip (crash-safe):**
1. `older = meta.newest === 'a' ? 'b' : 'a'`.
2. Stamp `world.lastSavedRealTime = Date.now()` **in the worker** (never in `tick()`).
3. `set('world:'+older, serialize(world))` — await the slot write.
4. `set('meta', { newest: older, lastSavedRealTime, savedTick })` — the flip.

A crash between steps 3 and 4 leaves the prior `newest` slot fully intact and valid.

**Read (`loadNewest`):** read `meta`; try `newest` slot (validate via `deserialize` +
version + non-empty config); on failure fall back to the other slot; if both fail →
cold start (log, never throw).

**Autosave triggers:** a real ~30s wall-clock `setInterval` in the worker (independent
of `MS_PER_TICK`/speed) **and** a `save` on tab-hide. *Correction from brainstorm:*
`visibilitychange` is a `document` event (main-thread only) — a Worker cannot observe
it. So the **main thread** listens for `visibilitychange` and forwards a `{ t: 'save' }`
command; the worker still owns the actual save logic. **Never `beforeunload`.** The
Autosaver's single in-flight flag prevents a timer-save and a forwarded save from
interleaving a half-flip.

**Errors:** wrap writes in try/catch; on `QuotaExceededError`/any failure, post a
non-fatal `persistError` event and keep simulating (memory world stays authoritative).

### Offline catch-up

On boot after a successful load (toggle on):

```
owed = min( floor((Date.now() - meta.lastSavedRealTime) / MS_PER_TICK), MAX_OFFLINE_TICKS )
```

`MAX_OFFLINE_TICKS` = 3600 (Phase-4 re-derived; worst case < ~20s). Toggle **off** →
skip catch-up entirely; the world resumes at its saved tick (time "paused" while away).
The toggle is a `localStorage` pref passed into `boot`.

The loop calls the **same** `tick()` — no variant — and strips only *observation*:

```
for (let i = 0; i < owed; i++) {
  tick(world);                                        // identical computation
  if (i % HISTORY_SAMPLE_INTERVAL === 0) recordHistory(world);  // read-only observer
  if (i % 500 === 0) post({ t:'catchupProgress', done:i, total:owed });
}
post({ t:'catchupProgress', done:owed, total:owed });
```

Stripped = no `emitFrame` (no snapshot build/transfer), no per-tick `emitStats`. History
sampling stays because it is a pure observer (no RNG draw, no world mutation that differs
from a live run on the same cadence).

### Protocol changes (`src/worker/protocol.ts`)

Commands: `boot { seed, config, catchupEnabled }`, `setCatchup { enabled }`,
`save` (main thread forwards `visibilitychange`).
Events: `catchupProgress { done, total }` (`total:0` = none), `ready`,
`persistError { reason }`.

### Catch-up UI overlay (`App.tsx`; frontend-design skill applies)

Grayscale, monospace, consistent with existing chrome. A single line
`catching up · generation {N}` with a thin `done/total` bar. Shown only when
`total > 0`; dismissed on `ready`. A fresh or same-session world never flashes it. This
is honest progress, **not** the dramatic report (that is 5A.3).

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Persistence owner | Worker end-to-end | World + serialization on one thread; catch-up is compute-bound where `tick()` runs; matches "worker owns the World." |
| Crash safety | 2 slots + meta, write-older-then-flip | A crash mid-write loses one autosave, not the world; SPEC-specified. |
| Catch-up UX | Blocking overlay + progress, then reveal | No half-rendered intermediate states; keeps stripped-down cost saving; clean seam for the future report. |
| Wall-clock | Worker stamps `lastSavedRealTime`; never read by `tick()` | `sim/` purity — `realTime` must not live in `sim/`. |
| Toggle off | Resume at saved tick, don't replay | Clean, unambiguous "time paused while away"; SPEC wants the toggle. |
| Boot vs init | New `boot` = load-or-create; `init` kept for reset | Preserves the tested cold-start path; adds persistence without rewriting it. |
| Dependency | `idb-keyval` | SPEC-named, tiny, no postinstall (build-approval list unaffected). |

## Rejected Alternatives

- **Main-thread persistence** — forces the whole serialized world across the boundary on
  every autosave and splits restore+catch-up across threads.
- **Single storage slot** — a crash/quota error mid-write can corrupt the only copy; no
  fallback.
- **Live-animated catch-up replay** — emitting frames during catch-up defeats the
  stripped-down saving, can stutter, and muddies the bit-identical test surface.
- **Always catch up (no toggle)** — drops a SPEC-specified behavior.
- **Reconstruct `realTime` from `tick × MS_PER_TICK`** — invalid across a catch-up
  boundary (hundreds of thousands of ticks replay in <20s); would give wrong timestamps.
  (Relevant to 5A.3's report; recorded here so it is not reintroduced.)

## Edge Cases & Constraints

- **Both slots corrupt / version too new** → cold start, logged, never a crash.
- **`QuotaExceededError`** → `persistError` event, keep simulating.
- **Overlapping saves** (timer + visibility) → single in-flight flag serializes them.
- **Clock skew / negative owed** → `owed = max(0, …)`; a system clock moved backward
  yields 0 owed, never negative.
- **Very long absence** → `owed` capped at `MAX_OFFLINE_TICKS`; time beyond the cap is
  not replayed (SPEC-accepted; the world simply resumes from the cap).
- **`recordHistory` during catch-up** — confirm in code it is RNG-free and world-mutation
  matches a live run on the same cadence (it appends history + may push an `extinct`
  event, both deterministic); the bit-identical test is the guard.

## Testing

- `tests/sim/catchup.test.ts` — **the load-bearing invariant**: N ticks with the
  stripped observer cadence produce a bit-identical world (`fingerprint`) to N plain
  `tick()` calls. Pure `sim/`.
- `tests/worker/persistence.test.ts` — rotating-slot logic against an in-memory
  `idb-keyval` store: write-older-then-flip targets the right slot; a simulated crash
  between slot-write and meta-flip still loads the prior slot; both-corrupt → cold start.
- Worker message plumbing (`sim.worker.ts`) stays untested directly, per the existing
  convention that testable logic lives in extracted modules (`persistence.ts`, `frame.ts`).

## Open Questions

- (none — resolved during brainstorm.)

## Deferred (flagged, not dropped)

- **Long-horizon determinism test** (one run at `MAX_OFFLINE_TICKS`+ scale, nightly CI):
  deferred to its own task. 3600 ticks is within the existing 1000-tick determinism
  gate's proven envelope; a nightly-CI harness is separate work.
