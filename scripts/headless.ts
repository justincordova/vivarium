/**
 * headless.ts — minimal terminal runner for the pure `sim/` core.
 *
 * SPEC.md Phase 0 row: "Population counts printed to terminal." Also the strongest
 * purity gate (Layer 3): this runs `sim/` under plain Node with no bundler and no
 * DOM — if any `sim/` module imported React/`window`/`document`, this crashes
 * (SPEC.md §"The `sim/` purity rule"). Fix `sim/`, never weaken the runner.
 *
 * Usage: tsx scripts/headless.ts --seed 42 --ticks 1000 --print-every 100
 *
 * Lives OUTSIDE `sim/`; imports only from `src/sim/`.
 */

import { makeConfig } from "../src/sim/config";
import { tick } from "../src/sim/tick";
import type { World } from "../src/sim/types";
import { createWorld } from "../src/sim/world";

interface Args {
  seed: number;
  ticks: number;
  printEvery: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: 42, ticks: 1000, printEvery: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      i++;
      return v;
    };
    if (a === "--seed") args.seed = Number(next());
    else if (a === "--ticks") args.ticks = Number(next());
    else if (a === "--print-every") args.printEvery = Number(next());
  }
  return args;
}

function printRow(world: World): void {
  const line = [
    `tick=${world.tick}`,
    `pop=${world.creatures.length}`,
    `plants=${world.plants.length}`,
    `corpses=${world.corpses.length}`,
  ].join("  ");
  process.stdout.write(`${line}\n`);
}

function main(): void {
  const { seed, ticks, printEvery } = parseArgs(process.argv.slice(2));
  process.stdout.write(`# vivarium headless — seed=${seed} ticks=${ticks}\n`);
  const world = createWorld(seed, makeConfig({}));
  printRow(world);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    if ((i + 1) % printEvery === 0) printRow(world);
  }
  if (ticks % printEvery !== 0) printRow(world);
}

main();
