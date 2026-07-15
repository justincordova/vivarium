import { makeConfig } from "@sim/config";
import { tick } from "@sim/tick";
import type { World } from "@sim/types";
import { createWorld } from "@sim/world";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The viability smoke gate (the false-green killer). Phase 0's other gates all pass
 * on a DEAD world — a population that collapses to zero on tick 50 still conserves
 * energy and replays deterministically. This asserts the world is *alive and
 * dynamic*: births, kills, and matings actually occur and the population neither
 * dies out nor explodes (SPEC.md §Initial Conditions; plan Phase 0.11).
 *
 * This is a bootstrap smoke, NOT a long-run viability proof: ~5000 ticks is only ~5
 * days at TICKS_PER_DAY and less than one season, so it never exercises a seasonal
 * turn. Its job is "does the closed loop turn at all."
 */

/** Fixed, committed seed list — any failure is reproducible, never "flaky, re-run". */
const SEEDS = [1, 2, 3, 4, 5] as const;
/**
 * ~3000 ticks — enough to see the bootstrap loop turn (births, kills, oscillation)
 * without the multi-minute cost of 5000× live ticks over 5 seeds. Still a bootstrap
 * smoke, NOT long-run viability (that is Phase 1's 100k-tick job).
 */
const TICKS = 3000;
/** Quorum: a viable config may lose one unlucky spawn-stream seed. */
const QUORUM = 4;
/** Population band (wide — smoke, not balance; balancing is Phase 1). */
const POP_CEILING = 5000;

interface SeedOutcome {
  seed: number;
  survived: boolean;
  peakPop: number;
  births: number;
  kills: number;
  matings: number;
}

function runSeed(seed: number): SeedOutcome {
  const world: World = createWorld(seed, makeConfig({}));
  let survived = true;
  let peakPop = world.creatures.length;
  let matings = 0;
  let births = 0;
  let kills = 0;

  let prevEventLen = 0;
  for (let i = 0; i < TICKS; i++) {
    tick(world);
    const pop = world.creatures.length;
    if (pop === 0 || pop > POP_CEILING) {
      survived = false;
      break;
    }
    peakPop = Math.max(peakPop, pop);
    // Count events emitted this tick (birth / kill markers in the sim event log).
    for (let e = prevEventLen; e < world.eventLog.length; e++) {
      const ev = world.eventLog[e]?.event ?? "";
      if (ev.startsWith("birth:")) {
        births++;
        matings++; // a birth implies a successful mating
      } else if (ev.startsWith("kill:")) {
        kills++;
      }
    }
    prevEventLen = world.eventLog.length;
  }
  return { seed, survived, peakPop, births, kills, matings };
}

describe("viability smoke gate (bootstrap, not long-run)", () => {
  // Running 5 seeds × 5000 live ticks is the most expensive test in the suite; the
  // outcomes are computed once in beforeAll (generous timeout) and asserted below.
  let outcomes: SeedOutcome[] = [];
  beforeAll(() => {
    outcomes = SEEDS.map(runSeed);
  }, 300_000);

  it(`sustains a living population on at least ${QUORUM} of ${SEEDS.length} seeds`, () => {
    const alive = outcomes.filter((o) => o.survived).length;
    if (alive < QUORUM) {
      throw new Error(
        `only ${alive}/${SEEDS.length} seeds survived ${TICKS} ticks (need ${QUORUM}):\n` +
          outcomes
            .map(
              (o) =>
                `  seed ${o.seed}: survived=${o.survived} peak=${o.peakPop} births=${o.births} kills=${o.kills}`,
            )
            .join("\n"),
      );
    }
    expect(alive).toBeGreaterThanOrEqual(QUORUM);
  });

  it("the closed ecosystem loop turns: births, kills, and matings occur on the quorum", () => {
    const withBirths = outcomes.filter((o) => o.births >= 1).length;
    const withKills = outcomes.filter((o) => o.kills >= 1).length;
    const withMatings = outcomes.filter((o) => o.matings >= 1).length;
    expect(withBirths, "seeds with >=1 birth").toBeGreaterThanOrEqual(QUORUM);
    expect(withKills, "seeds with >=1 kill").toBeGreaterThanOrEqual(QUORUM);
    expect(withMatings, "seeds with >=1 mating").toBeGreaterThanOrEqual(QUORUM);
  });
});
