# Versioning — Vivarium

Three independent version tracks. Do not conflate them. (General convention lives
in the global `AGENTS.md`; this file records the Vivarium-specific mapping.)

## 1. Commits — fine grain

Conventional Commits (`type(scope): description`), one per logical change. Scopes
follow the layer names: `sim`, `worker`, `render`, `ui`, `scripts`, `docs`. This is
the detailed history; no version numbers here.

## 2. Milestone tags — coarse grain (`0.x` pre-release SemVer)

Each completed **phase** (per `docs/plans/` and SPEC.md §Build Order) is one minor
bump. Patch bumps are fixes within a phase. `v1.0.0` is the beta definition-of-done.

**Tag only when the phase's exit gate is actually green** (annotated tag,
`git tag -a vX.Y.Z -m "..."`).

| Tag | Phase | Gate that must be green before tagging |
|---|---|---|
| `v0.1.0` | Phase 0 — invisible `sim/` core | All Phase 0 exit criteria, incl. the **0.11 viability smoke gate** (world sustains a living, interacting population). |
| `v0.2.0` | Phase 1 — the instrument | A config **oscillates and diversifies for 100k ticks** (the make-or-break gate). |
| `v0.3.0` | Phase 2 — the window | Worker + canvas renderer show a live world without stutter. |
| `v0.4.0` | Phase 3 — the sandbox | Inspector, mutation slider, god-powers, follow-cam, charts; **static deploy works** ("Ship it"). |
| `v0.5.0` | Phase 4 — brains | `PatchbayBrain` swapped in; same-seed A/B done; the two swap-decision instruments + heritability gate recorded. |
| `v1.0.0` | Phase 5A–5C — persistence closes the loop | Beta DoD met: a stranger opens a URL, sees oscillation, reads a genome, adjusts mutation, closes the tab, finds the world waiting (advanced, with a "while you were away" report). Shipped: persistence + offline catch-up + report, shareable URL/file, cold open, timeline + lineage speciation view, seasonal temperature pressure. **5D (Terrarium/Laboratory) is post-beta and deferred.** |

Patch examples: `v0.1.1` = a Phase-0 bugfix after `v0.1.0` was tagged;
`v0.4.2` = a second fix to the shipped sandbox.

Post-beta work (Terrarium/Laboratory modes, LLM naturalist, etc. — SPEC.md
§Non-Goals) continues as `v1.x` once it lands.

## 3. Save-format version — the serialized integer

A monotonic integer inside every serialized world (started at `version: 1`; **now
`3`** after Phase 5A.3, per SPEC.md §Persistence). **Independent of git tags and the
SemVer above.**

- Bump **only** on a breaking schema change, and ship a `migrate_vN_to_vN+1()`
  forward migration in `serialize.ts`. Old saves are never silently discarded.
- **`1 → 2` (Phase 4 brain swap):** `migrateV1toV2` defaults a missing
  `config.brainKind` to `'rule'`.
- **`2 → 3` (Phase 5A.3 lineage events):** `migrateV2toV3` defaults `lineageRoots`,
  `lineageEvents`, `dominant`, `rootPopSnapshots` so an older save loads and starts
  lineage tracking from reload.
- The save integer moves for its own reasons — never tie it to a git tag.
- Seed reproducibility is guaranteed *within* a save version, not necessarily
  across (SPEC.md §Determinism / RNG Discipline).

## Rule of thumb

- Wrote a feature? → a **commit**.
- A phase's exit gate went green? → a **milestone tag**.
- Changed what's inside a saved world? → bump the **save-format integer** + migration.
