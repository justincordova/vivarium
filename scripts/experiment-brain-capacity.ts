/**
 * experiment-brain-capacity.ts — Phase 4 Task 4.4: the two swap-decision instruments
 * that decide whether the patchbay ceiling binds (i.e. whether to ever move to NEAT).
 * Produces a MEASURED verdict, not a designed one (SPEC.md §"Why not NEAT (yet), and
 * how to measure the swap").
 *
 *   1. Enable density — track `mean(enabled)` over a long patchbay run. Climbs to
 *      0.9+ and pins → evolution wants every arrow (ceiling binds). Plateaus ~0.4 →
 *      capacity was never the constraint.
 *   2. Enlargement experiment — same seed, HIDDEN=10 vs HIDDEN=20, FRESH worlds only
 *      (a HIDDEN change reshapes genome geometry — arrow count and hidden-vector
 *      length both change — so a HIDDEN=10 save CANNOT migrate into a HIDDEN=20 build;
 *      HIDDEN is world-creation geometry, not a live knob). World-health improves
 *      meaningfully → ceiling binds. Indistinguishable → NEAT buys nothing.
 *
 * No code decision is forced here — NEAT is out of beta (SPEC.md §Non-Goals) and gated
 * on this verdict. Determinism: identical invocation → byte-identical output. Lives
 * OUTSIDE `sim/`; imports only from `src/sim/` (also a purity gate).
 *
 * Usage:
 *   tsx scripts/experiment-brain-capacity.ts --seed 42 --ticks 20000
 */

import { makeConfig } from "../src/sim/config";
import { countExtinctionEvents, recentPopulationSeries, recordHistory } from "../src/sim/history";
import { type HealthHistory, meanEnabled, worldHealth } from "../src/sim/stats";
import { tick } from "../src/sim/tick";
import type { World } from "../src/sim/types";
import { createWorld } from "../src/sim/world";

interface Args {
  seed: number;
  ticks: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: 42, ticks: 20000 };
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
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.seed)) throw new Error("--seed must be a number");
  if (!Number.isInteger(args.ticks) || args.ticks < 0) {
    throw new Error("--ticks must be a non-negative integer");
  }
  return args;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

function healthOf(world: World): ReturnType<typeof worldHealth> {
  const history: HealthHistory = {
    populationSeries: recentPopulationSeries(world),
    extinctionEvents: countExtinctionEvents(world),
  };
  return worldHealth(world, history);
}

/** Run a fresh patchbay world for `ticks`, sampling enable density along the way. */
function runWithEnableTrack(
  seed: number,
  hidden: number,
  ticks: number,
  sampleEvery: number,
): { world: World; enableTrack: [number, number][] } {
  const world = createWorld(seed, makeConfig({ brainKind: "patchbay", hidden }));
  const enableTrack: [number, number][] = [[0, meanEnabled(world.creatures)]];
  recordHistory(world);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    recordHistory(world);
    if ((i + 1) % sampleEvery === 0) {
      enableTrack.push([world.tick, meanEnabled(world.creatures)]);
    }
  }
  return { world, enableTrack };
}

function main(): void {
  const { seed, ticks } = parseArgs(process.argv.slice(2));
  const sampleEvery = Math.max(1, Math.floor(ticks / 20));
  process.stdout.write(`# vivarium brain-capacity experiment — seed=${seed} ticks=${ticks}\n`);

  // ── Instrument 1: enable density over a long patchbay run (HIDDEN=10) ──
  process.stdout.write("# --- enable-density track (HIDDEN=10) ---\n");
  const base = runWithEnableTrack(seed, 10, ticks, sampleEvery);
  for (const [t, m] of base.enableTrack) {
    process.stdout.write(`enable  tick=${t}  meanEnabled=${fmt(m)}\n`);
  }
  const finalEnable = base.enableTrack[base.enableTrack.length - 1]?.[1] ?? 0;
  const enableVerdict =
    finalEnable >= 0.9
      ? "CEILING BINDS (mean(enabled) climbed to 0.9+ and pins — evolution wants every arrow)"
      : finalEnable <= 0.5
        ? "CAPACITY NOT THE CONSTRAINT (mean(enabled) plateaus below ~0.5 — arrows unused)"
        : "INCONCLUSIVE (mean(enabled) between 0.5 and 0.9 — run longer or more seeds)";
  process.stdout.write(`# enable-density verdict: ${enableVerdict}\n`);

  // ── Instrument 2: enlargement experiment (HIDDEN=10 vs 20, fresh worlds) ──
  process.stdout.write("# --- enlargement experiment (HIDDEN=10 vs HIDDEN=20, fresh) ---\n");
  // The HIDDEN=10 run above is reused as the baseline; run a fresh HIDDEN=20 world on
  // the SAME seed (fresh createWorld — a HIDDEN change cannot migrate a snapshot).
  const big = runWithEnableTrack(seed, 20, ticks, sampleEvery);
  const h10 = healthOf(base.world);
  const h20 = healthOf(big.world);
  const line = (label: string, h: ReturnType<typeof worldHealth>, pop: number): void => {
    process.stdout.write(
      `${label}  survived=${pop > 0}  pop=${pop}  meanPop=${fmt(h.meanPopulation)}  popVar=${fmt(h.populationVariance)}  traitVar=${fmt(h.traitVariance)}  species=${h.speciesCount}  novelty=${fmt(h.behaviorNovelty)}\n`,
    );
  };
  line("HIDDEN=10", h10, base.world.creatures.length);
  line("HIDDEN=20", h20, big.world.creatures.length);

  // A coarse world-health proxy for the enlargement verdict: reward oscillation +
  // diversity (the Phase-1 health intuition). This is a readout, not a code gate.
  const proxy = (h: ReturnType<typeof worldHealth>): number =>
    h.populationVariance + 200 * h.traitVariance + 2 * h.speciesCount + 50 * h.behaviorNovelty;
  const p10 = proxy(h10);
  const p20 = proxy(h20);
  const rel = p10 > 0 ? (p20 - p10) / p10 : 0;
  const enlargeVerdict =
    Math.abs(rel) < 0.1
      ? `INDISTINGUISHABLE (health proxy Δ=${fmt(rel * 100)}% — NEAT buys nothing)`
      : rel > 0
        ? `CEILING BINDS (HIDDEN=20 improves health proxy by ${fmt(rel * 100)}%)`
        : `HIDDEN=20 WORSE (${fmt(rel * 100)}% — more capacity did not help; ceiling does not bind)`;
  process.stdout.write(`# enlargement proxy: HIDDEN=10=${fmt(p10)}  HIDDEN=20=${fmt(p20)}\n`);
  process.stdout.write(`# enlargement verdict: ${enlargeVerdict}\n`);

  // ── Combined verdict ──
  const keepPatchbay = finalEnable < 0.9 && rel < 0.1;
  process.stdout.write(
    `# COMBINED VERDICT: ${keepPatchbay ? "KEEP PATCHBAY (neither instrument says the ceiling binds)" : "CONSIDER NEAT (an instrument indicates the ceiling binds — see above)"}\n`,
  );
}

main();
