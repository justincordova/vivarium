/**
 * EventFeed.tsx — the plain-language chronicle of the world (Living World §"Humanized
 * default UI"; `docs/plans/phase-7-society-plan.md` Task 8).
 *
 * The sim has always written events — `birth:`, `kill:`, `nest:`, `extinct` — and until
 * now the only consumer pulled out extinction ticks for the timeline and dropped the
 * rest. So the world was telling a story that nothing narrated. This is the narrator.
 *
 * The sentences come from `./narrate` (pure, unit-tested); this file is only the shell.
 * Time is measured in generations, never wall-clock — a wall-clock stamp is meaningless
 * across an offline catch-up boundary, and `realTime` is not sim state (AGENTS.md).
 *
 * Chrome only: reads `stats.events`, which the worker rebuilds whole on the stats
 * cadence, so there is no accumulation or dedupe to get wrong here.
 */

import { useSimStore } from "@store/useSimStore";
import { narrate } from "./narrate";

/** The colour dot that ties an entry to what the player can see on the canvas. */
function HueDot({ hue }: { hue: number }): React.ReactElement {
  if (hue < 0) {
    return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--fg-mute)]" />;
  }
  return (
    <span
      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: `hsl(${hue} 70% 60%)` }}
    />
  );
}

export function EventFeed(): React.ReactElement {
  const events = useSimStore((s) => s.stats?.events);
  const scienceMode = useSimStore((s) => s.scienceMode);

  // Newest first: a feed is read from the top, and the latest drama is the point.
  const shown = events ? events.slice().reverse() : [];

  return (
    <div className="panel p-3">
      <div className="mb-2 text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
        chronicle
      </div>

      {shown.length === 0 ? (
        <p className="py-2 text-[11px] leading-relaxed text-[var(--fg-mute)]">
          Nothing notable yet. Births and deaths happen constantly — this records the turning
          points.
        </p>
      ) : (
        <ul className="max-h-56 space-y-2 overflow-y-auto pr-1">
          {shown.map((e) => (
            <li key={e.key} className="flex gap-2">
              <HueDot hue={e.hue} />
              <div className="min-w-0">
                <div className="text-[11px] leading-snug text-[var(--fg-dim)]">{narrate(e)}</div>
                <div className="tabular text-[9px] uppercase tracking-wider text-[var(--fg-mute)]">
                  gen {e.tick.toLocaleString("en-US")}
                  {/* Raw lineage ids are exactly what a researcher wants and exactly what a
                      newcomer cannot use — so they ride along only in science mode. */}
                  {scienceMode && e.lineage >= 0 && ` · lineage #${e.lineage}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
