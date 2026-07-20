/**
 * Landing.tsx — the front door (UI overhaul, SPEC.md §Player Experience).
 *
 * The app opens here rather than dropping the visitor straight into motion. A dimmed
 * live sim renders BEHIND this overlay (App keeps <SimCanvas/> mounted), so the front
 * door is itself alive. The primary action enters the pre-evolved cold open — the
 * sim's strongest first impression — while "fresh" and "continue" are offered plainly.
 *
 * Chrome only: this reads the store and calls `bootWorld(source)`; it runs no sim
 * logic and never calls tick().
 */

import { useSimStore } from "@store/useSimStore";

export function Landing(): React.ReactElement | null {
  const phase = useSimStore((s) => s.phase);
  const hasSave = useSimStore((s) => s.hasSave);
  const bootWorld = useSimStore((s) => s.bootWorld);
  if (phase !== "landing") return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center">
      {/* Scrim over the live-but-dimmed canvas so the copy stays legible. */}
      <div className="absolute inset-0 bg-[var(--bg)]/72 backdrop-blur-[2px]" />

      <div className="panel relative mx-4 w-full max-w-md p-8 text-center">
        <img
          src="/vivarium-mark.svg"
          alt=""
          aria-hidden="true"
          width={72}
          height={72}
          className="mx-auto mb-3 h-16 w-16 drop-shadow-[0_0_16px_rgba(34,211,238,0.25)]"
        />
        <div className="mb-2 text-[11px] uppercase tracking-[0.3em] text-[var(--fg-mute)]">
          Vivarium
        </div>
        <h1 className="display text-balance text-2xl leading-tight text-[var(--fg)]">
          A world of creatures with evolved brains.
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-[var(--fg-dim)]">
          Nobody scripted what they do. They live, hunt, reproduce, and split into species on their
          own — and keep going while you are away.
        </p>

        <div className="mt-7 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => bootWorld("cold-open")}
            className="btn-accent w-full px-4 py-3 text-sm"
          >
            Enter the living world
          </button>

          {hasSave && (
            <button
              type="button"
              onClick={() => bootWorld("continue")}
              className="btn-ghost w-full border border-[rgb(var(--panel-border)/0.16)] px-4 py-2.5 text-sm"
            >
              Continue where you left off
            </button>
          )}

          <button
            type="button"
            onClick={() => bootWorld("fresh")}
            className="btn-ghost w-full px-4 py-2 text-[13px]"
            title="Start from random founders and watch evolution from scratch (overwrites any saved world)"
          >
            Start a fresh world
          </button>
        </div>

        <div className="mt-6 text-[11px] leading-relaxed text-[var(--fg-mute)]">
          Tip: click any creature to read its genome · drag to pan · scroll to zoom
        </div>
      </div>
    </div>
  );
}
