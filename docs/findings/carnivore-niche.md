# Why predation never happens

**Question:** SPEC.md §Goals promises "visible predator–prey oscillation".
`docs/findings/world-scale-oscillation.md` measured **1–6 kills per 45k ticks against
4,000–8,000 births** in *every* world tested, including the legacy reference — a ~1:1000
ratio. ~17% of founders are seeded carnivores (`world.ts`: `diet 0.9`, `aggression 4`) and
Phase 7's seeded `hidden → Attack` circuit did not move the number. Why?

**Reproduce:**

```
tsx scripts/measure-trophic.ts --seeds 1,7 --ticks 20000
```

Tracks the trophic *composition* over time, not just the kill count — the distinction
between "predators exist but cannot connect" (a mechanics problem) and "predators are
selected out" (an economics problem) is invisible in a kill count alone.

---

## Finding 1 — predators are not failing to hunt; they are being deleted

| tick | pop | carnFrac | meanDiet | kills |
|---|---|---|---|---|
| 0 | 60 | 0.167 | 0.237 | 0 |
| 2000 | 118 | 0.025 | 0.111 | 2 |
| 6000 | 119 | **0.000** | 0.103 | 2 |

The seeded carnivore fraction collapses from 0.167 to **zero within 6000 ticks**, and mean
diet settles at the herbivore value. There is no predation because after ~2000 ticks there
are no predators. Everything else follows from that.

## Finding 2 — the immediate cause: damage was ~6% of health

`attackPower` (`aggression × size`) is a **unitless contest strength** — it is compared
against `defenseScale` as a *ratio* in `pWin = power/(power+resist)`. It was also being
used directly as damage in **health units**, and the two scales do not match:

```
founder herbivore maxHealth = 20 + 40·size(3) + 40·armor(≈5) = 340
founder carnivore damage    =      aggression(4) · size(5)   =  20   → 17 landed hits
```

17 landed hits is ~30 attempts after escapes (~12%) and lost contests (~43%), against 1
HP/tick regeneration. A kill was effectively unreachable while the attacker paid 2 energy
per attempt, so hunting was strictly worse than grazing and selection removed it.

**Fix (shipped):** `ATTACK_DAMAGE_COEF = 2.0`, a separate coefficient so damage scales
without also moving `pWin` and `isThreat` — i.e. without changing *who initiates* and *who
flees*, only how hard a landed hit lands. A founder kill is ~8 landed hits instead of 17.

**Measured effect (seed 1), kills by tick 14000:**

| coefficient | kills @14k | carnFrac @12k | legacy `gate.test.ts` |
|---|---|---|---|
| 1.0 (unfixed) | 2, frozen from tick 2000 | 0.000 (gone by 6000) | passes, cv 0.0279 |
| **2.0 (shipped)** | **14** | 0.034 | **passes, cv 0.0358** |
| 4.0 | **43, still climbing** | 0.034 | **fails**, cv 0.0131 |

### Why not 4.0, which is three times better

4.0 is closer to the right physics, and it fails `gate.test.ts`'s `cv > 0.02`. That is
worth stating precisely, because the obvious move — relax the gate — is the move that let
Phase 6 rot for two phases.

The gate world is pinned at its cap in *every* variant (mean 119 of a 120 cap, min 95–110),
so its CV is noise around a flat line rather than oscillation, and the **unfixed** baseline
passes by only 0.0079. More predation regulates that noise away, so a strictly better
ecology scores worse. The assertion does not measure what its comment claims.

2.0 ships because it is a genuine improvement (7× the predation) that *also* improves the
gate's own metric, so nothing has to be weakened to land it. Raising to 4.0 should be a
deliberate decision taken together with replacing that CV assertion — not smuggled in
alongside it.

---

## Finding 3 — the deeper cause, NOT fixed: trophic role cannot speciate

`genetics.distance()` compares **only brain weights and enable masks**. It ignores every
trait gene. So:

```
distance(founder carnivore, founder herbivore) = 0.39
distance(founder herbivore, founder herbivore) = 0.42
SPECIES_COMPAT_THRESHOLD                       = 8
```

A 5×-size, armoured, `diet 0.9` predator and a small `diet 0.1` grazer are *the same
species* and freely interfertile. Ten carnivores among fifty herbivores are therefore
**genetically swamped** — their offspring blend back to the herbivore mean within a few
generations. This is why the morph disappears even once hunting pays.

### Two fixes were tried and both measured worse. Both are reverted.

**(a) `DIET_SPECIALIZATION = 2`** — capture `(1−diet)²` of plants and `diet²` of meat, so a
generalist at diet 0.5 keeps 25% of each while a specialist keeps 81%. The reasoning was
sound: the linear form is *not a trade-off*, so nothing selects against the middle and the
population slides to one blurred optimum.

It raised kills (38 by tick 14k) but killed the carnivores *faster* (gone by 2000 rather
than 14000), because it **removed their fallback**: at `diet 0.9` a carnivore's plant
capture drops from 10% to 1%. It converts facultative predators into obligate ones, which
is only survivable if hunting is reliable — and it is not yet. Right idea, wrong order.

**(b) `DIST_DIET_COEF = 10`** — add `|Δdiet|` to genome distance, making carnivores
reproductively isolated (measured: carn↔herb 8.43, past the threshold of 8; carn↔carn 0.95
and herb↔herb 1.00 still matable). This is the textbook fix for swamping.

It was the worst result of all: kills 4, carnivores gone by tick 2000. Isolation converts
one gene pool into several **unviable** ones — ten predators split across demes cannot find
mates. Concentrating all carnivores into one deme and raising them to 25% of founders did
not rescue it (kills 8, still gone by 2000).

**The lesson:** isolation only helps if what it isolates is viable, and specialization only
helps if the specialty pays. Both depend on a prerequisite that is still missing.

---

## What is actually blocking a self-sustaining predator

Hunting is not yet *reliable* enough for an animal to live on. That is the prerequisite,
and it is the next thing to measure — specifically whether the brain emits `Attack` at all
often, and whether pursuit closes the gap:

- `reach` is `2.0 + 0.5·size` ≈ 4.5 world units, while `senseRadius` is 25. A predator
  spends most of its time seeing prey it cannot touch, and closing that gap needs a speed
  advantage it barely has (founder carnivore 5 vs herbivore 4).
- Whether `Action.Attack` clears `ATTACK_THRESHOLD` often enough is unmeasured. The
  trophic instrument counts outcomes, not intents; an attack-funnel counter
  (intents → in-reach → initiated → not-escaped → won → killed) would localise it in one
  run.

Once hunting pays on its own, (a) and (b) should be re-tried **in that order** — they are
the right mechanisms, applied prematurely here.
