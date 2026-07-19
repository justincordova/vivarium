/**
 * sweep.ts — the Phase 1 parameter sweep driver (Task 1.5).
 *
 * SPEC.md method: random-sample a few hundred configs → run each headless for 100k
 * ticks → collect final `WorldHealth` → rank → write a ranked CSV. This is how the
 * Phase 1 gate (a config that oscillates and diversifies for 100k ticks) is met.
 *
 * Parallelized across `worker_threads` — `sim/` is pure, so running many configs
 * concurrently is safe. The same file is both driver (`isMainThread`) and worker.
 * Deterministic: each sampled config is derived from `--master-seed`, and every run
 * uses a single fixed `--run-seed` shared across all configs, so re-running with the
 * same master seed produces an identical ranking. (Ranking therefore rests on one
 * world realization per config; vary `--run-seed` to spot-check robustness.)
 *
 * Usage:
 *   tsx scripts/sweep.ts --n 200 --ticks 100000 --out /tmp/sweep.csv --master-seed 1
 *   tsx scripts/sweep.ts --n 32 --ticks 20000 --out /tmp/sweep.csv --workers 8
 *
 * Imports only from `src/sim/` (via sweep-core). Lives OUTSIDE `sim/`.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluate, type SweepResult } from "./sweep-core";

interface Args {
  n: number;
  ticks: number;
  out: string | null;
  masterSeed: number;
  runSeed: number;
  workers: number;
  /** Internal: when set, this process is a shard worker for these config indices. */
  shard: number[] | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    n: 64,
    ticks: 100_000,
    out: null,
    masterSeed: 1,
    runSeed: 1,
    workers: Math.max(1, availableParallelism() - 1),
    shard: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      i++;
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === "--n") args.n = Number(next());
    else if (a === "--ticks") args.ticks = Number(next());
    else if (a === "--out") args.out = next();
    else if (a === "--master-seed") args.masterSeed = Number(next());
    else if (a === "--run-seed") args.runSeed = Number(next());
    else if (a === "--workers") args.workers = Number(next());
    else if (a === "--shard") args.shard = next().split(",").map(Number);
    else throw new Error(`unknown argument: ${a}`);
  }
  // Validate driver args (the internal `--shard` branch is trusted). Bad numeric input
  // otherwise silently voids a long sweep: `--n 200x` → NaN → zero configs sharded →
  // header-only CSV, exit 0; `--workers 0` → `i % 0` → NaN index → crash mid-run.
  if (args.shard === null) {
    if (!Number.isInteger(args.n) || args.n < 1) throw new Error("--n must be a positive integer");
    if (!Number.isInteger(args.ticks) || args.ticks < 1) {
      throw new Error("--ticks must be a positive integer");
    }
    if (!Number.isFinite(args.masterSeed)) throw new Error("--master-seed must be a number");
    if (!Number.isFinite(args.runSeed)) throw new Error("--run-seed must be a number");
    if (!Number.isInteger(args.workers) || args.workers < 1) {
      throw new Error("--workers must be a positive integer");
    }
  }
  return args;
}

const CSV_COLUMNS = [
  "rank",
  "index",
  "score",
  "survivalTicks",
  "meanPopulation",
  "populationVariance",
  "traitVariance",
  "speciesCount",
  "maxDiameter",
  "extinctionEvents",
  "behaviorNovelty",
  "overrides",
] as const;

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(6).replace(/\.?0+$/, "");
}

function resultRow(rank: number, r: SweepResult): string {
  const h = r.health;
  const cells = [
    String(rank),
    String(r.index),
    fmt(r.score),
    fmt(h.survivalTicks),
    fmt(h.meanPopulation),
    fmt(h.populationVariance),
    fmt(h.traitVariance),
    fmt(h.speciesCount),
    fmt(h.maxDiameter),
    fmt(h.extinctionEvents),
    fmt(h.behaviorNovelty),
    // JSON-encode overrides into one quoted CSV cell (escape embedded quotes).
    `"${JSON.stringify(r.overrides).replace(/"/g, '""')}"`,
  ];
  return cells.join(",");
}

