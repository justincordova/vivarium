/**
 * measure-oscillation.ts — does the SHIPPED world actually oscillate?
 *
 * SPEC.md §Goals states the beta definition-of-done as "a stranger opens a URL, sees a
 * living world with **visible predator–prey oscillation**". That claim has never been
 * measured against the current default: the Phase 1 exit gate (`tests/sim/gate.test.ts`)
 * is pinned to the legacy 200×200 **rule** world, because Phase 6 enlarged the default to
 * 1000×1000 and `docs/designs/living-world.md` explicitly deferred "default-world
 * rebalancing". So the oscillation gate has not been watching the shipped world.
 *
 * This is the instrument that answers it, and it deliberately measures the **legacy world
 * side by side** — the question is not "is this number big" but "did we lose something we
 * used to have". Reporting one number with no reference invites motivated reading.
 *
 * Metrics, per seed:
 *   - **CV** — population standard deviation / mean over the post-warmup window. The
 *     headline oscillation number; `gate.test.ts` uses a 0.02 floor for "not a flat line"
 *     and records CV ≈ 0.6 for the hand-validated Phase 1 world.
 *   - **cycles** — mean-crossings with hysteresis (see `countCycles`). CV alone cannot
 *     tell a slow drift from a real cycle; this can.
 *   - **swing** — min/max population, the thing a player actually sees.
 *   - **kills / births** — is predation even running? A world with no predation has no
 *     predator–prey coupling to oscillate.
 *   - **extinctions / species** — collapse and diversity context.
 *
 * Determinism: identical invocation → byte-identical output. Lives OUTSIDE `sim/` and
 * imports only from `src/sim/` (also a purity gate).
 *
 * Usage:
 *   tsx scripts/measure-oscillation.ts --seeds 1,7,11,42,99 --ticks 60000
 */

import type { ConfigOverrides } from "../src/sim/config";
import { makeConfig } from "../src/sim/config";
import { recordHistory } from "../src/sim/history";
import { speciesClusters } from "../src/sim/stats";
import { tick } from "../src/sim/tick";
import { createWorld } from "../src/sim/world";

interface Args {
  seeds: number[];
  ticks: number;
  warmup: number;
  sampleEvery: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seeds: [1, 7, 11, 42, 99], ticks: 60_000, warmup: 5_000, sampleEvery: 20 };
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
    else if (a === "--warmup") args.warmup = Number(next());
    else if (a === "--sample-every") args.sampleEvery = Number(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.seeds.some((s) => !Number.isFinite(s))) throw new Error("--seeds must be numbers");
  if (!Number.isInteger(args.ticks) || args.ticks <= 0) throw new Error("--ticks must be > 0");
  if (!Number.isInteger(args.sampleEvery) || args.sampleEvery <= 0) {
    throw new Error("--sample-every must be > 0");
  }
  return args;
}

/**
 * Count oscillation cycles as mean-crossings with a hysteresis band.
 *
 * A raw mean-crossing count is useless here: a flat line with sampling noise crosses its
 * own mean constantly and would score as violently oscillatory. Requiring the series to
 * travel `band` (a fraction of the mean) beyond the mean before the opposite crossing
 * counts filters that out, so what remains is genuine amplitude. Two crossings make one
 * cycle.
 */
function countCycles(series: number[], mean: number, band = 0.1): number {
  if (mean <= 0) return 0;
  const hi = mean * (1 + band);
  const lo = mean * (1 - band);
  let state: "hi" | "lo" | null = null;
  let crossings = 0;
  for (const v of series) {
    if (v >= hi) {
      if (state === "lo") crossings++;
      state = "hi";
    } else if (v <= lo) {
      if (state === "hi") crossings++;
      state = "lo";
    }
  }
  return crossings / 2;
}

interface Outcome {
  seed: number;
  survived: boolean;
  meanPop: number;
  cv: number;
  cycles: number;
  minPop: number;
  maxPop: number;
  kills: number;
  births: number;
  extinctions: number;
  species: number;
}

