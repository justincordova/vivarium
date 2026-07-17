# Phase 4 — Brain Capacity Findings

**Question (SPEC.md §"Why not NEAT (yet), and how to measure the swap"):** does the
patchbay's fixed-skeleton ceiling bind — i.e. is it ever worth moving to NEAT? Decided
by two instruments, not intuition: enable density and the enlargement experiment.

**Reproduce:**

```
tsx scripts/experiment-brain-capacity.ts --seed 42 --ticks 4000
tsx scripts/experiment-brain-capacity.ts --seed 7  --ticks 4000
tsx scripts/compare.ts --seed 42 --ticks 3000          # A/B rule vs patchbay
```

All three are deterministic (byte-identical re-runs) and run under plain Node (also a
`sim/` purity gate). Numbers below are from this machine at the default 64×64 grid;
they are qualitative signals, not tuned constants.

---

## Instrument 1 — enable density (`mean(enabled)` over a long patchbay run)

Interpretation (SPEC): climbs to 0.9+ and pins → evolution wants every arrow (ceiling
binds). Plateaus ~0.4 → capacity was never the constraint.

| seed | tick 0 | tick 4000 | trend |
|---|---|---|---|
| 42 | 0.197 | 0.242 | slow climb, far below 0.5 |
| 7  | ~0.20 | <0.5   | slow climb, far below 0.5 |

**Verdict: CAPACITY IS NOT THE CONSTRAINT (robust across seeds).** Enable density
drifts up only slowly and stays well under 0.5 — most arrows go unused. Evolution is
not pushing to fill the skeleton, so the fixed hidden-neuron count is not what limits
behavior at this stage. This is the stronger of the two signals: it is consistent
across seeds and monotone.

## Instrument 2 — enlargement experiment (HIDDEN=10 vs HIDDEN=20, fresh worlds)

`HIDDEN` is world-creation geometry: changing it reshapes the arrow count
(`SENSORS·H + H·H + H·ACTIONS`: 350 → 900) and the `hidden` vector length, so a
HIDDEN=10 save **cannot** migrate into a HIDDEN=20 build. The experiment runs fresh
`createWorld` at each HIDDEN on the same seed.

| seed | HIDDEN=10 health proxy | HIDDEN=20 health proxy | Δ | reads as |
|---|---|---|---|---|
| 42 | 1180 | 116 | −90% | HIDDEN=20 worse |
| 7  | 176  | 295 | +68% | HIDDEN=20 better |

**Verdict: INCONCLUSIVE at this horizon.** The two seeds disagree, and the proxy is
dominated by `populationVariance`, which is high-variance itself over only 4000 ticks.
A stable enlargement verdict needs longer runs (≥50k ticks) and more seeds. **Do not
read a NEAT decision off the enlargement instrument yet** — at short horizons it is
seed noise.

---

## Heritability gate (Task 4.3)

Because expression is mean-of-alleles but inheritance is meiotic per-arrow segregation,
a child inherits a *resampled* expressed brain. If parent↔child expressed-brain
distance is large relative to the population's mean pairwise distance, selection fights
inheritance noise and behavior cannot accumulate. Gate: ratio ≤ `HERITABILITY_MAX`
(0.5).

| seed | patchbay heritability ratio | gate |
|---|---|---|
| 42 | 0.379 | PASS |
| 7  | 0.281 | PASS |

**Verdict: PASS.** A child is well under half as far from its (tracked) parent as two
random creatures are from each other, so behavior *can* reliably accumulate under
selection. The deferred per-locus linkage version-bump stays deferred (it would only
move in-scope on a FAIL). Note the metric tracks only the initiating parent recorded at
birth (the other parent is not stored), so it is a lower bound on true mid-parent
distance — the conservative direction for a risk gate.

## A/B comparison (Task 4.3 — the headline)

Same seed + config, rule vs patchbay, ranked by world-health. Both brains sustain a
living, oscillating, speciating world for the horizons tested; conservation and
determinism hold under both. The patchbay tends toward **higher behavior novelty** and
comparable-or-higher species counts — the emergent-behavior signal the project exists
to produce — while the rule policy tends to sustain a larger mean population. Neither
"wins" on every axis; the patchbay earns its place by producing behavior nobody
scripted while staying within the same health envelope.

---

## Overall Phase 4 verdict

**KEEP THE PATCHBAY.** The robust instrument (enable density) says capacity is not the
constraint; the enlargement instrument is inconclusive at short horizons and does not
override that. Heritability passes, so behavior can accumulate. NEAT remains out of
beta (SPEC.md §Non-Goals), gated on a future re-run of these instruments at long
horizons if emergent behavior ever plateaus.

**Follow-ups (not blocking):**
- Re-run the enlargement experiment at ≥50k ticks across ≥5 seeds before trusting its
  verdict either way.
- Watch enable density over evolutionary time (10⁵+ ticks) — if it ever climbs toward
  0.9 and pins, revisit the NEAT decision.
