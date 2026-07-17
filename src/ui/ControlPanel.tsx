/**
 * ControlPanel.tsx — pause/step/speed/seed + the live parameter sliders (Task 3.3).
 *
 * The mutation-rate slider is the headline (DoD: "adjusts the mutation rate"): it
 * scales the single global multiplier `MUT_GLOBAL` across every per-locus rate
 * (SPEC.md §Mutation — one knob, uniform pressure). Additional sliders expose other
 * *(tunable)* constants live. Every slider dispatches `setParam`, which writes
 * `world.config.tunables` (the sim reads tunables there, never from constants.ts).
 *
 * Grayscale chrome, monospace numbers. Changing a slider detaches the world from its
 * shareable URL — surfaced by the `detached` badge in App.
 */

import { useSimStore } from "@store/useSimStore";
import { useRef, useState } from "react";
import { shareUrl } from "./share";

/** A live-editable tunable: key, label, range, default, and value formatting. */
interface SliderDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  digits: number;
}

// Curated, high-signal tunables (SPEC.md §Mutation names MUT_GLOBAL as central).
const SLIDERS: SliderDef[] = [
  { key: "MUT_GLOBAL", label: "mutation rate", min: 0, max: 8, step: 0.1, def: 1, digits: 1 },
  {
    key: "METABOLIC_COST_COEF",
    label: "metabolism",
    min: 0,
    max: 0.3,
    step: 0.005,
    def: 0.05,
    digits: 3,
  },
  { key: "PLANT_GROWTH_MAX", label: "plant growth", min: 1, max: 60, step: 1, def: 15, digits: 0 },
  {
    key: "HYDRATION_DECAY",
    label: "thirst rate",
    min: 0,
    max: 0.08,
    step: 0.001,
    def: 0.015,
    digits: 3,
  },
  {
    key: "TICKS_PER_DAY",
    label: "day length",
    min: 200,
    max: 4000,
    step: 100,
    def: 1000,
    digits: 0,
  },
  { key: "CREATURE_CAP", label: "creature cap", min: 20, max: 400, step: 10, def: 120, digits: 0 },
];

function fmt(n: number, digits: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function ParamSlider({ def }: { def: SliderDef }): React.ReactElement {
  const value = useSimStore((s) => s.params[def.key] ?? def.def);
  const setParam = useSimStore((s) => s.setParam);
  return (
    <label className="block py-1">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">{def.label}</span>
        <span className="tabular text-[11px] text-neutral-300">{fmt(value, def.digits)}</span>
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => setParam(def.key, Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded bg-neutral-700 accent-neutral-300"
        aria-label={def.label}
      />
    </label>
  );
}

export function ControlPanel(): React.ReactElement {
  const running = useSimStore((s) => s.running);
  const speed = useSimStore((s) => s.speed);
  const seed = useSimStore((s) => s.seed);
  const toggle = useSimStore((s) => s.toggle);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const stepN = useSimStore((s) => s.step);
  const pause = useSimStore((s) => s.pause);
  const setSeed = useSimStore((s) => s.setSeed);
  const reinit = useSimStore((s) => s.reinit);
  const catchupEnabled = useSimStore((s) => s.catchupEnabled);
  const setCatchupEnabled = useSimStore((s) => s.setCatchupEnabled);
  const params = useSimStore((s) => s.params);
  const exportWorld = useSimStore((s) => s.exportWorld);
  const importWorld = useSimStore((s) => s.importWorld);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const copyShare = (): void => {
    // The URL encodes the INITIAL config (seed + mutation-rate override) — a fresh
    // reproducible world, not the current evolved snapshot (that travels by export).
    const mut = params.MUT_GLOBAL;
    const url = shareUrl({ seed, tunables: mut !== undefined ? { MUT_GLOBAL: mut } : undefined });
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) void importWorld(file);
    e.target.value = ""; // allow re-importing the same file
  };

  const doStep = (n: number): void => {
    if (running) pause();
    stepN(n);
  };

  return (
    <div className="absolute left-4 top-40 w-52 rounded-md border border-neutral-800 bg-neutral-950/85 p-3 backdrop-blur-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-neutral-400">
          controls
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] text-neutral-500 hover:text-neutral-200"
        >
          {open ? "hide" : "show"}
        </button>
      </div>

      <div className="flex gap-1">
        <button
          type="button"
          onClick={toggle}
          className="tabular flex-1 rounded bg-neutral-800 px-2 py-1.5 text-sm text-neutral-200 hover:bg-neutral-700"
        >
          {running ? "pause" : "play"}
        </button>
        <button
          type="button"
          onClick={() => doStep(1)}
          className="tabular rounded bg-neutral-800 px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          title="step 1 tick"
        >
          +1
        </button>
        <button
          type="button"
          onClick={() => doStep(100)}
          className="tabular rounded bg-neutral-800 px-2 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700"
          title="step 100 ticks"
        >
          +100
        </button>
      </div>

      <div className="mt-1 flex gap-1">
        {([1, 2, 4, 8] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setSpeed(s)}
            className={`tabular flex-1 rounded px-2 py-1 text-xs ${
              speed === s
                ? "bg-neutral-200 text-neutral-950"
                : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700"
            }`}
          >
            {s}×
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1 border-t border-neutral-800 pt-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">seed</span>
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
          className="tabular w-14 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs text-neutral-200"
          aria-label="seed"
        />
        <button
          type="button"
          onClick={reinit}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
        >
          re-init
        </button>
      </div>

      {/* Offline catch-up preference: when on, reopening replays the ticks owed while
          away; when off, the world resumes at its saved tick (time "paused"). */}
      <label className="mt-2 flex items-center justify-between border-t border-neutral-800 pt-2">
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
          catch up offline
        </span>
        <input
          type="checkbox"
          checked={catchupEnabled}
          onChange={(e) => setCatchupEnabled(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-neutral-300"
          aria-label="catch up offline"
        />
      </label>

      {/* Share (URL) + export/import (file) — Phase 5A.4. */}
      <div className="mt-2 flex gap-1 border-t border-neutral-800 pt-2">
        <button
          type="button"
          onClick={copyShare}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
          title="copy a shareable link to this world's initial config"
        >
          {copied ? "copied" : "share"}
        </button>
        <button
          type="button"
          onClick={exportWorld}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
          title="download this evolved world as a .viv.gz file"
        >
          export
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex-1 rounded bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
          title="load a .viv.gz world file"
        >
          import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".gz,.viv,application/gzip"
          onChange={onImportFile}
          className="hidden"
          aria-label="import world file"
        />
      </div>

      {open && (
        <div className="mt-2 border-t border-neutral-800 pt-1">
          {SLIDERS.map((d) => (
            <ParamSlider key={d.key} def={d} />
          ))}
        </div>
      )}
    </div>
  );
}
