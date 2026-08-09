/**
 * Toolbar.tsx — the god-power tool palette (Task 3.4). Selects the active canvas
 * tool: inspect (click a creature), spawn (place a creature), delete (click to
 * remove), and move-water down/up (drought / flood — SPEC.md §Water labels this
 * "move water," not "remove," since beta has no atmosphere sink).
 *
 * In Terrarium mode (`docs/designs/terrarium.md`) each power also carries an influence
 * cost and is dimmed when unaffordable. That is a *hint* only — the worker owns the budget
 * and is what actually refuses the command, since it is the only place that can
 * check-and-spend atomically at a tick boundary.
 *
 * Grayscale chrome. The tools act by dispatching worker commands (SimCanvas wires the
 * click → command); the toolbar only sets `tool` in the store.
 */

import * as C from "@sim/constants";
import { type Tool, useSimStore } from "@store/useSimStore";

interface ToolDef {
  id: Tool;
  label: string;
  hint: string;
  /** Influence charged when Terrarium mode is on; 0 = always free (inspect). */
  cost: number;
}

const TOOLS: ToolDef[] = [
  { id: "inspect", label: "inspect", hint: "click a creature to read its genome", cost: 0 },
  { id: "spawn", label: "spawn", hint: "click to place a creature", cost: C.INFLUENCE_COST_SPAWN },
  {
    id: "delete",
    label: "delete",
    hint: "click a creature to remove it",
    cost: C.INFLUENCE_COST_DELETE,
  },
  {
    id: "paintWaterDown",
    label: "drought",
    hint: "click to move water away (drought)",
    cost: C.INFLUENCE_COST_PAINT,
  },
  {
    id: "paintWaterUp",
    label: "flood",
    hint: "click to gather water (flood)",
    cost: C.INFLUENCE_COST_PAINT,
  },
];

export function Toolbar(): React.ReactElement {
  const tool = useSimStore((s) => s.tool);
  const setTool = useSimStore((s) => s.setTool);
  const terrarium = useSimStore((s) => s.terrarium);
  const influence = useSimStore((s) => s.stats?.influence ?? 0);
  const active = TOOLS.find((t) => t.id === tool);

  return (
    <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
      {/* The budget meter only exists in Terrarium mode — in the sandbox there is no
          budget to show, and an always-present empty bar would imply a limit that is not
          being enforced. */}
      {terrarium && (
        <div className="panel mb-0.5 flex items-center gap-2 px-2.5 py-1">
          <span className="text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
            influence
          </span>
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-[rgb(var(--panel-border)/0.25)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
              style={{ width: `${Math.round((influence / C.INFLUENCE_MAX) * 100)}%` }}
            />
          </div>
          <span className="tabular text-[11px] text-[var(--fg-dim)]">{influence}</span>
        </div>
      )}

      <div className="panel flex items-center gap-1 p-1">
        {TOOLS.map((t) => {
          const unaffordable = terrarium && t.cost > influence;
          return (
            <button
              type="button"
              key={t.id}
              onClick={() => setTool(t.id)}
              title={unaffordable ? `${t.hint} — needs ${t.cost} influence` : t.hint}
              // Without an explicit label the cost badge is concatenated into the
              // accessible name — this read as "spawn25" in QA. Spell the cost out instead.
              aria-label={
                terrarium && t.cost > 0 ? `${t.label} — costs ${t.cost} influence` : t.label
              }
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                tool === t.id
                  ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                  : unaffordable
                    ? "text-[var(--fg-mute)] opacity-50"
                    : "text-[var(--fg-dim)] hover:bg-[rgb(var(--panel-border)/0.12)] hover:text-[var(--fg)]"
              }`}
            >
              {t.label}
              {terrarium && t.cost > 0 && (
                <span aria-hidden="true" className="tabular ml-1 text-[10px] opacity-70">
                  {t.cost}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {active && (
        <span className="tabular pointer-events-none text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
          {active.hint}
        </span>
      )}
    </div>
  );
}
