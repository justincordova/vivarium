/**
 * Timeline.tsx — the whole-run timeline scrubber (Phase 5B.1).
 *
 * SPEC.md §Visual Design: "Timeline scrubber with tick marks at extinction events."
 * The sim is forward-only (no per-tick snapshots to rewind into), so this is a READ-ONLY
 * overview of the recorded run — the full downsampled population history with a
 * vertical tick-mark at every whole-world extinction — not a time-travel control. It
 * makes the whole run legible at a glance: booms, crashes, and how far the world has
 * come. Hovering reads out the tick/population under the cursor.
 *
 * Grayscale chrome, monospace numbers, no animation (the only motion is the sim).
 */

import { useSimStore } from "@store/useSimStore";
import { useRef, useState } from "react";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function Timeline(): React.ReactElement | null {
  const timeline = useSimStore((s) => s.stats?.timeline ?? null);
  const [hover, setHover] = useState<{ tick: number; population: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (timeline === null || timeline.points.length < 2) return null;

  const points = timeline.points;
  const W = 100; // viewBox width (percent-like units); the SVG scales to its box
  const H = 28;
  const minTick = points[0]?.tick ?? 0;
  const maxTick = Math.max(timeline.now, points[points.length - 1]?.tick ?? 1);
  const span = Math.max(1, maxTick - minTick);
  let maxPop = 1;
  for (const p of points) if (p.population > maxPop) maxPop = p.population;

  const xOf = (tick: number): number => ((tick - minTick) / span) * W;
  const yOf = (pop: number): number => H - (pop / maxPop) * (H - 2) - 1;

  const path = points
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${xOf(p.tick).toFixed(2)},${yOf(p.population).toFixed(2)}`,
    )
    .join(" ");

  const onMove = (e: React.MouseEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    if (svg === null) return;
    const rect = svg.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const tick = minTick + frac * span;
    // Nearest recorded point to the cursor.
    let best = points[0] as { tick: number; population: number };
    let bestD = Number.POSITIVE_INFINITY;
    for (const p of points) {
      const d = Math.abs(p.tick - tick);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    setHover(best);
  };

  return (
    <div className="panel absolute bottom-4 left-1/2 z-10 w-[38rem] max-w-[70vw] -translate-x-1/2 px-3 py-2">
      <div className="mb-1 flex items-baseline justify-between">
        <span
          className="cursor-help text-[10px] uppercase tracking-widest text-[var(--fg-mute)]"
          title="A read-only overview of the world's whole history. Faint vertical marks are mass extinctions. Evolution only runs forward — hover to read the past, but you can't rewind."
        >
          history · overview
        </span>
        <span className="tabular text-[10px] text-[var(--fg-dim)]">
          {hover !== null
            ? `age ${fmt(hover.tick)} · pop ${fmt(hover.population)}`
            : `age ${fmt(timeline.now)}`}
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-7 w-full cursor-default"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="population timeline with extinction marks"
      >
        {/* Extinction tick-marks (faint vertical lines). Only those within the plotted
            tick window — the event-log and history windows are bounded separately, so an
            older extinction tick would otherwise map off the left edge. */}
        {timeline.extinctionTicks
          .filter((t) => t >= minTick && t <= maxTick)
          .map((t, i) => (
            <line
              // biome-ignore lint/suspicious/noArrayIndexKey: static per-render marks
              key={i}
              x1={xOf(t)}
              x2={xOf(t)}
              y1={0}
              y2={H}
              stroke="#525252"
              strokeWidth={0.3}
            />
          ))}
        {/* Population history. */}
        <path d={path} fill="none" stroke="#e5e5e5" strokeWidth={0.6} />
        {/* Hover marker. */}
        {hover !== null && (
          <line
            x1={xOf(hover.tick)}
            x2={xOf(hover.tick)}
            y1={0}
            y2={H}
            stroke="#a3a3a3"
            strokeWidth={0.4}
            strokeDasharray="1 1"
          />
        )}
      </svg>
    </div>
  );
}
