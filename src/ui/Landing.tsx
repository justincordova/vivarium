/**
 * Landing.tsx — the front door (SPEC.md §Player Experience).
 *
 * Opens over a dimmed, live sim (App keeps <SimCanvas/> mounted) so the door is itself
 * alive. Actions are deliberately simple: "New world" drops the visitor into the
 * pre-evolved, already-living world (the sim's strongest first impression), and "Resume"
 * appears only when a saved world exists. The empty founders-from-scratch start is a
 * power-user path (share URL / tests), intentionally not surfaced here.
 *
 * Chrome only: reads the store and calls `bootWorld(source)`; runs no sim logic.
 */

import { useSimStore } from "@store/useSimStore";

/** A single "what you're looking at" point in the intro strip. */
function Point({ title, body }: { title: string; body: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="display text-sm text-[var(--fg)]">{title}</div>
      <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--fg-mute)]">{body}</div>
    </div>
  );
}

export function Landing(): React.ReactElement | null {
  const phase = useSimStore((s) => s.phase);
  const hasSave = useSimStore((s) => s.hasSave);
  const bootWorld = useSimStore((s) => s.bootWorld);
  if (phase !== "landing") return null;

  return (
    <div className="absolute inset-0 z-40 overflow-hidden">
      {/* Layered backdrop over the live, dimmed canvas: a dark vignette + a soft accent
          bloom from the lower-left, so the screen feels composed, not empty. */}
      <div className="absolute inset-0 bg-[var(--bg)]/80" />
      <div
        className="absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 90% at 12% 100%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 55%), radial-gradient(90% 70% at 100% 0%, color-mix(in srgb, var(--accent-2) 12%, transparent), transparent 50%)",
        }}
      />

      {/* Content column, left-aligned and vertically centered — fills the space with a
          real composition instead of one small centered card. */}
      <div className="relative flex h-full w-full items-center">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-8 md:px-12">
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <img
                src="/vivarium-mark.svg"
                alt=""
                aria-hidden="true"
                width={44}
                height={44}
                className="h-11 w-11 drop-shadow-[0_0_18px_rgba(34,211,238,0.35)]"
              />
              <span className="display text-lg tracking-tight text-[var(--fg)]">Vivarium</span>
            </div>

            <div className="max-w-2xl">
              <h1 className="display text-balance text-4xl leading-[1.05] text-[var(--fg)] md:text-5xl">
                A living world that <span className="text-[var(--accent)]">evolves itself.</span>
              </h1>
              <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-[var(--fg-dim)]">
                Thousands of creatures with evolved brains hunt, drink, breed, and split into
                species across rivers, forests, and open plains. Nobody scripted any of it — and it
                keeps running while you are away.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => bootWorld("cold-open")}
                className="btn-accent px-6 py-3 text-[15px]"
              >
                {hasSave ? "New world" : "Begin"}
                <span aria-hidden="true" className="ml-2">
                  →
                </span>
              </button>
              {hasSave && (
                <button
                  type="button"
                  onClick={() => bootWorld("continue")}
                  className="btn-ghost border border-[rgb(var(--panel-border)/0.18)] px-6 py-3 text-[15px]"
                >
                  Resume your world
                </button>
              )}
            </div>
          </div>

          {/* "What you're looking at" strip — grounds a first-time visitor and gives the
              lower half of the screen purpose. */}
          <div className="grid max-w-4xl grid-cols-1 gap-x-8 gap-y-5 border-t border-[rgb(var(--panel-border)/0.12)] pt-6 sm:grid-cols-3">
            <Point
              title="Watch evolution happen"
              body="Predators, grazers, and pack behavior emerge on their own over generations."
            />
            <Point
              title="Read any creature"
              body="Click one to see its genome, diet, brain, and family line in plain language."
            />
            <Point
              title="Shape the world"
              body="Spawn life, trigger droughts and floods, and steer the pressures of natural selection."
            />
          </div>

          <div className="text-[11px] tracking-wide text-[var(--fg-mute)]">
            Drag to pan · scroll to zoom · click a creature to inspect it
          </div>
        </div>
      </div>
    </div>
  );
}
