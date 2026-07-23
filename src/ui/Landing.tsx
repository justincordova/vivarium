/**
 * Landing.tsx — the game title screen (SPEC.md §Player Experience).
 *
 * Opens over the LIVE world (App keeps <SimCanvas/> mounted, only lightly dimmed): the
 * world is the hero. This lays a cinematic top/bottom vignette for legibility, then a
 * centered title, one evocative line, and stacked actions — the grammar of a game title,
 * not a product page. Actions are simple: "New world" enters the pre-evolved, living
 * world; "Resume" appears only when a save exists.
 *
 * Chrome only: reads the store and calls `bootWorld(source)`; runs no sim logic.
 */

import { useSimStore } from "@store/useSimStore";

export function Landing(): React.ReactElement | null {
  const phase = useSimStore((s) => s.phase);
  const hasSave = useSimStore((s) => s.hasSave);
  const bootWorld = useSimStore((s) => s.bootWorld);
  if (phase !== "landing") return null;

  return (
    <div className="absolute inset-0 z-40 overflow-hidden">
      {/* Cinematic vignette: darken top & bottom (letterbox feel) and the far edges, so
          the title and buttons stay legible while the world still BREATHES through the
          middle — the living world is the hero of the title screen, so keep the center
          clear and only dim enough for text contrast. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,10,9,0.7) 0%, rgba(6,10,9,0.08) 30%, rgba(6,10,9,0.08) 60%, rgba(6,10,9,0.82) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(80% 80% at 50% 45%, transparent 52%, rgba(6,10,9,0.5) 100%)",
        }}
      />

      {/* Centered title stack. */}
      <div className="relative flex h-full w-full flex-col items-center justify-center px-6 text-center">
        <img
          src="/vivarium-mark.svg"
          alt=""
          aria-hidden="true"
          width={72}
          height={72}
          className="landing-float mb-6 h-[4.5rem] w-[4.5rem] drop-shadow-[0_0_30px_rgba(34,211,238,0.5)]"
        />

        <h1 className="display text-[clamp(3rem,11vw,7rem)] font-semibold leading-none tracking-tight text-[var(--fg)] drop-shadow-[0_2px_24px_rgba(0,0,0,0.6)]">
          vivarium
        </h1>
        <div className="landing-rule mx-auto mt-5 h-px w-40" />
        <p className="mt-5 max-w-md text-[15px] leading-relaxed tracking-wide text-[var(--fg-dim)]">
          A living world that evolves itself. Nobody scripts what happens next.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => bootWorld("cold-open")}
            className="btn-accent min-w-[16rem] px-8 py-3.5 text-base tracking-wide"
          >
            {hasSave ? "New world" : "Enter"}
          </button>
          {hasSave && (
            <button
              type="button"
              onClick={() => bootWorld("continue")}
              className="btn-ghost min-w-[16rem] px-8 py-3 text-base tracking-wide"
            >
              Resume your world
            </button>
          )}
        </div>

        <div className="absolute bottom-7 left-0 right-0 text-[11px] uppercase tracking-[0.25em] text-[var(--fg-mute)]">
          drag to pan · scroll to zoom · click a creature
        </div>
      </div>
    </div>
  );
}
