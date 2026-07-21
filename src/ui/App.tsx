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

/**
 * A labelled monospace readout used across the HUD. `help` is a plain-language
 * explanation surfaced on hover — the HUD numbers are otherwise unexplained jargon
 * ("trait var", "novelty") that a newcomer has no way to interpret. The label carries
 * a dotted underline to signal it is hoverable.
 */
function Stat({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help: string;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      {/* Only the label re-enables pointer events, so the tooltip is reachable while the
          rest of the HUD stays click-through to the canvas underneath. */}
      <span
        title={help}
        className="pointer-events-auto cursor-help text-[10px] uppercase tracking-wider text-[var(--fg-mute)] underline decoration-dotted decoration-[rgb(var(--panel-border)/0.35)] underline-offset-2"
      >
        {label}
      </span>
      <span className="tabular crt-glow text-sm text-[var(--accent)]">{value}</span>
    </div>
  );
}

function Hud(): React.ReactElement {
  const stats = useSimStore((s) => s.stats);
  const pop = stats ? Object.values(stats.population).reduce((a, b) => a + b, 0) : 0;
  return (
    // The panel stays click-through (canvas underneath); individual stat labels opt back
    // into pointer events so their hover tooltips are reachable.
    <div className="panel pointer-events-none w-52 p-3">
      <div className="crt-title mb-2 text-[10px] font-medium text-[var(--fg-mute)]">
        world · vital signs
      </div>
      <div className="space-y-1">
        <Stat
          label="age"
          value={fmt(stats?.tick ?? 0)}
          help="Sim time — how many ticks this world has lived (also called 'generation'). This is the world's own clock, not real-world time."
        />
        <Stat
          label="population"
          value={fmt(pop)}
          help="How many creatures are alive right now. Watch it rise and crash as predators and prey cycle."
        />
        <Stat
          label="species"
          value={fmt(stats?.speciesCount ?? 0)}
          help="Distinct breeding groups. Two groups count as separate species once they've drifted too far apart to interbreed."
        />
        <Stat
          label="trait var"
          value={fmt(stats?.traitVariance ?? 0, 4)}
          help="Genetic diversity across the population. High = many different body plans; low = everyone's converging on one design."
        />
        <Stat
          label="novelty"
          value={fmt(stats?.behaviorNovelty ?? 0, 3)}
          help="How much new behavior is appearing. Higher means creatures are still discovering new ways to live; near zero means the world has settled."
        />
        <Stat
          label="extinctions"
          value={fmt(stats?.extinctionEvents ?? 0)}
          help="How many lineages have died out completely over this world's whole history."
        />
      </div>
    </div>
  );
}

function DetachedBadge(): React.ReactElement | null {
  const detached = useSimStore((s) => s.detached);
  if (!detached) return null;
  return (
    <div
      className="panel absolute bottom-4 left-1/2 flex max-w-xs -translate-x-1/2 items-center gap-2 px-3 py-1.5"
      title="You've changed this world by hand (a slider, an edit, or a spawn). Your changes are saved and the world keeps running — but a share link now only reproduces the original starting point, not what you've made. Export the world to a file to keep this exact state."
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-2)]" />
      <span className="text-[10px] uppercase tracking-widest text-[var(--fg-dim)]">
        your world — hand-edited
      </span>
    </div>
  );
}

/**
 * Extinction / empty-world state. If every creature dies, the canvas would otherwise
 * go silently blank with no way back. This surfaces a calm panel that names what
 * happened and offers a one-click restart (re-seed the same world and resume). Gated on
 * proof that life *existed* (a prior nonzero population point) so it never flashes during
 * the first empty frame of a booting world.
 */
