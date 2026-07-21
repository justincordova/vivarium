/**
 * Toolbar.tsx — the god-power tool palette (Task 3.4). Selects the active canvas
 * tool: inspect (click a creature), spawn (place a creature), delete (click to
 * remove), and move-water down/up (drought / flood — SPEC.md §Water labels this
 * "move water," not "remove," since beta has no atmosphere sink).
 *
 * Grayscale chrome. The tools act by dispatching worker commands (SimCanvas wires the
 * click → command); the toolbar only sets `tool` in the store.
 */

import { type Tool, useSimStore } from "@store/useSimStore";

interface ToolDef {
  id: Tool;
  label: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  { id: "inspect", label: "inspect", hint: "click a creature to read its genome" },
  { id: "spawn", label: "spawn", hint: "click to place a creature" },
  { id: "delete", label: "delete", hint: "click a creature to remove it" },
  { id: "paintWaterDown", label: "drought", hint: "click to move water away (drought)" },
  { id: "paintWaterUp", label: "flood", hint: "click to gather water (flood)" },
];

export function Toolbar(): React.ReactElement {
  const tool = useSimStore((s) => s.tool);
  const setTool = useSimStore((s) => s.setTool);
  const active = TOOLS.find((t) => t.id === tool);

  return (
    <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 flex-col items-center gap-1">
      <div className="panel flex items-center gap-1 p-1">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTool(t.id)}
            title={t.hint}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              tool === t.id
                ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                : "text-[var(--fg-dim)] hover:bg-[rgb(var(--panel-border)/0.12)] hover:text-[var(--fg)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {active && (
        <span className="tabular pointer-events-none text-[10px] uppercase tracking-widest text-[var(--fg-mute)]">
          {active.hint}
        </span>
      )}
    </div>
  );
}
