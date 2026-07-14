# Phase 4 — Brains Plan

> **Goal:** Replace the rule-based policy with the patchbay neural network
> (`PatchbayBrain`), then compare it against the rule-based baseline on the same
> seed. This is the headline result.
> **Spec:** `docs/SPEC.md` — see **Brain Design** (the patchbay: network,
> forward pass, activation, sparsity, drift), **Crossover/mutation/distance**,
> **Why not NEAT + how to measure the swap**, **Initial Conditions** (seed brains),
> **Build Order** (Phase 4 row).
> **Depends on:** Phase 3 shipped — sandbox, renderer, worker, and crucially the
> Phase 1 world-health instrument all exist, so the swap is *measurable* rather
> than a leap of faith.

## Scope & guardrails

- **The swap touches essentially one file** by design (SPEC.md §Architecture): the
  genome already carries the 350-arrow diploid brain arrays from Phase 0, and
  `genetics.ts`/`serialize.ts`/`distance` already exercise them. Phase 4 supplies a
  `PatchbayBrain.think` (real forward pass) and flips the active `BrainOps`
  implementation. `RuleBasedBrain` stays in the tree for A/B comparison.
- **Determinism constraints are non-negotiable** (SPEC.md §Determinism): the
  activation function is the **pinned rational tanh approximation** (not
  `Math.tanh`); forward-pass accumulation order is **fixed and index-based**; the
  derived mean-weights/OR-masks cache from Phase 0.6 is reused.
- **Empirically gated conclusion:** whether the patchbay is *enough* (vs. moving to
  NEAT) is decided by the two instruments, not asserted. Those instruments already
  live in `stats.ts` from Phase 0/1; Phase 4 runs the experiments.
- No `frontend-design` work here unless the comparison needs a small readout —
  reuse Phase 3 charts. If any new UI is added, load the skill.

---

## Task 4.1: `PatchbayBrain` forward pass in `brain.ts`

- **What:** Implement `PatchbayBrain` alongside `RuleBasedBrain`, both behind
  `BrainOps`.
- **Why:** SPEC.md §"Make the swap cheap": `PatchbayBrain` implements the same
  interface; the tick loop calls `BrainOps.think` unchanged.