// ── Shard branch: evaluate the assigned indices, print one JSON line to stdout ──
//
// Parallelism is via child processes (the plan permits "worker threads OR child
// processes"). Child processes are used deliberately: a `tsx`-spawned child runs
// `.ts` natively, sidestepping the worker_threads ESM-loader gap that makes a `.ts`
// worker entry fail with ERR_UNKNOWN_FILE_EXTENSION. `sim/` is pure, so independent
// child runs are safe and deterministic.

function runShard(shard: number[], args: Args): void {
  const results: SweepResult[] = [];
  for (let k = 0; k < shard.length; k++) {
    results.push(evaluate(args.masterSeed, shard[k] as number, args.runSeed, args.ticks));
  }
  // A single line: a sentinel prefix so the parent can distinguish it from any
  // incidental stdout, then the JSON payload.
  process.stdout.write(`__SWEEP_RESULT__${JSON.stringify(results)}\n`);
}

// ── Main branch: shard indices across child processes, gather, rank, write CSV ──

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function spawnShard(shard: number[], args: Args): Promise<SweepResult[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        SCRIPT_PATH,
        "--shard",
        shard.join(","),
        "--master-seed",
        String(args.masterSeed),
        "--run-seed",
        String(args.runSeed),
        "--ticks",
        String(args.ticks),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`shard process exited with code ${code}`));
        return;
      }
      const marker = buf.lastIndexOf("__SWEEP_RESULT__");
      if (marker === -1) {
        reject(new Error("shard produced no result payload"));
        return;
      }
      const jsonStart = marker + "__SWEEP_RESULT__".length;
      const newline = buf.indexOf("\n", jsonStart);
      const json = buf.slice(jsonStart, newline === -1 ? undefined : newline);
      try {
        resolve(JSON.parse(json) as SweepResult[]);
      } catch {
        reject(new Error(`shard produced unparseable payload: ${json.slice(0, 200)}`));
      }
    });
  });
}

async function main(args: Args): Promise<void> {
  const { n, ticks, out, masterSeed, workers } = args;
  process.stdout.write(
    `# vivarium sweep — n=${n} ticks=${ticks} master-seed=${masterSeed} workers=${workers}\n`,
  );
  const start = Date.now();

  // Shard config indices round-robin across workers for even load.
  const shards: number[][] = Array.from({ length: workers }, () => []);
  for (let i = 0; i < n; i++) (shards[i % workers] as number[]).push(i);

  const batches = await Promise.all(
    shards.filter((s) => s.length > 0).map((indices) => spawnShard(indices, args)),
  );

  const results: SweepResult[] = [];
  for (const b of batches) for (const r of b) results.push(r);

  if (results.length === 0) {
    process.stderr.write("# sweep produced no results (check --n / --workers)\n");
    process.exit(1);
  }

  // Deterministic ranking: sort by score desc, ties broken by ascending index.
  results.sort((a, b) => b.score - a.score || a.index - b.index);

  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (let i = 0; i < results.length; i++) lines.push(resultRow(i, results[i] as SweepResult));
  const csv = `${lines.join("\n")}\n`;

  if (out !== null) {
    writeFileSync(out, csv, "utf8");
    process.stdout.write(`# wrote ${results.length} ranked rows to ${out}\n`);
  } else {
    process.stdout.write(csv);
  }

  const best = results[0];
  if (best !== undefined) {
    process.stdout.write(
      `# best: index=${best.index} score=${fmt(best.score)} ` +
        `pop=${fmt(best.health.meanPopulation)} popVar=${fmt(best.health.populationVariance)} ` +
        `species=${best.health.speciesCount} novelty=${fmt(best.health.behaviorNovelty)}\n`,
    );
  }
  process.stdout.write(`# elapsed ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
}

// Entry dispatch: a shard child evaluates its indices; otherwise run the sweep.
const cliArgs = parseArgs(process.argv.slice(2));
if (cliArgs.shard !== null) {
  runShard(cliArgs.shard, cliArgs);
} else {
  main(cliArgs).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
