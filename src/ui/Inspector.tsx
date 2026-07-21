/**
 * Inspector.tsx — the creature inspector (Task 3.2). Click a creature → its
 * genome (one expressed value per gene by default), a brain summary (enable density),
 * vitals, and lineage id. Trait genes are live-editable: dragging a field dispatches
 * `editGenome`, and the change is visible in the world next tick (DoD: "click a
 * creature and reads its genome"; "edits genomes live").
 *
 * The genome is diploid (two alleles per gene, expressed as their mean). By default the
 * inspector shows ONE slider per gene — the expressed value — and dragging it moves both
 * alleles together. A "show alleles" toggle reveals the two per-homolog sliders for users
 * who want to set heterozygous genotypes. Nothing is hidden, just tucked behind a toggle.
 *
 * CRT bio-terminal chrome (docs/designs/chrome-crt-redesign.md): a "specimen readout"
 * screen. Phosphor-green vitals; follow = green (observe), delete = danger.
 */

import { TRAIT_GENES, TRAIT_RANGE, type TraitGene } from "@sim/genetics";
import type { Creature } from "@sim/types";
import { useSimStore } from "@store/useSimStore";
import { useState } from "react";

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

/**
 * One editable trait-gene row. By default a single slider drives the EXPRESSED value
 * (dragging it sets both alleles to that value). When `showAlleles` is on, the two
 * per-homolog sliders are shown instead, so a heterozygous genotype can be set.
 */
function GeneRow({
  creature,
  gene,
  showAlleles,
}: {
  creature: Creature;
  gene: TraitGene | "hue";
  showAlleles: boolean;
}): React.ReactElement {
  const editGenome = useSimStore((s) => s.editGenome);
  // Hue wraps mod 360 in the worker, so cap the slider at 359 — a max of 360 would
  // store as 0 and make the control snap back, fighting the user.
  const [lo, hi] = gene === "hue" ? [0, 359] : TRAIT_RANGE[gene as TraitGene];
  const allele = creature.genome[gene] as [number, number];
  const expressed = (allele[0] + allele[1]) / 2;
  const step = (hi - lo) / 200;

  const edit = (idx: 0 | 1, value: number): void => {
    editGenome(creature.id, { kind: "trait", gene, allele: idx, value });
  };
  // Setting the expressed value moves both homologs to it (a homozygous edit) so the
  // single slider reads as "the value this creature expresses".
  const editExpressed = (value: number): void => {
    edit(0, value);
    edit(1, value);
  };

  return (
    <div className="py-1">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)]">{gene}</span>
        <span className="tabular text-[11px] text-[var(--fg-dim)]">{num(expressed)}</span>
      </div>
      {showAlleles ? (
        // Alleles stacked full-width — two sliders side-by-side in a 288px panel squished
        // them illegibly. Each homolog gets the whole row.
        <div className="flex flex-col gap-1">
          {[0, 1].map((i) => (
            <input
              key={i}
              type="range"
              min={lo}
              max={hi}
              step={step}
              value={allele[i as 0 | 1]}
              onChange={(e) => edit(i as 0 | 1, Number(e.target.value))}
              className="slider w-full"
              aria-label={`${gene} allele ${i}`}
            />
          ))}
        </div>
      ) : (
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={expressed}
          onChange={(e) => editExpressed(Number(e.target.value))}
          className="slider w-full"
          aria-label={`${gene} expressed value`}
        />
      )}
    </div>
  );
}

export function Inspector(): React.ReactElement | null {
  const inspected = useSimStore((s) => s.inspected);
  const clear = useSimStore((s) => s.clearInspected);
  const followId = useSimStore((s) => s.followId);
  const setFollow = useSimStore((s) => s.setFollow);
  const remove = useSimStore((s) => s.remove);
  const [showAlleles, setShowAlleles] = useState(false);
  if (inspected === null) return null;

  const following = followId === inspected.id;

  return (
    <div className="panel w-72 shrink-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="tabular crt-glow text-[11px] font-medium uppercase tracking-widest text-[var(--accent)]">
          ◈ specimen #{inspected.id}
        </span>
        <button
          type="button"
          onClick={clear}
          className="text-[var(--fg-mute)] hover:text-[var(--fg)]"
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
        <Vital
          label="parent"
          value={inspected.parentId === null ? "founder" : `#${inspected.parentId}`}
        />
        <Vital label="brain on" value={`${num(enableDensity(inspected) * 100, 0)}%`} />
      </div>

      <div className="mb-1 flex gap-1">
        <button
          type="button"
          onClick={() => setFollow(following ? null : inspected.id)}
          className={`flex-1 rounded-[var(--radius)] border px-2 py-1 text-[11px] transition-colors ${
            following
              ? "crt-glow border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-medium text-[var(--accent)]"
              : "border-[rgb(var(--panel-border)/0.18)] bg-[rgb(var(--panel-border)/0.06)] text-[var(--fg-dim)] hover:text-[var(--fg)]"
          }`}
        >
          {following ? "following" : "follow"}
        </button>
        {/* delete a creature = destructive intervention (danger). */}
        <button
          type="button"
          onClick={() => {
            remove(inspected.id);
            clear();
          }}
          className="flex-1 rounded-[var(--radius)] border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] px-2 py-1 text-[11px] text-[var(--danger)] transition-colors hover:bg-[color-mix(in_srgb,var(--danger)_25%,transparent)]"
        >
          delete
        </button>
      </div>

      {/* genome — one expressed slider per gene by default; alleles behind a toggle */}
      <div className="mt-2 border-t border-[rgb(var(--panel-border)/0.12)] pt-2">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
            genome{showAlleles ? " · two alleles per gene" : ""}
          </span>
          <button
            type="button"
            onClick={() => setShowAlleles((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)] hover:text-[var(--fg)]"
            aria-pressed={showAlleles}
          >
            {showAlleles ? "hide alleles" : "show alleles"}
          </button>
        </div>
        {(TRAIT_GENES as readonly TraitGene[]).map((g) => (
          <GeneRow key={g} creature={inspected} gene={g} showAlleles={showAlleles} />
        ))}
        <GeneRow creature={inspected} gene="hue" showAlleles={showAlleles} />
      </div>
    </div>
  );
}

function Vital({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)]">{label}</span>
      <span className="tabular text-xs text-[var(--accent)]">{value}</span>
    </div>
  );
}