- **How:**
  - `think(brain, senses, memory)`: forward pass over the fixed skeleton (18→10,
    10→10 recurrent, 10→7 = 350 arrows). Masked accumulation
    `sum += input * weights[k] * enabled[k]` using the **derived** mean-weights /
    OR-masks (call `deriveExpressed` / read the Phase 0.6 cache).
  - **`memory` = the creature's `hidden` vector from the *previous* tick** (the
    `Creature.hidden: Float32Array(HIDDEN)` field added in Phase 0.1.2; the tick loop
    already threads it in and stores the result back — Phase 0.8.1). Exact recurrence
    composition (fixed, so it is deterministic and single-valued):
    1. For each hidden neuron `h`, accumulate its pre-activation as
       **`Σ(senses[i] · w · en) over the sensors→hidden group + Σ(memory[j] · w · en)
       over the hidden→hidden group`** — both groups sum into the *same*
       pre-activation accumulator for `h`.
    2. `newHidden[h] = tanhApprox(preActivation[h])`.
    3. Actions: `act[a] = tanhApprox(Σ(newHidden[h] · w · en) over hidden→actions)`.
    4. Return `{ actions, hidden: newHidden }`; the tick loop writes `newHidden` back
       to `creature.hidden` for next tick. So recurrence uses the **previous tick's
       post-activation** hidden vector, read before this tick's activation — no
       within-tick self-reference, fully determinate.
  - **Activation:** the pinned rational tanh approximation named in `constants.ts`
    (Phase 0.1) — never `Math.tanh` (SPEC.md §Determinism, §"Activation function
    (pinned)").
  - **Turn output** is a signed angular velocity capped at `MAX_TURN_RATE`
    (SPEC.md §Brain Design turn note), composed across ticks via recurrence — no
    absolute-heading wraparound.
  - Accumulation order fixed and index-based (determinism).
  - `create(spawn)`: newborn ~15% arrows enabled (`NEWBORN_ENABLE_FRAC`), sparse
    (SPEC.md §Brain Design). `mutate`/`crossover`/`distance` already exist in
    `genetics.ts` (Phase 0.5) operating on the diploid arrays — `PatchbayBrain`
    delegates to them, same as `RuleBasedBrain` did.
- **Verify:** `tests/sim/brain.test.ts` extended: `PatchbayBrain.think` is
  deterministic for fixed senses+memory+weights; uses the pinned activation (a
  test asserts output matches the rational approx, not `Math.tanh`); recurrence
  actually feeds hidden state forward (a memory-dependent output differs across two
  ticks with identical senses); disabled arrows contribute zero.

## Task 4.2: Wire the active brain implementation (config switch)

- **What:** A config flag selecting `RuleBasedBrain` vs `PatchbayBrain` as the
  active `BrainOps`, with a save-version bump.
- **Why:** SPEC.md §"Make the swap cheap": bump the save version; the tick loop,
  species rule, and inspector never know which brain is behind the interface.
- **How:**
  - Add `brainKind: 'rule' | 'patchbay'` to `Config`; the tick loop resolves the
    active `BrainOps` from it.
  - Bump serialize `version` (Phase 0.9 migration scaffold); a `version:1`
    rule-based save still loads (forward migration defaults `brainKind:'rule'`).
  - Seed brains for a patchbay cold start are **minimal and clumsy** — enough
    enabled arrows to move toward food and toward mates, nothing more (SPEC.md
    §Initial Conditions).
- **Verify:** Switching `brainKind` and re-initializing runs a patchbay world;
  determinism + conservation property tests still pass under `brainKind:'patchbay'`
  (re-run the Phase 0.8 suite with the flag set); an old rule-based save migrates
  and loads.

## Task 4.3: A/B comparison on the same seed

- **What:** A comparison run: same seed + config, `rule` vs `patchbay`, ranked by
  world-health.
- **Why:** SPEC.md Phase 4 row: "compare against the same seed. The headline
  result." This is how you know the brains earned their place.
- **How:**
  - Extend `scripts/sweep.ts` (Phase 1.5) or add `scripts/compare.ts`: run both
    brain kinds on identical seeds/configs headless for a long horizon, dump
    world-health CSVs side by side.
  - Watch via the Phase 1 debug canvas / Phase 2 renderer for qualitative
    behavior (ambush, flocking, nocturnal niches — the emergent artifacts the
    project exists to produce).
- **Verify:** `scripts/compare.ts --seed S` produces two comparable world-health
  tracks; the comparison is reproducible; a written note records whether patchbay
  brains produce richer emergent behavior than the rule baseline.

## Task 4.4: Run the two swap-decision instruments

> **Empirically gated — decides whether the patchbay ceiling binds, i.e. whether
> to ever move to NEAT. Produces a measured verdict, not a designed one.**

- **What:** Run the enable-density tracker and the enlargement experiment (both
  already built into `stats.ts` from Phase 0/1).
- **Why:** SPEC.md §"Why not NEAT (yet), and how to measure the swap": these two
  instruments — not intuition — decide if/when to swap PatchbayBrain → NeatBrain.
- **How:**
  - **Enable density:** track `mean(enabled)` over a long patchbay run. Interpret
    per spec: climbs to 0.9+ and pins → evolution wants every arrow (ceiling
    binds); plateaus ~0.4 → capacity was never the constraint.
  - **Enlargement experiment:** same seed, 10 hidden vs. 20 hidden (a `HIDDEN`
    config override). World-health improves meaningfully → the ceiling binds;
    indistinguishable → NEAT buys nothing.
  - Record both results in a short findings note (e.g. `docs/findings/phase-4-brain-capacity.md`).
- **Verify:** Both experiments run reproducibly and produce the two signals;
  the findings note states the verdict (keep patchbay / consider NEAT). No code
  decision is forced here — NEAT itself is out of beta (SPEC.md §Non-Goals) and
  gated on this verdict.

---

## Phase 4 exit criteria

- [ ] `PatchbayBrain.think` implemented with pinned activation, fixed
      accumulation order, working recurrence; deterministic.
- [ ] Active brain is config-selectable; determinism + conservation hold under
      `patchbay`; old saves migrate.
- [ ] Same-seed A/B (rule vs patchbay) run reproducibly and compared by
      world-health.
- [ ] Enable-density + enlargement-experiment verdicts recorded.
- [ ] The headline demo exists: a patchbay world showing emergent behavior the
      author did not script (SPEC.md §Vision: "produces things the author did not
      anticipate").

**Next:** `docs/plans/phase-5-plan.md` — persistence + offline catch-up + the
"while you were away" report, observability charts, the pre-evolved cold open,
fields/seasons/terrain depth, speciation charts & lineage tree, then Terrarium /
Laboratory modes. Phase 5+ is a sequenced grab-bag, not one design.