function ExtinctionOverlay(): React.ReactElement | null {
  const stats = useSimStore((s) => s.stats);
  const popHistory = useSimStore((s) => s.popHistory);
  const seed = useSimStore((s) => s.seed);
  const setSeed = useSimStore((s) => s.setSeed);
  const reinit = useSimStore((s) => s.reinit);
  const play = useSimStore((s) => s.play);

  const pop = stats ? Object.values(stats.population).reduce((a, b) => a + b, 0) : 0;
  const hadLife = popHistory.some((p) => p.population > 0);
  if (!stats || pop > 0 || !hadLife) return null;

  const restart = (): void => {
    // Advance the seed so the new world genuinely differs — re-seeding the same seed is
    // deterministic and would just replay the same run to the same extinction.
    setSeed(seed + 1);
    reinit();
    play();
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
      <div className="panel pointer-events-auto w-80 border-[color-mix(in_srgb,var(--accent-2)_35%,transparent)] p-6 text-center">
        <div className="crt-title crt-glow-amber mb-1 text-[10px] text-[var(--accent-2)]">
          &gt; signal lost
        </div>
        <div className="tabular crt-glow-amber mb-3 text-lg text-[var(--accent-2)]">
          the world fell silent
        </div>
        <p className="mb-5 text-[13px] leading-relaxed text-[var(--fg-dim)]">
          Every lineage in this world is gone. Evolution ran its course and the population collapsed
          to zero — it can't recover on its own.
        </p>
        <button type="button" onClick={restart} className="btn-accent w-full px-2 py-2 text-sm">
          begin a new world
        </button>
        <p className="mt-3 text-[10px] uppercase tracking-wider text-[var(--fg-mute)]">
          or spawn creatures with the tools above
        </p>
      </div>
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
        <div className="crt-title mb-3 text-[10px] text-[var(--fg-mute)]">
          &gt; replaying while you were away
        </div>
        <div className="tabular crt-glow mb-3 text-sm text-[var(--accent)]">
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
        <div className="crt-title mb-1 text-[10px] text-[var(--fg-mute)]">&gt; system report</div>
        <div className="tabular crt-glow mb-4 text-lg text-[var(--accent)]">
          generation {fmt(report.nowTick)}
        </div>
        <ul className="mb-5 space-y-1.5">
          {shown.map((line, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: static narration lines, stable order
              key={i}
              className="tabular text-sm text-[var(--fg-dim)]"
            >
              <span className="text-[var(--fg-mute)]">·</span> {line}
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
 * Onboarding boot sequence (docs/designs/chrome-crt-redesign.md) — the CRT bio-terminal
 * first-run experience. Replaces the old one-shot fade caption. A short sequence of
 * phosphor coach-marks, each anchored to a real region of chrome (the world, the toolbar,
 * the HUD), teaching what the terminal shows and lets you do. Shown on first visit, and
 * re-triggerable at any time via the `?` help panel's "replay intro" (a custom event).
 * Reduced-motion: no typing/blink, captions appear statically.
 */
const VISITED_KEY = "vivarium:visited";
const REPLAY_EVENT = "vivarium:replay-intro";

function firstVisit(): boolean {
  try {
    if (localStorage.getItem(VISITED_KEY) === "1") return false;
    localStorage.setItem(VISITED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Fire from anywhere to re-run the intro (the help panel calls this). */
export function replayIntro(): void {
  window.dispatchEvent(new CustomEvent(REPLAY_EVENT));
}

interface BootStep {
  tag: string;
  title: string;
  body: string;
  // Where the caption card sits on screen (anchored near the chrome it describes).
  pos: string;
}

const BOOT_STEPS: BootStep[] = [
  {
    tag: "> biome monitor online",
    title: "A living world.",
    body: "Nobody scripted this. Every creature evolved its own brain — they hunt, flee, mate, and build homes on their own.",
    pos: "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center",
  },
  {
    tag: "> specimen scan",
    title: "Read any organism.",
    body: "Click a creature to open its genome — vitals, lineage, and genes you can edit live and watch play out.",
    pos: "left-1/2 top-24 -translate-x-1/2 text-center",
  },
  {
    tag: "> intervention tools",
    title: "Play god (amber = you touch the world).",
    body: "The tools up top let you spawn life, cull it, or move water to cause a drought or flood.",
    pos: "left-1/2 top-20 -translate-x-1/2 text-center",
  },
  {
    tag: "> vitals",
    title: "The world's pulse.",
    body: "Top-left readings are the world's vital signs. Hover any of them to decode what it means.",
    pos: "left-56 top-6",
  },
];

function BootSequence(): React.ReactElement | null {
  const [step, setStep] = useState<number>(-1); // -1 = inactive
  const report = useSimStore((s) => s.report);

  useEffect(() => {
    if (firstVisit()) setStep(0);
    const onReplay = (): void => setStep(0);
    window.addEventListener(REPLAY_EVENT, onReplay);
    return () => window.removeEventListener(REPLAY_EVENT, onReplay);
  }, []);

  const s = BOOT_STEPS[step];
  // The report modal owns the screen; don't overlap the intro with it.
  if (step < 0 || s === undefined || report !== null) return null;

  const last = step === BOOT_STEPS.length - 1;
  const next = (): void => setStep(last ? -1 : step + 1);
  const skip = (): void => setStep(-1);

  return (
    // Dim scrim so the coach-marks read clearly; click the scrim to skip. The world stays
    // visible underneath (it's the hero even during onboarding).
    <div className="absolute inset-0 z-40 bg-[var(--bg)]/45 backdrop-blur-[1px]">
      {/* A real <button> backdrop for click-to-skip (a11y: no ARIA role hacks). */}
      <button
        type="button"
        onClick={skip}
        className="absolute inset-0 h-full w-full cursor-default"
        aria-label="dismiss intro"
      />
      <div
        className={`panel pointer-events-auto absolute w-72 p-4 ${s.pos}`}
        role="dialog"
        aria-label="intro"
      >
        <div className="crt-title crt-glow crt-caret mb-2 text-[10px] text-[var(--accent)]">
          {s.tag}
        </div>
        <div className="mb-1.5 text-sm font-medium text-[var(--fg)]">{s.title}</div>
        <p className="mb-4 text-[12px] leading-relaxed text-[var(--fg-dim)]">{s.body}</p>
        <div className="flex items-center justify-between">
          <span className="tabular text-[10px] tracking-widest text-[var(--fg-mute)]">
            {step + 1}/{BOOT_STEPS.length}
          </span>
          <div className="flex gap-1.5">
            {!last && (
              <button type="button" onClick={skip} className="btn px-2.5 py-1 text-[11px]">
                skip
              </button>
            )}
            <button type="button" onClick={next} className="btn-accent px-3 py-1 text-[11px]">
              {last ? "enter" : "next"}
            </button>
          </div>
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
          <ExtinctionOverlay />
          <DetachedBadge />
          <PersistErrorBadge />
          <div className="tabular pointer-events-none absolute bottom-4 left-4 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
            vivarium · seed {seed}
          </div>
          <BootSequence />
        </>
      )}

      <Landing />
      <CatchupOverlay />
      <WhileYouWereAwayReport />
    </div>
  );
}
