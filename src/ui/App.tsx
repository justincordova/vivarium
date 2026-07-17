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

/**
 * The offline catch-up overlay (Phase 5A). A full-screen grayscale scrim shown only
 * while the worker replays owed ticks on reopen — the world underneath is hidden until
 * it has caught up, so the reveal is of the *current* world, not a stale one. Chrome
 * only: no saturated color (the world is the sole saturated element on screen).
 */
function CatchupOverlay(): React.ReactElement | null {
  const catchup = useSimStore((s) => s.catchup);
  if (catchup === null) return null;
  const pct = catchup.total > 0 ? Math.min(1, catchup.done / catchup.total) : 0;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#08080a]/95 backdrop-blur-sm">
      <div className="w-72 px-2">
        <div className="mb-3 text-[10px] uppercase tracking-widest text-neutral-500">
          while you were away
        </div>
        <div className="tabular mb-3 text-sm text-neutral-300">
          catching up · generation {fmt(catchup.done)}
        </div>
        {/* Thin grayscale progress rail — the moving number is the real feedback. */}
        <div className="h-px w-full bg-neutral-800">
          <div
            className="h-px bg-neutral-400 transition-[width] duration-150 ease-out"
            style={{ width: `${(pct * 100).toFixed(1)}%` }}
          />
        </div>
        <div className="tabular mt-2 text-right text-[10px] tracking-wider text-neutral-600">
          {fmt(catchup.done)} / {fmt(catchup.total)}
        </div>
      </div>
    </div>
  );
}

/** A subtle, auto-dismissing indicator that an autosave failed (non-fatal). */
function PersistErrorBadge(): React.ReactElement | null {
  const persistError = useSimStore((s) => s.persistError);
  if (persistError === null) return null;
  return (
    <div className="pointer-events-none absolute right-4 top-4 rounded border border-neutral-800 bg-neutral-950/85 px-2 py-1 text-[10px] uppercase tracking-widest text-neutral-500">
      autosave failed
    </div>
  );
}

export function App(): React.ReactElement {
  const seed = useSimStore((s) => s.seed);
  // Boot the worker once. Auto-play is driven by the worker's `ready` event (after any
  // offline catch-up), NOT here — so the catch-up overlay shows first when ticks are owed.
  useEffect(() => {
    startWorker();
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
      <PersistErrorBadge />
      <div className="tabular pointer-events-none absolute bottom-4 right-4 text-[10px] uppercase tracking-widest text-neutral-600">
        vivarium · seed {seed}
      </div>
      <CatchupOverlay />
    </div>
  );
}
