/**
 * HelpLegend.tsx — the always-available legend + controls help (UI overhaul,
 * SPEC.md §Player Experience). A newcomer's core problem is "I don't know what I'm
 * looking at"; this decodes the genome-derived visual language and lists the controls,
 * and unlike the one-shot onboarding fade it is reopenable at any time.
 *
 * Chrome only: pure presentation, reads/writes no sim state.
 */

import { useState } from "react";

/** One legend row: a small swatch/marker + what that visual encodes. */
function LegendRow({
  marker,
  label,
  meaning,
}: {
  marker: React.ReactNode;
  label: string;
  meaning: string;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2.5 py-1">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center">{marker}</div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-[var(--fg)]">{label}</div>
        <div className="text-[10px] leading-tight text-[var(--fg-mute)]">{meaning}</div>
      </div>
    </div>
  );
}

export function HelpLegend(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="panel btn-ghost absolute right-4 top-4 z-20 flex h-8 w-8 items-center justify-center text-sm font-semibold"
        title={open ? "Close legend & help" : "What am I looking at? (legend & controls)"}
        aria-label="legend and help"
        aria-expanded={open}
      >
        ?
      </button>

      {open && (
        <div className="panel absolute right-4 top-14 z-20 max-h-[80vh] w-64 overflow-y-auto p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="display text-sm text-[var(--fg)]">What you're seeing</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[var(--fg-mute)] hover:text-[var(--fg)]"
              aria-label="close"
            >
              ✕
            </button>
          </div>

          <p className="mb-3 text-[11px] leading-relaxed text-[var(--fg-dim)]">
            Every creature's look is grown from its genes — nothing is hand-designed. So the picture
            is data: read it to know who's who.
          </p>

          <div className="border-t border-[rgb(var(--panel-border)/0.12)] pt-2">
            <LegendRow
              marker={
                <span
                  className="h-3.5 w-3.5 rounded-full"
                  style={{
                    background: "conic-gradient(from 0deg, #f87171, #22d3ee, #a3e635, #f87171)",
                  }}
                />
              }
              label="Color (hue)"
              meaning="Lineage — same color, same family line."
            />
            <LegendRow
              marker={<span className="h-3.5 w-4 rounded-full bg-[var(--accent)]" />}
              label="Plump body"
              meaning="Herbivore (plant-eater). Leaner bodies are hunters."
            />
            <LegendRow
              marker={<span className="text-[var(--fg-dim)]">▲</span>}
              label="Back plates"
              meaning="Armor — dorsal plates for defense."
            />
            <LegendRow
              marker={<span className="text-[rgb(245_240_120)]">●</span>}
              label="Flank spots"
              meaning="Toxicity — bright warning markings."
            />
            <LegendRow
              marker={<span className="text-[var(--fg-dim)]">╫</span>}
              label="More legs"
              meaning="Faster creatures — longer legs and tail."
            />
            <LegendRow
              marker={<span className="h-3.5 w-3.5 rounded-full bg-[var(--fg-mute)] opacity-40" />}
              label="Washed-out"
              meaning="Starving — low on energy."
            />
            <LegendRow
              marker={<span className="h-3.5 w-3.5 rounded-full border border-[var(--fg-mute)]" />}
              label="Outline ring"
              meaning="Age — older creatures ring brighter."
            />
            <LegendRow
              marker={
                <span className="flex h-3.5 w-3.5 overflow-hidden rounded-sm">
                  <span className="h-full w-1/3 bg-[rgb(26_58_92)]" />
                  <span className="h-full w-1/3 bg-[rgb(38_58_40)]" />
                  <span className="h-full w-1/3 bg-[rgb(70_62_44)]" />
                </span>
              }
              label="The land"
              meaning="Blue water, green grass/forest, tan barren, gray rock — each grows food and slows movement differently."
            />
            <LegendRow
              marker={
                <span className="h-3.5 w-3.5 rounded-full bg-[rgb(120_96_150)] opacity-70 ring-1 ring-[rgb(150_130_180)]/40" />
              }
              label="Nests"
              meaning="Homes built by a lineage. Kin cluster around them and shelter to save energy — packs and territories emerge here."
            />
          </div>

          <div className="mt-3 border-t border-[rgb(var(--panel-border)/0.12)] pt-2">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
              controls
            </div>
            <ul className="space-y-1 text-[11px] text-[var(--fg-dim)]">
              <li>
                <span className="text-[var(--fg)]">Click</span> a creature — read & edit its genome
                (one slider per gene = its expressed value; “show alleles” reveals both inherited
                copies)
              </li>
              <li>
                <span className="text-[var(--fg)]">Drag</span> — pan the view
              </li>
              <li>
                <span className="text-[var(--fg)]">Scroll</span> or the +/− buttons — zoom
              </li>
              <li>
                <span className="text-[var(--fg)]">Tools</span> (top) — spawn, delete, or move water
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
