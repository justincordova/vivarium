/**
 * ControlPanel.tsx — pause/step/speed/seed + the live parameter sliders (Task 3.3).
 *
 * The mutation-rate slider is the headline (DoD: "adjusts the mutation rate"): it
 * scales the single global multiplier `MUT_GLOBAL` across every per-locus rate
 * (SPEC.md §Mutation — one knob, uniform pressure). Additional sliders expose other
 * *(tunable)* constants live. Every slider dispatches `setParam`, which writes
 * `world.config.tunables` (the sim reads tunables there, never from constants.ts).
 *
 * Soft-organic chrome (docs/designs/soft-organic-ui.md): rounded tactile `.ctl` buttons,
 * `.field` inputs, `.slider` ranges. Changing a slider detaches the world from its
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
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)]">
          {def.label}
        </span>
        <span className="tabular text-[11px] text-[var(--fg-dim)]">{fmt(value, def.digits)}</span>
      </div>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => setParam(def.key, Number(e.target.value))}
        className="slider w-full"
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
    const flash = (): void => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    // `navigator.clipboard` is undefined on non-secure origins (and can reject on
    // permission denial) — fall back to a prompt so the URL is always obtainable.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(flash, () => window.prompt("Copy this link:", url));
    } else {
      window.prompt("Copy this link:", url);
    }
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
    <div className="panel w-52 shrink-0 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-[var(--fg-dim)]">
          controls
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)] hover:text-[var(--fg)]"
        >
          {open ? "hide" : "show"}
        </button>
      </div>

      <div className="flex gap-1.5">
        <button type="button" onClick={toggle} className="ctl tabular flex-1 px-2 py-1.5 text-sm">
          {running ? "pause" : "play"}
        </button>
        <button
          type="button"
          onClick={() => doStep(1)}
          className="ctl tabular px-2 py-1.5 text-sm"
          title="step 1 tick"
        >
          +1
        </button>
        <button
          type="button"
          onClick={() => doStep(100)}
          className="ctl tabular px-2 py-1.5 text-sm"
          title="step 100 ticks"
        >
          +100
        </button>
      </div>

      <div className="mt-1.5 flex gap-1.5">
        {([1, 2, 4, 8] as const).map((s) => (
          <button
            type="button"
            key={s}
            onClick={() => setSpeed(s)}
            className={`ctl tabular flex-1 px-2 py-1 text-xs ${speed === s ? "ctl-active" : ""}`}
          >
            {s}×
          </button>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5 border-t border-[rgb(var(--panel-border)/0.1)] pt-2.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)]">seed</span>
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value))}
          className="field tabular w-14 px-1.5 py-0.5 text-xs"
          aria-label="seed"
        />
        <button type="button" onClick={reinit} className="ctl flex-1 px-2 py-1 text-[11px]">
          re-init
        </button>
      </div>

      {/* Offline catch-up preference: when on, reopening replays the ticks owed while
          away; when off, the world resumes at its saved tick (time "paused"). */}
      <label className="mt-2.5 flex items-center justify-between border-t border-[rgb(var(--panel-border)/0.1)] pt-2.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--fg-mute)]">
          catch up offline
        </span>
        <input
          type="checkbox"
          checked={catchupEnabled}
          onChange={(e) => setCatchupEnabled(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-[var(--accent)]"
          aria-label="catch up offline"
        />
      </label>

      {/* Share (URL) + export/import (file) — Phase 5A.4. */}
      <div className="mt-2.5 flex gap-1.5 border-t border-[rgb(var(--panel-border)/0.1)] pt-2.5">
        <button
          type="button"
          onClick={copyShare}
          className="ctl flex-1 px-2 py-1 text-[11px]"
          title="copy a shareable link to this world's initial config"
        >
          {copied ? "copied" : "share"}
        </button>
        <button
          type="button"
          onClick={exportWorld}
          className="ctl flex-1 px-2 py-1 text-[11px]"
          title="download this evolved world as a .viv.gz file"
        >
          export
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="ctl flex-1 px-2 py-1 text-[11px]"
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
        <div className="mt-2.5 border-t border-[rgb(var(--panel-border)/0.1)] pt-1.5">
          {SLIDERS.map((d) => (
            <ParamSlider key={d.key} def={d} />
          ))}
        </div>
      )}
    </div>
  );
}
