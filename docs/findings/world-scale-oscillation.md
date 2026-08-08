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

## Resolution: 400×400 (measured, not reasoned)

Picked with the same instrument in sweep mode — `--mode sweep`, 3 seeds × 50k ticks, all
candidates holding grid (128×128, so terrain structure) and solar reservoir (total food)
constant so encounter density is the only variable:

| candidate | density | cycles (seed 1 / 7 / 42) | alive | species |
|---|---|---|---|---|
| shipped 1000×1000 | 0.24 | 0.5 / 0.5 / 0.5 | **2/3** | **1 / 0 / 2** |
| s500 500×500 | 0.94 | 0.0 / 4.0 / 0.5 | 3/3 | 88 / 88 / 33 |
| **s400 400×400** | **1.47** | **5.0 / 2.5 / 4.5** | **3/3** | 89 / 88 / 34 |
| s300 300×300 | 2.62 | 0.0 / 0.0 / 7.0 | 3/3 | 71 / 77 / 54 |
| s200 200×200 | 5.89 | 0.0 / 0.0 / 0.0 | 3/3 | 43 / 52 / 37 |

**Any shrink fixes survival and diversity.** Every candidate goes 3/3 alive with 33–89
species, against the shipped world's 2/3 and 0–2. That part is unambiguous and is the bulk
of the win.

**Density is non-monotonic, which refutes the obvious fix.** The prior going in was
"restore legacy density (5.89)". That is wrong: 200×200 is the *only* candidate that never
oscillates at all — 0.0 cycles on all three seeds, pinned flat against the cap (seed 7 sits
at mean 118.9, min 110, CV 0.011). Too sparse collapses; too dense saturates. The legacy
density is on the wrong side of the peak, and legacy's own seed 1 (0.0 cycles) agrees.

Why saturation, when legacy at the same density cycled? Legacy ran a 64×64 grid; these
candidates run 128×128. Food is per-cell, so these worlds carry **4× legacy's food** at the
same population cap. Well-fed populations pin at the cap and stop cycling. Density sets
encounter rate; cells set food. Both matter, and only the first was varied here.

**400 is the pick:** the only candidate oscillating on all three seeds, 3/3 alive,
population swinging 35→120, and free (no `CREATURE_CAP` raise).

**Shrinking costs none of Phase 6's terrain**, which is why it was preferred over paying
for a bigger cap. `generateTerrain` samples its noise in **normalized UV**
(`col/(cols-1)`, `terrain.ts:72-77`) on a fixed lattice, so the biome map is a function of
`gridCols/gridRows` *only* and does not depend on `worldWidth/worldHeight` at all. Holding
the grid at 128×128 and shrinking world units yields a **bit-identical biome map** whose
regions are merely smaller relative to sense radius and speed. Every region and biome
Phase 6 added survives; only the distance between things changes.

### Honest limits of this result

- **n=3 cannot resolve a sharp optimum.** s300 and s500 each cycle strongly on exactly one
  seed (7.0 and 4.0), so per-seed variance is large and 400's margin over its neighbours is
  suggestive, not conclusive. What *is* robust is the ordering at the ends: 1000 collapses,
  200 saturates. 400 is a good point in a broad basin, not a proven peak.
- **Restoring density is not free after all.** Density is exactly what the per-tick cost is
  sensitive to (sensing scales with neighbours returned), so 400×400 measures ~34.0 ms/tick
  against 1000×1000's ~20.8. `MAX_OFFLINE_TICKS` drops 1000 → 550 to hold the <20 s bound.
  Live pacing is unaffected (34 ms inside the 50 ms `MS_PER_TICK` budget); fast-forward
  headroom falls from ~2.4× to ~1.5× real-time.
- **`pnpm bench` under-reports this world** and was not used for the re-derivation: its
  600-tick warmup does not reach steady state at the new density, reporting ~17 ms/tick
  against a measured 34. Deepening that warmup is worthwhile follow-up work.
- **The shipped world is still not gated in CI.** One seed at 50k ticks is ~30 minutes, far
  beyond a test-suite budget, so `gate.test.ts` stays pinned to the legacy rule world and
  this script remains the instrument. A cheap proxy gate is unsolved.
- **Existing saved worlds keep the old size and stay broken.** World dimensions are
  serialized per-world, so a returning visitor resumes their 1000×1000 world — correct
  behaviour (silently resizing a running world would teleport every creature and break
  continuity), but it means the fix reaches existing players only if they re-init. No
  save-format bump is involved: the schema is unchanged, only the default values.
- **Creature render radii are coupled to world size and had to be rescaled.** `MIN_RADIUS`
  /`MAX_RADIUS` in `render/palette.ts` are world units, so at `fitCamera` zoom
  (`viewport / worldWidth`) the 2.5× shrink magnified every creature 2.5×, overlapping them
  and hiding the terrain. Divided by 2.5 to preserve the tuned appearance. This coupling is
  the same class of staleness as the original bug — a world-size change silently
  invalidating a constant derived from it.

## What this does not decide

Options considered and *not* taken — all still open if 400×400 proves insufficient:

- **Lower the grid toward 64×64** — untested, and the most promising remaining lever. It
  attacks the *other* half of the mechanism: cells set total food, and 128×128 carries 4×
  legacy's food, which is the likeliest reason dense candidates saturate at the cap rather
  than cycling. It would also cut per-tick cost. It does change terrain granularity, which
  shrinking did not.
- **Raise `CREATURE_CAP` and `senseRadius` together** toward legacy density — preserves
  the big world, but per-tick cost scales with population and the catch-up budget
  (`MAX_OFFLINE_TICKS`, already re-derived once) would need re-deriving again.
- **Concentrate life instead of scaling it** — cluster founders, or make habitable biomes
  a smaller fraction of the map so effective density rises without raising the cap.

A middle point (e.g. 400×400 with a modestly raised cap) is likely, but should be chosen
by re-running this instrument across candidates, not by argument.
