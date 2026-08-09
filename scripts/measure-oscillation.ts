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
 *   tsx scripts/measure-oscillation.ts --mode sweep --candidate s200
 *
 * ## Sweep mode (`--mode sweep`)
 *
 * Baseline mode answered "does the shipped world oscillate" (no — see
 * `docs/findings/world-scale-oscillation.md`). Sweep mode picks the rebalance, by running
 * candidate worlds through the same instrument instead of arguing about them.
 *
 * The lever is **encounter density** — expected neighbours inside a creature's sense
 * radius, `(cap / area) × π r²`. The shipped world sits at 0.24 against legacy's 5.89,
 * which is why nothing meets anything. Two ways to raise it: shrink the area, or raise the
 * cap.
 *
 * Shrinking is nearly free, for a non-obvious reason: `generateTerrain` samples its noise
 * in **normalized UV** (`col/(cols-1)`) on a fixed lattice, so the biome map depends only
 * on `gridCols/gridRows` — *not* on `worldWidth/worldHeight`. Holding the grid at 128×128
 * and shrinking world units therefore yields a **bit-identical biome map** with regions
 * that are physically smaller relative to sense radius and speed. Phase 6's terrain
 * structure is fully preserved; only the distance between things changes. Raising the cap,
 * by contrast, costs per-tick time roughly in proportion to population and forces
 * `MAX_OFFLINE_TICKS` to be re-derived again.
 *
 * Candidates hold `gridCols/gridRows` (terrain structure) and `initialSolarReservoir`
 * (total food, which is per-cell) constant, so density is the only variable. Matched-ish
 * densities at different world sizes are included deliberately: if outcome tracks density
 * and ignores absolute size, density is the whole story.
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
  mode: "baseline" | "sweep";
  /** Sweep mode only: run a single named candidate (so candidates can run in parallel). */
  candidate: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seeds: [1, 7, 11, 42, 99],
    ticks: 60_000,
    warmup: 5_000,
    sampleEvery: 20,
    mode: "baseline",
    candidate: null,
  };
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
    else if (a === "--mode") {
      const m = next();
      if (m !== "baseline" && m !== "sweep") throw new Error(`--mode must be baseline|sweep`);
      args.mode = m;
    } else if (a === "--candidate") args.candidate = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (args.seeds.some((s) => !Number.isFinite(s))) throw new Error("--seeds must be numbers");
  if (!Number.isInteger(args.ticks) || args.ticks <= 0) throw new Error("--ticks must be > 0");
  if (!Number.isInteger(args.sampleEvery) || args.sampleEvery <= 0) {
    throw new Error("--sample-every must be > 0");
  }
  // Unvalidated, `--warmup 5k` parses to NaN and `world.tick >= NaN` is never true, so the
  // series stays empty and every metric below is computed over nothing.
  if (!Number.isInteger(args.warmup) || args.warmup < 0) {
    throw new Error("--warmup must be an integer >= 0");
  }
  if (args.warmup >= args.ticks) {
    throw new Error(
      `--warmup (${args.warmup}) must be < --ticks (${args.ticks}) or nothing is sampled`,
    );
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

  const species = world.creatures.length > 0 ? speciesClusters(world).count : 0;
  // No samples means this seed measured NOTHING — the world went extinct before warmup.
  // The old `Math.max(1, series.length)` turned that into 0/1, so every metric printed as
  // a real number: "meanPop 0.000, CV 0.000, 0 cycles" beside "survived yes". That is a
  // hard, quotable "flat line" verdict for a run that never sampled, from the very
  // instrument whose job is to answer whether the world oscillates — and it is the sort of
  // number that gets copied into docs/findings. Report non-finite so `fmt` prints "—".
  if (series.length === 0) {
    return {
      seed,
      survived: world.creatures.length > 0,
      meanPop: Number.NaN,
      cv: Number.NaN,
      cycles: Number.NaN,
      minPop: Number.NaN,
      maxPop: Number.NaN,
      kills,
      births,
      extinctions,
      species,
    };
  }

  const n = series.length;
  const meanPop = series.reduce((s, p) => s + p, 0) / n;
  const variance = series.reduce((s, p) => s + (p - meanPop) ** 2, 0) / n;
  // Fold rather than spread: `Math.min(...series)` overflows the argument limit and throws
  // `RangeError: Maximum call stack size exceeded` past ~125k samples (reachable with
  // `--sample-every 1` on a long horizon). `main` has no catch, so that would kill the
  // process before `report` had printed even the first seed's row — losing hours of
  // simulation on a run whose whole point is that it takes hours.
  let minPop = Number.POSITIVE_INFINITY;
  let maxPop = Number.NEGATIVE_INFINITY;
  for (const v of series) {
    if (v < minPop) minPop = v;
    if (v > maxPop) maxPop = v;
  }
  return {
    seed,
    survived: world.creatures.length > 0,
    meanPop,
    cv: meanPop > 0 ? Math.sqrt(variance) / meanPop : 0,
    cycles: countCycles(series, meanPop),
    minPop,
    maxPop,
    kills,
    births,
    extinctions,
    species,
  };
}

