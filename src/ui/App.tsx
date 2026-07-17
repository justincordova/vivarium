/**
 * App.tsx — the Phase 2 window shell. Grayscale dark chrome; the canvas (the world)
 * is the only saturated element on screen (SPEC.md §Visual Design). All numbers are
 * monospace. Controls are intentionally minimal here (play/pause + speed); the full
 * sandbox (sliders, spawn/paint, inspector depth) is Phase 3.
 */

import { startWorker, useSimStore } from "@store/useSimStore";
import { useEffect } from "react";
import { Charts } from "./Charts";
import { ControlPanel } from "./ControlPanel";
import { Inspector } from "./Inspector";
import { SimCanvas } from "./SimCanvas";
import { Toolbar } from "./Toolbar";

function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** A labelled monospace readout used across the HUD. */
function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="tabular text-sm text-neutral-200">{value}</span>
    </div>
  );
}

function Hud(): React.ReactElement {
  const stats = useSimStore((s) => s.stats);
  const pop = stats ? Object.values(stats.population).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="pointer-events-none absolute left-4 top-4 w-52 rounded-md border border-neutral-800 bg-neutral-950/80 p-3 backdrop-blur-sm">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-400">
        world
      </div>
      <div className="space-y-1">
        <Stat label="tick" value={fmt(stats?.tick ?? 0)} />
        <Stat label="population" value={fmt(pop)} />
        <Stat label="species" value={fmt(stats?.speciesCount ?? 0)} />
        <Stat label="trait var" value={fmt(stats?.traitVariance ?? 0, 4)} />
        <Stat label="novelty" value={fmt(stats?.behaviorNovelty ?? 0, 3)} />
        <Stat label="extinctions" value={fmt(stats?.extinctionEvents ?? 0)} />
      </div>
    </div>
  );
}

function DetachedBadge(): React.ReactElement | null {
  const detached = useSimStore((s) => s.detached);
  if (!detached) return null;
  return (
    <div className="tabular pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded border border-neutral-800 bg-neutral-950/85 px-2 py-1 text-[10px] uppercase tracking-widest text-neutral-500">
      detached from seed — god-powers active
    </div>
  );
}

export function App(): React.ReactElement {
  const seed = useSimStore((s) => s.seed);
  // Boot the worker once; auto-play so a visitor sees a living world immediately.
  useEffect(() => {
    startWorker();
    useSimStore.getState().play();
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#08080a] text-neutral-200">
      <SimCanvas />
      <Hud />
      <Toolbar />
      <ControlPanel />
      <Charts />
      <Inspector />
      <DetachedBadge />
      <div className="tabular pointer-events-none absolute bottom-4 right-4 text-[10px] uppercase tracking-widest text-neutral-600">
        vivarium · seed {seed}
      </div>
    </div>
  );
}
