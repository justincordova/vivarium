# World Scale — does the shipped world oscillate?

**Question:** SPEC.md §Goals states the beta definition-of-done as "a stranger opens a
URL, sees a living world with **visible predator–prey oscillation**". Is that true of the
world we actually ship?

**Why it was open.** The Phase 1 exit gate (`tests/sim/gate.test.ts`) is pinned to the
legacy **200×200 rule** world. Phase 6 enlarged the default to 1000×1000 and
`docs/designs/living-world.md` deferred "default-world rebalancing", so the oscillation
gate has not been watching the shipped world since. Nothing was measuring the claim.

**Reproduce:**

```
tsx scripts/measure-oscillation.ts --seeds 1,7,42 --ticks 50000 --warmup 5000
```

Deterministic (byte-identical re-runs), plain Node (also a `sim/` purity gate). ~80 min on
this machine. Three configs are measured side by side so the shipped number is read
against a reference rather than in a vacuum, and so world size can be separated from brain
choice.

---

## Results (50,000 ticks, 5,000 warmup, 3 seeds)

| config | alive | **cycles** | species | kills | min→max |
|---|---|---|---|---|---|
| **SHIPPED** 1000×1000 patchbay | **2/3** | **0.5, 0.5, 0.5** | **1, 0, 2** | 3 | 1 → 120 |
| LEGACY 200×200 rule (what the gate measures) | 3/3 | 0, **24, 17** | 37, 30, 7 | 5 | 35 → 120 |
| CONTROL 200×200 patchbay (isolates size from brain) | 3/3 | 0, 3.5, 1.5 | 69, 4, 12 | 11 | 19 → 120 |

`cycles` counts mean-crossings with a ±10% hysteresis band, so noise around a flat line
does not register. Two crossings = one cycle.

---

## Verdict: the shipped world does not oscillate — it booms once and collapses

**1. 0.5 cycles is one boom and one crash, not a rhythm.** Every shipped seed scores
exactly 0.5 — the population rises once and falls once across 45,000 measured ticks. The
legacy world scores 17 and 24 on two of three seeds: genuine sustained cycling. One seed
of three went extinct outright, and the survivors bottom out at a population of 1 and 16.

**2. Diversity collapses to a monoculture.** The shipped world ends at **1, 0 and 2**
species against legacy's 37, 30 and 7. A shorter 8,000-tick run showed the other end of
the same arc — 98 species at a population of 113, i.e. *0.86 species per creature*, nearly
every individual its own species. The population is not an interbreeding ecosystem; it is
a scatter of isolates that drift apart and then die off.

**3. World size is the cause, not the evolved brain.** The control changes only the world
size and recovers most of the loss: 3/3 survive and diversity returns (69, 4, 12 species).
So this is not the patchbay's fault and not an argument against evolved brains — it is the
Phase 6 enlargement.

**Mechanism — density arithmetic.** Phase 6 multiplied world *area* by 25× (200×200 →
1000×1000) while `CREATURE_CAP` stayed at 120 and `senseRadius` stayed capped at 50. So
expected neighbours inside a creature's sense radius (r=25) fell from **5.9 to 0.22**:

| world | pop | expected neighbours @ r=25 |
|---|---|---|
| 200×200 @ cap | 120 | 5.89 |
| 1000×1000 @ cap | 120 | 0.24 |

A creature in the shipped world sees nothing, almost always. No encounters means no
predation, no mate competition, and no gene flow — which is exactly the observed
signature: near-zero kills, monoculture, and a single unopposed boom into the cap followed
by collapse. Matching legacy density at 1000×1000 would need a cap near **3,000**, which
is ~25× the per-tick cost and far outside the offline catch-up budget.

---

## Secondary finding: the CV gate is the wrong instrument

`gate.test.ts` asserts population CV > 0.02 as "not a flat line", and the docstring cites
CV ≈ 0.6 as the healthy hand-validated figure.

**The highest CV in this entire table (0.599, shipped seed 1) belongs to a dying
monoculture that fell from 120 to 1.** A collapse maximises variance. CV cannot separate
"oscillating" from "falling off a cliff", so a world in freefall passes the gate while a
healthy stable one can fail it. Any future rebalance must be judged on **cycles + survival
+ species**, not CV. This is why the instrument counts crossings.

## Secondary finding: "predator–prey" oscillation is a misnomer

Kills are negligible in *every* config — 3, 5 and 11 across three 45,000-tick runs. Yet
legacy seed 7 cycles 24 times on 5 kills. Whatever drives the legacy oscillation, it is
**not** predation; it is far more likely the plant-regrowth/starvation loop. The SPEC's
"visible predator–prey oscillation" language appears never to have been literally true,
and should either be restated as population oscillation or predation should be made to
actually matter.

---

## What this does not decide

The fix is a real design decision with a performance trade-off, and is deliberately left
open here:

- **Shrink the world** back toward 200–400 per side — cheapest, but gives up the terrain
  regions and migration that Phase 6 was for.
- **Raise `CREATURE_CAP` and `senseRadius` together** toward legacy density — preserves
  the big world, but per-tick cost scales with population and the catch-up budget
  (`MAX_OFFLINE_TICKS`, already re-derived once) would need re-deriving again.
- **Concentrate life instead of scaling it** — cluster founders, or make habitable biomes
  a smaller fraction of the map so effective density rises without raising the cap.

A middle point (e.g. 400×400 with a modestly raised cap) is likely, but should be chosen
by re-running this instrument across candidates, not by argument.
