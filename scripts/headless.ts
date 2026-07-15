/**
 * headless.ts — terminal runner for the pure `sim/` core (Phase 0 counts + Phase 1 CSV).
 *
 * SPEC.md Phase 0 row: "Population counts printed to terminal." SPEC.md Phase 1 row:
 * "run N ticks in Node, dump CSV" — the sweep and manual inspection both read this
 * CSV. Also the strongest purity gate (Layer 3): this runs `sim/` under plain Node
 * with no bundler and no DOM — if any `sim/` module imported React/`window`/`document`
 * it crashes here (SPEC.md §"The `sim/` purity rule"). Fix `sim/`, never weaken it.
 *
 * Usage:
 *   tsx scripts/headless.ts --seed 42 --ticks 1000 --print-every 100
 *   tsx scripts/headless.ts --seed 42 --ticks 10000 --csv /tmp/run.csv --sample-every 100
 *   tsx scripts/headless.ts --config ./my-config.json --ticks 100000 --csv /tmp/run.csv
 *
 * Determinism: a second identical invocation produces a byte-identical CSV. Numbers
 * are formatted at a fixed precision so re-runs never differ on float rendering.
 *
 * Lives OUTSIDE `sim/`; imports only from `src/sim/`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ConfigOverrides } from "../src/sim/config";
import { makeConfig } from "../src/sim/config";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "../src/sim/history";
import { type HealthHistory, worldHealth } from "../src/sim/stats";
import { tick } from "../src/sim/tick";
import type { World } from "../src/sim/types";
import { createWorld } from "../src/sim/world";

interface Args {
  seed: number;
  ticks: number;
  printEvery: number;
  sampleEvery: number;
  csv: string | null;
  config: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: 42,
    ticks: 1000,
    printEvery: 100,
    sampleEvery: 100,
    csv: null,
    config: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      i++;
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--seed") args.seed = Number(next());
    else if (a === "--ticks") args.ticks = Number(next());
    else if (a === "--print-every") args.printEvery = Number(next());
    else if (a === "--sample-every") args.sampleEvery = Number(next());
    else if (a === "--csv") args.csv = next();
    else if (a === "--config") args.config = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.seed)) throw new Error("--seed must be a number");
  if (!Number.isInteger(args.ticks) || args.ticks < 0) {
    throw new Error("--ticks must be a non-negative integer");
  }
  if (!Number.isInteger(args.sampleEvery) || args.sampleEvery < 1) {
    throw new Error("--sample-every must be a positive integer");
  }
  return args;
}

/** Load `ConfigOverrides` from a JSON file, or `{}` for the default config. */
function loadOverrides(path: string | null): ConfigOverrides {
  if (path === null) return {};
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ConfigOverrides;
}

/** Fixed-precision number formatting so re-runs are byte-identical. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  // Integers render plainly; non-integers at 6 decimals then trailing-zero-trimmed.
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

const CSV_COLUMNS = [
  "tick",
  "population",
  "plantCount",
  "corpseCount",
  "survivalTicks",
  "meanPopulation",
  "populationVariance",
  "traitVariance",
  "speciesCount",
  "maxDiameter",
  "extinctionEvents",
  "behaviorNovelty",
] as const;

function csvRow(world: World): string {
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  const h = worldHealth(world, history);
  const values: number[] = [
    world.tick,
    world.creatures.length,
    world.plants.length,
    world.corpses.length,
    h.survivalTicks,
    h.meanPopulation,
    h.populationVariance,
    h.traitVariance,
    h.speciesCount,
    h.maxDiameter,
    h.extinctionEvents,
    h.behaviorNovelty,
  ];
  return values.map(fmt).join(",");
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
  const { seed, ticks, printEvery, sampleEvery, csv, config } = parseArgs(process.argv.slice(2));
  process.stdout.write(`# vivarium headless — seed=${seed} ticks=${ticks}\n`);

  const world = createWorld(seed, makeConfig(loadOverrides(config)));

  const csvLines: string[] = [];
  if (csv !== null) csvLines.push(CSV_COLUMNS.join(","));

  // Sample at tick 0 so the series has a baseline; history feeds the window metrics.
  recordHistory(world);
  if (csv !== null) csvLines.push(csvRow(world));
  printRow(world);

  for (let i = 0; i < ticks; i++) {
    tick(world);
    recordHistory(world);
    const doneTicks = i + 1;
    if (csv !== null && doneTicks % sampleEvery === 0) csvLines.push(csvRow(world));
    if (doneTicks % printEvery === 0) printRow(world);
  }
  if (ticks % printEvery !== 0) printRow(world);

  if (csv !== null) {
    writeFileSync(csv, `${csvLines.join("\n")}\n`, "utf8");
    process.stdout.write(`# wrote ${csvLines.length - 1} sample rows to ${csv}\n`);
  }
}

main();
