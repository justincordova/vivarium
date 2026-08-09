# Terrarium mode — stewardship with a budget

**Status:** designed + implemented (this session). Session-boundary artifact per the root
planning workflow; retire into SPEC.md via sync-docs once it has settled.

## Problem

The world now lives — it oscillates, diversifies and predates
(`docs/findings/world-scale-oscillation.md`, `docs/findings/carnivore-niche.md`). But there
is no *game*. The god-powers (`spawn`, `delete`, `drought`, `flood`) are free and
unlimited, which makes them a debug console rather than a mechanic: nothing is at stake in
using one, so there is no decision to make and nothing to get good at.

`docs/plans/future-work.md` §1 specifies the intended shape: "a refilling influence budget
(seed plant cheap, spawn predator expensive, meteor very expensive), scoring worlds by
*interestingness* (reward oscillation/diversity, punish stagnation) via WorldHealth."

## Decisions

**1. A mode, off by default — not a replacement for the sandbox.** The free god-powers are
a genuine feature (SPEC §Sandbox) and the existing `scienceMode` establishes the pattern of
a persisted UI mode. Terrarium is a second toggle. Off: powers behave exactly as today.
On: powers cost influence and the world is scored. Nothing is removed by the toggle.

**2. Influence lives in the World and is serialized.** It must survive reload and accrue
while away, so it cannot be worker-runtime state. It refills **per tick**, not per
wall-clock second — wall-clock never enters `sim/` (AGENTS.md), and a per-tick rule means
offline catch-up refills it correctly for free, with no separate code path.

Cost: a save-format bump 5 → 6 with a forward migration defaulting `influence` to full.

**3. Scoring reuses `rankScore`, which moves into `sim/`.** The sweep already has exactly
this function — rewards population variance, trait variance, species and novelty; punishes
stagnation; gates everything behind surviving to the horizon so a crash cannot score well.
Re-deriving a second "interestingness" would guarantee the two drift apart. It moves to
`src/sim/score.ts` (pure) and `scripts/sweep-core.ts` imports it, so there is one owner.

**4. No leaderboard.** SPEC §Non-Goals: "No backend, no auth, no server-side persistence."
`future-work.md` notes the leaderboard is the one place a serverless function could ever
appear, and explicitly defers any backend until the mode exists. It now exists; the
backend decision is still separate and stays deferred. The score is local.

**5. Costs are ordered by how much they perturb the world**, per the future-work sketch:

| power | cost | rationale |
|---|---|---|
| `spawn` | 25 | injects a genome that did not evolve — the strongest intervention |
| `delete` | 10 | removes a lineage; smaller, but still hand-editing the population |
| `drought` / `flood` | 40 | a world-wide field shock, the "meteor" tier |

Refill is `INFLUENCE_REFILL_TICKS` per point up to `INFLUENCE_MAX`, so the budget is a
pacing device: you cannot continuously steer, and you must choose *when* to intervene.

**6. An unaffordable command is a no-op, rejected in the worker.** The worker owns the
World and is the only place that can atomically check-and-spend; the UI also disables the
button, but the UI is a hint and the worker is the rule. A rejected command must not
partially apply.

## Not doing

- **Leaderboard / any backend** — see (4).
- **Scoring the player's *interventions*** (e.g. rewarding efficient stewardship). The
  score measures the *world*, which is the thing the SPEC says is interesting. Scoring the
  player invites optimizing the scorer rather than the ecology.
- **Laboratory (forking)** — a separate deferred mode with its own design home.
