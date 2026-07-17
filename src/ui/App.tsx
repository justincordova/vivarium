/**
 * App.tsx — the Phase 2 window shell. Grayscale dark chrome; the canvas (the world)
 * is the only saturated element on screen (SPEC.md §Visual Design). All numbers are
 * monospace. Controls are intentionally minimal here (play/pause + speed); the full
 * sandbox (sliders, spawn/paint, inspector depth) is Phase 3.
 */

import { expressTrait } from "@sim/genetics";
import { startWorker, useSimStore } from "@store/useSimStore";
import { useEffect } from "react";
import { SimCanvas } from "./SimCanvas";

const SPEEDS = [1, 2, 4, 8] as const;

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

function Inspector(): React.ReactElement | null {
  const inspected = useSimStore((s) => s.inspected);
  const clear = useSimStore((s) => s.clearInspected);
  if (inspected === null) return null;
  const g = inspected.genome;
  return (
    <div className="absolute right-4 top-4 w-56 rounded-md border border-neutral-800 bg-neutral-950/90 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-neutral-400">
          creature #{inspected.id}
        </span>
        <button
          type="button"
          onClick={clear}
          className="text-neutral-500 transition-none hover:text-neutral-200"
          aria-label="close inspector"
        >
          ✕
        </button>
      </div>
      <div className="space-y-1">
        <Stat label="age" value={fmt(inspected.age)} />
        <Stat label="energy" value={fmt(inspected.energy)} />
        <Stat label="hydration" value={fmt(inspected.hydration)} />
        <Stat label="health" value={fmt(inspected.health)} />
        <Stat label="size" value={fmt(expressTrait(g.size), 2)} />
        <Stat label="diet" value={fmt(expressTrait(g.diet), 2)} />
        <Stat label="aggression" value={fmt(expressTrait(g.aggression), 2)} />
        <Stat label="armor" value={fmt(expressTrait(g.armor), 2)} />
        <Stat label="hue" value={`${fmt(expressTrait(g.hue))}°`} />
      </div>
    </div>
  );
}

function Controls(): React.ReactElement {
  const running = useSimStore((s) => s.running);
  const speed = useSimStore((s) => s.speed);
  const toggle = useSimStore((s) => s.toggle);
  const setSpeed = useSimStore((s) => s.setSpeed);
  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/85 p-1 backdrop-blur-sm">
      <button
        type="button"
        onClick={toggle}
        className="tabular w-16 rounded px-3 py-1.5 text-sm text-neutral-200 transition-none hover:bg-neutral-800"
      >
        {running ? "pause" : "play"}
      </button>
      <div className="mx-1 h-5 w-px bg-neutral-800" />
      {SPEEDS.map((s) => (
        <button
          type="button"
          key={s}
          onClick={() => setSpeed(s)}
          className={`tabular w-9 rounded px-2 py-1.5 text-sm transition-none ${
            speed === s
              ? "bg-neutral-200 text-neutral-950"
              : "text-neutral-400 hover:bg-neutral-800"
          }`}
        >
          {s}×
        </button>
      ))}
    </div>
  );
}

export function App(): React.ReactElement {
  // Boot the worker once; auto-play so a visitor sees a living world immediately.
  useEffect(() => {
    startWorker();
    useSimStore.getState().play();
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#08080a] text-neutral-200">
      <SimCanvas />
      <Hud />
      <Inspector />
      <Controls />
      <div className="tabular pointer-events-none absolute bottom-4 right-4 text-[10px] uppercase tracking-widest text-neutral-600">
        vivarium · seed {useSimStore.getState().seed}
      </div>
    </div>
  );
}
