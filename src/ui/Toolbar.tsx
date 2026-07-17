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
    <div className="absolute left-1/2 top-4 flex -translate-x-1/2 flex-col items-center gap-1">
      <div className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/85 p-1 backdrop-blur-sm">
        {TOOLS.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setTool(t.id)}
            title={t.hint}
            className={`rounded px-2.5 py-1 text-xs ${
              tool === t.id
                ? "bg-neutral-200 text-neutral-950"
                : "text-neutral-400 hover:bg-neutral-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {active && (
        <span className="tabular pointer-events-none text-[10px] uppercase tracking-widest text-neutral-600">
          {active.hint}
        </span>
      )}
    </div>
  );
}
