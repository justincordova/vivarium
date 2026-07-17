/**
 * Inspector.tsx — the creature inspector (Task 3.2). Click a creature → its full
 * genome (both alleles + expressed value per gene), a brain summary (enable density),
 * vitals, and lineage id. Trait genes are live-editable: dragging a field dispatches
 * `editGenome`, and the change is visible in the world next tick (DoD: "click a
 * creature and reads its genome"; "edits genomes live").
 *
 * Grayscale chrome, monospace numbers (SPEC.md §Visual Design). Never hides
 * information — every gene is shown, both alleles.
 */

import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import type { Creature } from "@sim/types";
import { useSimStore } from "@store/useSimStore";

function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Enable density = fraction of brain arrows enabled on either homolog (dominant-OR). */
function enableDensity(c: Creature): number {
  const a = c.genome.enabledA;
  const b = c.genome.enabledB;
  let on = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] as number) | (b[i] as number)) on++;
  return a.length === 0 ? 0 : on / a.length;
}

/** One editable trait-gene row: both alleles as range sliders + the expressed mean. */
function GeneRow({
  creature,
  gene,
}: {
  creature: Creature;
  gene: TraitGene | "hue";
}): React.ReactElement {
  const editGenome = useSimStore((s) => s.editGenome);
  const [lo, hi] = gene === "hue" ? [0, 360] : TRAIT_RANGE[gene as TraitGene];
  const allele = creature.genome[gene] as [number, number];
  const expressed = (allele[0] + allele[1]) / 2;
  const step = (hi - lo) / 200;

  const edit = (idx: 0 | 1, value: number): void => {
    editGenome(creature.id, { kind: "trait", gene, allele: idx, value });
  };

  return (
    <div className="grid grid-cols-[4.5rem_1fr_2.6rem] items-center gap-2 py-0.5">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{gene}</span>
      <div className="flex gap-1">
        {[0, 1].map((i) => (
          <input
            key={i}
            type="range"
            min={lo}
            max={hi}
            step={step}
            value={allele[i as 0 | 1]}
            onChange={(e) => edit(i as 0 | 1, Number(e.target.value))}
            className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-700 accent-neutral-300"
            aria-label={`${gene} allele ${i}`}
          />
        ))}
      </div>
      <span className="tabular text-right text-[11px] text-neutral-300">{num(expressed)}</span>
    </div>
  );
}

export function Inspector(): React.ReactElement | null {
  const inspected = useSimStore((s) => s.inspected);
  const clear = useSimStore((s) => s.clearInspected);
  const followId = useSimStore((s) => s.followId);
  const setFollow = useSimStore((s) => s.setFollow);
  const remove = useSimStore((s) => s.remove);
  if (inspected === null) return null;

  const following = followId === inspected.id;

  return (
    <div className="absolute right-4 top-4 max-h-[62vh] w-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950/90 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="tabular text-[11px] font-medium uppercase tracking-widest text-neutral-300">
          creature #{inspected.id}
        </span>
        <button
          type="button"
          onClick={clear}
          className="text-neutral-500 hover:text-neutral-200"
          aria-label="close inspector"
        >
          ✕
        </button>
      </div>

      {/* vitals */}
      <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
        <Vital label="age" value={num(inspected.age, 0)} />
        <Vital label="energy" value={num(inspected.energy, 0)} />
        <Vital label="hydration" value={num(inspected.hydration, 0)} />
        <Vital label="health" value={num(inspected.health, 0)} />
        <Vital label="lineage" value={`#${inspected.parentId ?? inspected.id}`} />
        <Vital label="brain on" value={`${num(enableDensity(inspected) * 100, 0)}%`} />
      </div>

      <div className="mb-1 flex gap-1">
        <button
          type="button"
          onClick={() => setFollow(following ? null : inspected.id)}
          className={`flex-1 rounded px-2 py-1 text-[11px] ${
            following
              ? "bg-neutral-200 text-neutral-950"
              : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
          }`}
        >
          {following ? "following" : "follow"}
        </button>
        <button
          type="button"
          onClick={() => {
            remove(inspected.id);
            clear();
          }}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-red-900/60 hover:text-red-200"
        >
          delete
        </button>
      </div>

      {/* genome — both alleles per gene, live-editable */}
      <div className="mt-2 border-t border-neutral-800 pt-2">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
          genome · allele a / b → expressed
        </div>
        {(TRAIT_GENES as readonly TraitGene[]).map((g) => (
          <GeneRow key={g} creature={inspected} gene={g} />
        ))}
        <GeneRow creature={inspected} gene="hue" />
      </div>
    </div>
  );
}

function Vital({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="tabular text-xs text-neutral-200">{value}</span>
    </div>
  );
}
