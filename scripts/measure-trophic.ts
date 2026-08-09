/**
 * measure-trophic.ts — is the carnivore niche viable, or does selection delete it?
 *
 * `docs/findings/world-scale-oscillation.md` measured 1–6 kills per 45k ticks against
 * 4,000–8,000 births in EVERY world tested, including the legacy reference. So the
 * oscillation the sim does produce is plant/starvation-driven, and SPEC.md §Goals'
 * "predator–prey oscillation" has never been literally true. ~17% of founders are seeded
 * carnivores (`world.ts`: `diet 0.9`, `aggression 4`) and Phase 7's seeded
 * `hidden → Attack` circuit did not move the number.
 *
 * Two hypotheses, distinguishable by tracking the trophic composition over time rather
 * than just counting kills:
 *
 *   H1 "no opportunity" — carnivores persist as a stable fraction but never connect
 *      (encounter/reach/escape problem). `carnFrac` stays near its seeded 0.17.
 *   H2 "niche nonviable" — carnivores are outcompeted and selection drives `diet` down;
 *      predation is absent because predators are. `carnFrac` decays toward 0.
 *
 * The distinction matters: H1 argues for fixing the *mechanics* of an attack, H2 for
 * fixing its *economics*. The combat arithmetic predicts H2 — a founder herbivore has
 * `maxHealth = 20 + 40·size(3) + 40·armor(≈5) = 340` while a founder carnivore deals
 * `aggression(4) × size(5) = 20` per landed hit, i.e. ~17 successful hits (~30 attempts
 * after escapes and lost contests) per kill, against 1 HP/tick regeneration.
 *
 * Deterministic; lives OUTSIDE `sim/` and imports only `src/sim/` (also a purity gate).
 *
 * Usage:
 *   tsx scripts/measure-trophic.ts --seed 1 --ticks 20000
 */

import { makeConfig } from "../src/sim/config";
import { expressTrait } from "../src/sim/genetics";
import { recordHistory } from "../src/sim/history";
import { tick } from "../src/sim/tick";
import type { Creature } from "../src/sim/types";
import { createWorld } from "../src/sim/world";

interface Args {
  seeds: number[];
  ticks: number;
  every: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seeds: [1], ticks: 20_000, every: 2_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      i++;
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--seeds") args.seeds = next().split(",").map(Number);
    else if (a === "--ticks") args.ticks = Number(next());
    else if (a === "--every") args.every = Number(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.ticks) || args.ticks <= 0) throw new Error("--ticks must be > 0");
  return args;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Mean expressed value of one trait gene across the living population. */
function trait(cs: Creature[], gene: "diet" | "aggression" | "armor" | "size" | "speed"): number {
  return mean(cs.map((c) => expressTrait(c.genome[gene])));
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

function run(seed: number, a: Args): void {
  const world = createWorld(seed, makeConfig({}));
  recordHistory(world);

  process.stdout.write(`\n## seed ${seed}\n`);
  process.stdout.write("  tick   pop  carnFrac  meanDiet  meanAggr  meanArmor  meanSize  kills\n");

  let kills = 0;
  let lastCounted = -1;
  const sample = (): void => {
    const cs = world.creatures;
    const carn = cs.filter((c) => expressTrait(c.genome.diet) > 0.5).length;
    process.stdout.write(
      `${String(world.tick).padStart(6)}  ${String(cs.length).padStart(4)}  ` +
        `${fmt(cs.length > 0 ? carn / cs.length : 0).padStart(8)}  ` +
        `${fmt(trait(cs, "diet")).padStart(8)}  ${fmt(trait(cs, "aggression"), 2).padStart(8)}  ` +
        `${fmt(trait(cs, "armor"), 2).padStart(9)}  ${fmt(trait(cs, "size"), 2).padStart(8)}  ` +
        `${String(kills).padStart(5)}\n`,
    );
  };
  sample();

  for (let i = 0; i < a.ticks; i++) {
    tick(world);
    recordHistory(world);
    // `eventLog` is a bounded ring — harvest as we go rather than reading off the end.
    if (world.tick % 100 === 0) {
      for (let k = world.eventLog.length - 1; k >= 0; k--) {
        const e = world.eventLog[k] as { tick: number; event: string };
        if (e.tick <= lastCounted) break;
        if (e.event.startsWith("kill:")) kills++;
      }
      lastCounted = world.tick;
    }
    if (world.tick % a.every === 0) sample();
    if (world.creatures.length === 0) break;
  }
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `# trophic structure — seeds=${a.seeds.join(",")} ticks=${a.ticks}\n` +
      `# founders are seeded ~17% carnivore (diet 0.9). carnFrac decaying to 0 =>\n` +
      `# selection deletes the niche (economics); carnFrac holding ~0.17 with 0 kills\n` +
      `# => predators exist but cannot connect (mechanics).\n`,
  );
  for (const s of a.seeds) run(s, a);
}

main();
