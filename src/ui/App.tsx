/**
 * App.tsx — the Phase 2 window shell. Grayscale dark chrome; the canvas (the world)
 * is the only saturated element on screen (SPEC.md §Visual Design). All numbers are
 * monospace. Controls are intentionally minimal here (play/pause + speed); the full
 * sandbox (sliders, spawn/paint, inspector depth) is Phase 3.
 */

import { startWorker, useSimStore } from "@store/useSimStore";
import { useEffect, useState } from "react";
import { Charts } from "./Charts";
import { ControlPanel } from "./ControlPanel";
import { HelpLegend } from "./HelpLegend";
import { Inspector } from "./Inspector";
import { Landing } from "./Landing";
import { SimCanvas } from "./SimCanvas";
import { Timeline } from "./Timeline";
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
      <span className="text-[10px] uppercase tracking-wider text-[var(--fg-mute)]">{label}</span>
      <span className="tabular text-sm text-[var(--fg)]">{value}</span>
    </div>
  );
}

function Hud(): React.ReactElement {
  const stats = useSimStore((s) => s.stats);
  const pop = stats ? Object.values(stats.population).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="panel pointer-events-none w-52 p-3">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-[var(--fg-mute)]">
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
    <div className="panel tabular pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--accent-2)]">
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--bg)]/95 backdrop-blur-sm">
      <div className="w-72 px-2">
        <div className="mb-3 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
          while you were away
        </div>
        <div className="tabular mb-3 text-sm text-[var(--fg-dim)]">
          catching up · generation {fmt(catchup.done)}
        </div>
        {/* Thin progress rail (accent) — the moving number is the real feedback. */}
        <div className="h-px w-full bg-[rgb(var(--panel-border)/0.2)]">
          <div
            className="h-px bg-[var(--accent)] transition-[width] duration-150 ease-out"
            style={{ width: `${(pct * 100).toFixed(1)}%` }}
          />
        </div>
        <div className="tabular mt-2 text-right text-[10px] tracking-wider text-[var(--fg-mute)]">
          {fmt(catchup.done)} / {fmt(catchup.total)}
        </div>
      </div>
    </div>
  );
}

/**
 * The "while you were away" report (Phase 5A.3). Shown after a reopen whose offline
 * catch-up produced lineage drama. Narrated by GENERATION/TICK — never wall-clock,
 * which is invalid across a catch-up boundary. Grayscale chrome; the report is a
 * modal-ish panel the visitor dismisses to enter the (already-live) world.
 */
function WhileYouWereAwayReport(): React.ReactElement | null {
  const report = useSimStore((s) => s.report);
  const dismiss = useSimStore((s) => s.dismissReport);
  if (report === null) return null;

  // Narrate the most dramatic events (cap the list; extinctions + booms lead).
  const lines = report.events
    .slice()
    .sort((a, b) => a.tick - b.tick)
    .map((e) => {
      if (e.kind === "extinction") return `Lineage #${e.lineage} went extinct.`;
      if (e.kind === "lineageBoom") {
        return `Lineage #${e.lineage} boomed ${e.factor.toFixed(1)}×.`;
      }
      return `Lineage #${e.lineage} became dominant.`;
    });
  const shown = lines.slice(-6);
  const extraCount = lines.length - shown.length;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-[var(--bg)]/95 backdrop-blur-sm">
      <div className="panel w-80 p-5">
        <div className="mb-1 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
          while you were away
        </div>
        <div className="display mb-4 text-lg text-[var(--fg)]">
          Generation {fmt(report.nowTick)}
        </div>
        <ul className="mb-5 space-y-1.5">
          {shown.map((line, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: static narration lines, stable order
              key={i}
              className="tabular text-sm text-[var(--fg-dim)]"
            >
              {line}
            </li>
          ))}
          {extraCount > 0 && (
            <li className="text-[11px] uppercase tracking-wider text-[var(--fg-mute)]">
              + {fmt(extraCount)} more events
            </li>
          )}
        </ul>
        <button type="button" onClick={dismiss} className="btn-accent w-full px-2 py-2 text-sm">
          enter world
        </button>
      </div>
    </div>
  );
}

