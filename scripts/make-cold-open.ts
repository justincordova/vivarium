/**
 * make-cold-open.ts — generate the pre-evolved cold-open snapshot (Phase 5B.2).
 *
 * SPEC.md §Player Experience: the first eight seconds must show emergence, not
 * potential. On a brand-new visit (no saved world) the app loads a pre-evolved world
 * where predators already hunt and lineages have diversified — not a cold founder start.
 * This runs a good seed headless to ~gen-N under the patchbay brain, serializes it, and
 * writes a gzipped `.viv.gz` asset the app fetches on first load.
 *
 * Deterministic: same seed + ticks ⇒ byte-identical snapshot, so regenerating is safe.
 * Lives OUTSIDE `sim/`; imports only `src/sim/`.
 *
 * Usage:
 *   tsx scripts/make-cold-open.ts --seed 1 --ticks 20000 --out public/cold-open.viv.gz
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeConfig } from "../src/sim/config";
import { recordHistory } from "../src/sim/history";
import { serialize } from "../src/sim/serialize";
import { tick } from "../src/sim/tick";
import { createWorld } from "../src/sim/world";

interface Args {
  seed: number;
  ticks: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seed: 1, ticks: 20000, out: "public/cold-open.viv.gz" };
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
    else if (a === "--out") args.out = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function main(): Promise<void> {
  const { seed, ticks, out } = parseArgs(process.argv.slice(2));
  process.stdout.write(`# cold-open: seed=${seed} ticks=${ticks} brain=patchbay\n`);

  const world = createWorld(seed, makeConfig({ brainKind: "patchbay" }));
  recordHistory(world);
  for (let i = 0; i < ticks; i++) {
    tick(world);
    recordHistory(world);
    if ((i + 1) % 5000 === 0) {
      process.stdout.write(`  tick=${world.tick} pop=${world.creatures.length}\n`);
    }
  }

  if (world.creatures.length === 0) {
    throw new Error(`cold-open world went extinct by tick ${world.tick} — pick another seed`);
  }

  const blob = serialize(world);
  const bytes = await gzip(JSON.stringify(blob));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  process.stdout.write(
    `# wrote ${out} — tick=${world.tick} pop=${world.creatures.length} ` +
      `lineageEvents=${world.lineageEvents.length} bytes=${bytes.length}\n`,
  );
}

void main();
