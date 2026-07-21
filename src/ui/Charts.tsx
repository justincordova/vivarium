/**
 * Charts.tsx — always-visible population + trait-distribution charts (Task 3.6).
 *
 * SPEC.md §Visual Design: "Charts first-class and always visible"; §Player
 * Experience: information is the reward. The population line reads the predator–prey
 * oscillation (the DoD's headline signal); the trait histogram shows a gene's
 * distribution over the current population from the worker's fixed-domain `TraitBins`.
 *
 * CRT bio-terminal chrome (docs/designs/chrome-crt-redesign.md): oscilloscope traces —
 * phosphor-green primary series, amber secondary, dim-green grid. NO chart animation —
 * the only thing that moves is the simulation (SPEC.md §Visual Design).
 */

import { useSimStore } from "@store/useSimStore";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

const AXIS = { fontSize: 9, fontFamily: "ui-monospace, Menlo, monospace", fill: "#4f8763" };
const GRID = "#163a24";
const PHOSPHOR = "#3bf07a"; // primary trace (green)
const AMBER = "#ffb54d"; // secondary trace

const TRAIT_OPTIONS = ["size", "diet", "aggression", "speed", "armor", "toxicity"] as const;

function PopulationChart(): React.ReactElement {
  const popHistory = useSimStore((s) => s.popHistory);
  return (
    <div>
      <div className="crt-title mb-1 text-[10px] text-[var(--fg-mute)]">population / species</div>
      <ResponsiveContainer width="100%" height={92}>
        <LineChart data={popHistory} margin={{ top: 2, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 3" />
          <XAxis dataKey="tick" tick={AXIS} stroke={GRID} minTickGap={40} />
          <YAxis tick={AXIS} stroke={GRID} width={34} />
          <Line
            type="monotone"
            dataKey="population"
            stroke={PHOSPHOR}
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="species"
            stroke={AMBER}
            dot={false}
            strokeWidth={1}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Lineage-population stacked area (Phase 5C.2) — the speciation view. Each band is a
 * founder-lineage root's live population over time, so diversification (bands
 * splitting), dominance turnover (a band swelling as another shrinks), and extinction
 * (a band vanishing) are all directly legible — speciation made viewable (the 5C gate)
 * without a heavyweight phylo tree. Phosphor-green ramp; the world stays the hero.
 */
const LINEAGE_SHADES = ["#3bf07a", "#2fc765", "#26a052", "#1d7a3e", "#15542b", "#0f3a1e"];
function LineageChart(): React.ReactElement {
  const lineageHistory = useSimStore((s) => s.lineageHistory);
  const topLineages = useSimStore((s) => s.topLineages);
  return (
    <div>
      <div className="crt-title mb-1 text-[10px] text-[var(--fg-mute)]">lineages</div>
      <ResponsiveContainer width="100%" height={82}>
        <AreaChart data={lineageHistory} margin={{ top: 2, right: 4, bottom: 0, left: -18 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 3" />
          <XAxis dataKey="tick" tick={AXIS} stroke={GRID} minTickGap={40} />
          <YAxis tick={AXIS} stroke={GRID} width={34} />
          {topLineages.map((root, i) => (
            <Area
              key={root}
              type="monotone"
              dataKey={`l${root}`}
              stackId="lineages"
              stroke="none"
              fill={LINEAGE_SHADES[i % LINEAGE_SHADES.length]}
              fillOpacity={0.9}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function TraitChart(): React.ReactElement {
  const stats = useSimStore((s) => s.stats);
  const [gene, setGene] = useState<string>("size");
  const bins = stats?.traits[gene];
  const data = (bins ?? []).map((count, i) => ({ bin: i, count }));

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="crt-title text-[10px] text-[var(--fg-mute)]">distribution</span>
        <select
          value={gene}
          onChange={(e) => setGene(e.target.value)}
          className="field tabular px-1 py-0.5 text-[10px] text-[var(--fg-dim)]"
          aria-label="trait gene"
        >
          {TRAIT_OPTIONS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={data} margin={{ top: 2, right: 4, bottom: 0, left: -18 }}>
          <XAxis dataKey="bin" tick={AXIS} stroke={GRID} minTickGap={20} />
          <YAxis tick={AXIS} stroke={GRID} width={34} />
          <Bar dataKey="count" fill={PHOSPHOR} fillOpacity={0.85} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Charts(): React.ReactElement {
  return (
    <div className="panel w-72 shrink-0 space-y-3 p-3">
      <PopulationChart />
      <LineageChart />
      <TraitChart />
    </div>
  );
}