/**
 * Onboarding captions (Phase 5B.2) — a COLD OPEN, not a tutorial. On the first visit a
 * few unobtrusive grayscale captions fade in over the already-living pre-evolved world,
 * then fade out and get out of the way (SPEC.md §Player Experience). Shown once, gated
 * by a localStorage flag; never on a returning visit.
 */
const VISITED_KEY = "vivarium:visited";
function firstVisit(): boolean {
  try {
    if (localStorage.getItem(VISITED_KEY) === "1") return false;
    localStorage.setItem(VISITED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

function OnboardingCaptions(): React.ReactElement | null {
  const [phase, setPhase] = useState<0 | 1 | 2>(0);
  const report = useSimStore((s) => s.report);
  useEffect(() => {
    if (!firstVisit()) return;
    setPhase(1);
    const t1 = setTimeout(() => setPhase(2), 5200);
    const t2 = setTimeout(() => setPhase(0), 6600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  // The report modal owns the screen; don't overlap captions with it.
  if (phase === 0 || report !== null) return null;
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 text-center transition-opacity duration-1000 ${
        phase === 1 ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="display text-sm tracking-wide text-[var(--fg)]">
        This world has been evolving for thousands of generations.
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-widest text-[var(--fg-mute)]">
        nobody scripted what these creatures do · click one to read its genome
      </div>
    </div>
  );
}

/** A subtle, auto-dismissing indicator that an autosave failed (non-fatal). */
function PersistErrorBadge(): React.ReactElement | null {
  const persistError = useSimStore((s) => s.persistError);
  if (persistError === null) return null;
  return (
    <div className="panel pointer-events-none absolute bottom-11 left-4 px-2 py-1 text-[10px] uppercase tracking-widest text-[var(--warn)]">
      autosave failed
    </div>
  );
}

export function App(): React.ReactElement {
  const seed = useSimStore((s) => s.seed);
  const phase = useSimStore((s) => s.phase);
  // Boot the worker once. What happens next depends on entry policy: a shared-URL link
  // boots straight in; otherwise the Landing shows and the visitor picks a source.
  // Auto-play is driven by the worker's `ready` event (after any offline catch-up).
  useEffect(() => {
    startWorker();
  }, []);

  const live = phase === "live";

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
      {/* The world renders in every phase. On the landing it stays mostly visible (it is
          the hero of a game title screen); Landing itself lays a cinematic vignette over
          it for legibility rather than a flat dimming scrim. */}
      <div
        className={`absolute inset-0 transition-opacity duration-700 ${
          phase === "landing" ? "opacity-80" : "opacity-100"
        }`}
      >
        <SimCanvas />
      </div>

      {/* Live-world chrome mounts only once the world is live, so nothing floats over the
          landing or the catch-up overlay. Panels live in scrollable docks so they never
          clip or overlap regardless of viewport height. */}
      {live && (
        <>
          <Toolbar />

          {/* Left dock: world stats + controls. Scrolls if the viewport is short. */}
          <div className="pointer-events-none absolute left-4 top-4 bottom-20 flex w-52 flex-col gap-3 overflow-y-auto overflow-x-hidden pr-0.5 [&>*]:pointer-events-auto">
            <Hud />
            <ControlPanel />
          </div>

          {/* Right dock: inspector + charts. Starts below the help button (top-14). */}
          <div className="pointer-events-none absolute right-4 top-14 bottom-20 flex w-72 flex-col items-end gap-3 overflow-y-auto overflow-x-hidden pl-0.5 [&>*]:pointer-events-auto">
            <Inspector />
            <Charts />
          </div>
          <HelpLegend />

          <Timeline />
          <DetachedBadge />
          <PersistErrorBadge />
          <div className="tabular pointer-events-none absolute bottom-4 left-4 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
            vivarium · seed {seed}
          </div>
          <OnboardingCaptions />
        </>
      )}

      <Landing />
      <CatchupOverlay />
      <WhileYouWereAwayReport />
    </div>
  );
}