function fmt(n: number, d = 3): string {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

/**
 * Print a section, streaming **one row per seed as it completes**.
 *
 * Deliberately not "collect all, then print": at ~30 ms/tick a 50k-tick seed is ~30
 * minutes, so buffering a whole section means hours with zero output and no way to tell
 * progress from a hang. Rows land as they finish, so a run that is killed early still
 * yields usable partial evidence.
 */
function report(label: string, seeds: number[], runOne: (seed: number) => Outcome): void {
  process.stdout.write(`\n## ${label}\n`);
  process.stdout.write(
    "seed  alive  meanPop     CV  cycles   min   max   kills  births  ext  spp\n",
  );
  const rows: Outcome[] = [];
  for (const seed of seeds) {
    const r = runOne(seed);
    rows.push(r);
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
  // Median over MEASURED CVs only. A seed that sampled nothing reports a non-finite CV, and
  // feeding NaN to a numeric sort gives an undefined ordering — the median would then be an
  // arbitrary element rather than the middle one.
  const measured = alive.map((r) => r.cv).filter((cv) => Number.isFinite(cv));
  const medianCv =
    measured.length > 0
      ? measured.sort((x, y) => x - y)[Math.floor(measured.length / 2)]
      : Number.NaN;
  const unmeasured = rows.length - measured.length;
  process.stdout.write(
    `  → ${alive.length}/${rows.length} alive; median CV ${fmt(medianCv ?? Number.NaN)}` +
      (unmeasured > 0 ? ` (over ${measured.length} measured; ${unmeasured} sampled nothing)` : "") +
      `; total kills ${rows.reduce((s, r) => s + r.kills, 0)}\n`,
  );
}

/** `world.ts` seeds every founder's `senseRadius` gene at 25; the density metric uses it. */
const SEEDED_SENSE_RADIUS = 25;

/**
 * Expected neighbours inside one creature's sense radius at population `cap`:
 * `(cap / area) × π r²`. Legacy 200×200 @ cap 120 = 5.89; the shipped 1000×1000 = 0.24.
 */
function encounterDensity(o: ConfigOverrides): number {
  const w = o.worldWidth ?? 1000;
  const h = o.worldHeight ?? 1000;
  const cap = o.tunables?.CREATURE_CAP ?? 120;
  return (cap / (w * h)) * Math.PI * SEEDED_SENSE_RADIUS ** 2;
}

interface Candidate {
  name: string;
  /** Why this point is on the frontier — cost, or what it isolates. */
  note: string;
  overrides: ConfigOverrides;
}

function candidate(name: string, side: number, cap: number, note: string): Candidate {
  return {
    name,
    note,
    // Grid and solar reservoir are held constant so terrain structure and total food do
    // not move; `side` and `cap` are the only variables.
    overrides: {
      worldWidth: side,
      worldHeight: side,
      gridCols: 128,
      gridRows: 128,
      brainKind: "patchbay",
      tunables: { CREATURE_CAP: cap },
    },
  };
}

/**
 * The candidate frontier. Cap 120 costs what we already pay; raising it scales per-tick
 * cost with population and re-opens the `MAX_OFFLINE_TICKS` budget, so the cheap
 * shrink-only points come first and the paid ones must clearly beat them to be worth it.
 */
const CANDIDATES: Candidate[] = [
  candidate("s200", 200, 120, "legacy density, Phase 6 terrain — free"),
  candidate("s300", 300, 120, "mild shrink — free"),
  candidate("s400", 400, 120, "gentle shrink — free"),
  candidate("s500", 500, 120, "sparser than s400 — free; is the optimum past 400?"),
  candidate("s400c300", 400, 300, "bigger world, paid: ~2.5x pop cost"),
  candidate("s600c400", 600, 400, "biggest world, paid: ~3.3x pop cost"),
];

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  process.stdout.write(
    `# oscillation measurement — seeds=${a.seeds.join(",")} ticks=${a.ticks} ` +
      `warmup=${a.warmup} sampleEvery=${a.sampleEvery}\n` +
      `# gate.test.ts calls CV > 0.02 "not a flat line"; the hand-validated Phase 1\n` +
      `# world recorded CV ~= 0.6 over 100k ticks.\n`,
  );

  if (a.mode === "sweep") {
    const chosen = a.candidate ? CANDIDATES.filter((c) => c.name === a.candidate) : CANDIDATES;
    if (chosen.length === 0) {
      throw new Error(
        `unknown candidate: ${a.candidate} (have ${CANDIDATES.map((c) => c.name).join(", ")})`,
      );
    }
    process.stdout.write(
      `# SWEEP — verdict is cycles + survival + species. NOT CV: the highest CV measured\n` +
        `# so far (0.599) was a dying monoculture, because collapse maximises variance.\n`,
    );
    for (const c of chosen) {
      const side = c.overrides.worldWidth;
      const cap = c.overrides.tunables?.CREATURE_CAP;
      report(
        `${c.name} — ${side}x${side}, cap ${cap}, density ` +
          `${fmt(encounterDensity(c.overrides), 2)} (${c.note})`,
        a.seeds,
        (s) => run(s, c.overrides, a),
      );
    }
    return;
  }

  // The shipped world: whatever `makeConfig({})` currently is.
  report("SHIPPED default (1000x1000, patchbay)", a.seeds, (s) => run(s, {}, a));

  // The reference the oscillation gate was actually calibrated on. Included so the
  // shipped number is read against something rather than in a vacuum.
  const legacy = { worldWidth: 200, worldHeight: 200, gridCols: 64, gridRows: 64 } as const;
  report("LEGACY reference (200x200, rule) — what gate.test.ts measures", a.seeds, (s) =>
    run(s, { ...legacy, brainKind: "rule" }, a),
  );

  // Isolates the two changes: is any gap the world size, or the brain?
  report("CONTROL (200x200, patchbay) — isolates world size from brain", a.seeds, (s) =>
    run(s, { ...legacy, brainKind: "patchbay" }, a),
  );
}

main();