function run(seed: number, overrides: ConfigOverrides, a: Args): Outcome {
  const world = createWorld(seed, makeConfig(overrides));
  recordHistory(world);

  const series: number[] = [];
  let kills = 0;
  let births = 0;
  let extinctions = 0;
  // `eventLog` is a bounded ring, so counts must be harvested as we go rather than read
  // off the end. Sampling far more often than the ring can overflow keeps this exact.
  let lastCounted = -1;

  for (let i = 0; i < a.ticks; i++) {
    tick(world);
    recordHistory(world);
    if (world.tick % a.sampleEvery === 0) {
      for (let k = world.eventLog.length - 1; k >= 0; k--) {
        const e = world.eventLog[k] as { tick: number; event: string };
        if (e.tick <= lastCounted) break;
        if (e.event.startsWith("kill:")) kills++;
        else if (e.event.startsWith("birth:")) births++;
        else if (e.event === "extinct") extinctions++;
      }
      lastCounted = world.tick;
      if (world.tick >= a.warmup) series.push(world.creatures.length);
    }
    if (world.creatures.length === 0) break;
  }

  const n = Math.max(1, series.length);
  const meanPop = series.reduce((s, p) => s + p, 0) / n;
  const variance = series.reduce((s, p) => s + (p - meanPop) ** 2, 0) / n;
  return {
    seed,
    survived: world.creatures.length > 0,
    meanPop,
    cv: meanPop > 0 ? Math.sqrt(variance) / meanPop : 0,
    cycles: countCycles(series, meanPop),
    minPop: series.length > 0 ? Math.min(...series) : 0,
    maxPop: series.length > 0 ? Math.max(...series) : 0,
    kills,
    births,
    extinctions,
    species: world.creatures.length > 0 ? speciesClusters(world).count : 0,
  };
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

function report(label: string, rows: Outcome[]): void {
  process.stdout.write(`\n## ${label}\n`);
  process.stdout.write(
    "seed  alive  meanPop     CV  cycles   min   max   kills  births  ext  spp\n",
  );
  for (const r of rows) {
    process.stdout.write(
      `${String(r.seed).padStart(4)}  ${r.survived ? " yes " : " NO  "}  ` +
        `${fmt(r.meanPop, 1).padStart(7)}  ${fmt(r.cv).padStart(5)}  ` +
        `${fmt(r.cycles, 1).padStart(6)}  ${String(r.minPop).padStart(4)}  ` +
        `${String(r.maxPop).padStart(4)}  ${String(r.kills).padStart(6)}  ` +
        `${String(r.births).padStart(6)}  ${String(r.extinctions).padStart(3)}  ` +
        `${String(r.species).padStart(3)}\n`,
    );
  }
  const alive = rows.filter((r) => r.survived);
  const medianCv =
    alive.length > 0
      ? [...alive.map((r) => r.cv)].sort((x, y) => x - y)[Math.floor(alive.length / 2)]
      : 0;
  process.stdout.write(
    `  → ${alive.length}/${rows.length} alive; median CV ${fmt(medianCv ?? 0)}; ` +
      `total kills ${rows.reduce((s, r) => s + r.kills, 0)}\n`,
  );
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `# oscillation measurement — seeds=${a.seeds.join(",")} ticks=${a.ticks} ` +
      `warmup=${a.warmup} sampleEvery=${a.sampleEvery}\n` +
      `# gate.test.ts calls CV > 0.02 "not a flat line"; the hand-validated Phase 1\n` +
      `# world recorded CV ~= 0.6 over 100k ticks.\n`,
  );

  // The shipped world: whatever `makeConfig({})` currently is.
  report(
    "SHIPPED default (1000x1000, patchbay)",
    a.seeds.map((s) => run(s, {}, a)),
  );

  // The reference the oscillation gate was actually calibrated on. Included so the
  // shipped number is read against something rather than in a vacuum.
  const legacy = { worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 } as const;
  report(
    "LEGACY reference (200x200, rule) — what gate.test.ts measures",
    a.seeds.map((s) => run(s, { ...legacy, brainKind: "rule" }, a)),
  );

  // Isolates the two changes: is any gap the world size, or the brain?
  report(
    "CONTROL (200x200, patchbay) — isolates world size from brain",
    a.seeds.map((s) => run(s, { ...legacy, brainKind: "patchbay" }, a)),
  );
}

main();
