/**
 * compare.ts — Phase 4 Task 4.3: the headline A/B comparison. Runs the SAME seed +
 * config under both brain kinds (`rule` vs `patchbay`) headless for a long horizon and
 * dumps side-by-side world-health, ranked by the Phase-1 world-health terms. Also
 * measures the Phase-4 brain-capacity instruments (enable density, heritability) so
 * the swap is decided by measurement, not intuition (SPEC.md §"Why not NEAT").
 *
 * The heritability ratio is checked against `HERITABILITY_MAX` — a GATE, not just a
 * readout (plan Task 4.3): if a child is more than ~half as far from its parents as
 * two random creatures are from each other, behavior cannot reliably accumulate and
 * the per-locus linkage version-bump moves in-scope.
 *
 * Determinism: a second identical invocation prints byte-identical output (fixed
 * precision). Lives OUTSIDE `sim/`; imports only from `src/sim/`. Also a purity gate
 * (runs `sim/` under plain Node, no DOM/bundler).
 *
 * Usage:
 *   tsx scripts/compare.ts --seed 42 --ticks 20000
 *   tsx scripts/compare.ts --seed 42 --ticks 50000 --csv-prefix /tmp/cmp
 */

import { writeFileSync } from "node:fs";
import { makeConfig } from "../src/sim/config";
import { HERITABILITY_MAX } from "../src/sim/constants";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "../src/sim/history";
import { type HealthHistory, heritability, meanEnabled, worldHealth } from "../src/sim/stats";
import { tick } from "../src/sim/tick";
import type { BrainKind, World } from "../src/sim/types";
import { createWorld } from "../src/sim/world";

interface Args {
  seed: number;
  ticks: number;
  sampleEvery: number;
  csvPrefix: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: 42, ticks: 20000, sampleEvery: 500, csvPrefix: null };
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
    else if (a === "--sample-every") args.sampleEvery = Number(next());
    else if (a === "--csv-prefix") args.csvPrefix = next();
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

/** Fixed-precision formatting so re-runs are byte-identical. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

const CSV_COLUMNS = [
  "tick",
  "population",
  "plantCount",
  "survivalTicks",
  "meanPopulation",
  "populationVariance",
  "traitVariance",
  "speciesCount",
  "extinctionEvents",
  "behaviorNovelty",
  "meanEnabled",
  "heritabilityRatio",
] as const;

interface Summary {
  brainKind: BrainKind;
  finalTick: number;
  finalPop: number;
  meanPopulation: number;
  populationVariance: number;
  traitVariance: number;
  speciesCount: number;
  extinctionEvents: number;
  behaviorNovelty: number;
  meanEnabled: number;
  heritabilityRatio: number;
  survived: boolean;
}

function csvRow(world: World): string {
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  const h = worldHealth(world, history);
  const her = heritability(world);
  const values: number[] = [
    world.tick,
    world.creatures.length,
    world.plants.length,
    h.survivalTicks,
    h.meanPopulation,
    h.populationVariance,
    h.traitVariance,
    h.speciesCount,
    h.extinctionEvents,
    h.behaviorNovelty,
    meanEnabled(world.creatures),
    her.ratio,
  ];
  return values.map(fmt).join(",");
}

/** Run one brain kind for `ticks`, collecting CSV rows and a final summary. */
function run(
  seed: number,
  brainKind: BrainKind,
  ticks: number,
  sampleEvery: number,
): {
  csv: string[];
  summary: Summary;
} {
  const world = createWorld(seed, makeConfig({ brainKind }));
  const csv: string[] = [CSV_COLUMNS.join(",")];
  recordHistory(world);
  csv.push(csvRow(world));
  for (let i = 0; i < ticks; i++) {
    tick(world);
    recordHistory(world);
    if ((i + 1) % sampleEvery === 0) csv.push(csvRow(world));
  }
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  const h = worldHealth(world, history);
  const her = heritability(world);
  const summary: Summary = {
    brainKind,
    finalTick: world.tick,
    finalPop: world.creatures.length,
    meanPopulation: h.meanPopulation,
    populationVariance: h.populationVariance,
    traitVariance: h.traitVariance,
    speciesCount: h.speciesCount,
    extinctionEvents: h.extinctionEvents,
    behaviorNovelty: h.behaviorNovelty,
    meanEnabled: meanEnabled(world.creatures),
    heritabilityRatio: her.ratio,
    survived: world.creatures.length > 0,
  };
  return { csv, summary };
}

function printSummary(s: Summary): void {
  const line = [
    `brain=${s.brainKind}`,
    `survived=${s.survived}`,
    `pop=${s.finalPop}`,
    `meanPop=${fmt(s.meanPopulation)}`,
    `popVar=${fmt(s.populationVariance)}`,
    `traitVar=${fmt(s.traitVariance)}`,
    `species=${s.speciesCount}`,
    `extinctions=${s.extinctionEvents}`,
    `novelty=${fmt(s.behaviorNovelty)}`,
    `meanEnabled=${fmt(s.meanEnabled)}`,
    `heritability=${fmt(s.heritabilityRatio)}`,
  ].join("  ");
  process.stdout.write(`${line}\n`);
}

function main(): void {
  const { seed, ticks, sampleEvery, csvPrefix } = parseArgs(process.argv.slice(2));
  process.stdout.write(`# vivarium compare — seed=${seed} ticks=${ticks} (rule vs patchbay)\n`);

  const rule = run(seed, "rule", ticks, sampleEvery);
  const patch = run(seed, "patchbay", ticks, sampleEvery);

  process.stdout.write("# --- summary ---\n");
  printSummary(rule.summary);
  printSummary(patch.summary);

  // The heritability gate (plan Task 4.3). Report the patchbay ratio against the
  // threshold — the patchbay is the brain that actually runs the forward pass, so its
  // inheritance noise is the one that matters for "behavior accumulates".
  const ratio = patch.summary.heritabilityRatio;
  const gate =
    ratio <= HERITABILITY_MAX
      ? `PASS (patchbay heritability ${fmt(ratio)} <= ${HERITABILITY_MAX})`
      : `FAIL (patchbay heritability ${fmt(ratio)} > ${HERITABILITY_MAX} — per-locus linkage moves in-scope)`;
  process.stdout.write(`# heritability gate: ${gate}\n`);

  if (csvPrefix !== null) {
    writeFileSync(`${csvPrefix}-rule.csv`, `${rule.csv.join("\n")}\n`, "utf8");
    writeFileSync(`${csvPrefix}-patchbay.csv`, `${patch.csv.join("\n")}\n`, "utf8");
    process.stdout.write(`# wrote ${csvPrefix}-rule.csv and ${csvPrefix}-patchbay.csv\n`);
  }
}

main();
