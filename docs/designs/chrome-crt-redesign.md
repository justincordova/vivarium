# Chrome CRT Bio-Terminal Redesign + Onboarding

## Context

Vivarium's in-world chrome currently reads as "mission-control telemetry": tiny
uppercase mono labels, tabular numbers, translucent blurred deep-space panels, a single
teal→cyan accent. It is competent but clinical, and it does not feel like an indie game.
Worse, it is inconsistent: the Landing, Toolbar, HUD, and Inspector use the themed design
tokens, but `ControlPanel.tsx` is still hardcoded gray (`bg-neutral-800`,
`text-neutral-500`, `border-neutral-800`) from before the theme existed — it looks like a
different app.

The developer wants a more **indie** personality. Chosen direction: **retro bio-terminal /
CRT** — the UI as a vintage lab computer monitoring a terrarium. This fits Vivarium's
sim-toy heritage (Creatures-era) and the literal "vivarium under observation" framing.
This is a chrome-only redesign: `src/ui/**` + `src/styles.css`. No sim/worker/render logic
changes.

## Goals

- One coherent visual identity across every panel (retire all hardcoded grays).
- A distinct, characterful **CRT bio-terminal** look: phosphor text, scanline texture,
  boxy terminal windows, mono-first typography.
- A **two-phosphor semantic system**: green = observation/safe, amber = intervention/
  warning/danger. This gives the whole UI semantic coherence.
- A first-run onboarding **boot sequence** that teaches the chrome and is replayable
  (fixing today's one-shot 6.6s fade that never returns).
- Preserve the world-as-hero floating-panels layout; the canvas stays the saturated star.
- Restrained, purposeful motion only; honor `prefers-reduced-motion`.

## Non-Goals

- **The world canvas is never CRT-tinted.** Creature lineage color (hue = family) is
  load-bearing visual language; a green tint over the simulation would destroy it. CRT
  treatment is chrome-only — the world glows *through* the terminal.
- No animated CRT flicker (nausea/accessibility risk, competes with the sim). Texture is
  static.
- No structural layout change (no docks/rails). Floating panels stay.
- No new visual *identity* invented from scratch beyond the CRT direction; no sim,
  worker, protocol, or render changes.
- No new dependencies.

## Design

### Foundation (`src/styles.css`)

**Token palette shift** deep-space-teal → phosphor terminal:
- `--bg`: near-black with faint green cast (unlit CRT), e.g. `#070a07` range.
- `--panel`: dark phosphor-tinted glass, boxier and more opaque than today.
- `--accent` (primary): terminal/phosphor **green** (~`#3bf07a`).
- `--accent-2`: **amber** (~`#ffb54d`) — the second phosphor, for warnings/god-powers.
- `--fg` / `--fg-dim` / `--fg-mute`: phosphor-green-white → dimmer green-grays.
- `--radius`: reduced (~`0.25rem` / near-square) so panels read as terminal windows.

**Typography:** mono-first. The mono face becomes the primary UI type (labels, buttons,
everything), not just numbers. Display face reserved for the Landing title only (chunkier
treatment). This alone carries most of the personality shift.

**Reusable primitives** (so panels stop re-implementing ad hoc):
- `.btn` base + `.btn-ghost` / `.btn-accent` / `.btn-amber` / `.btn-toggle` (active uses
  `--accent`; amber variant for interventions).
- `.field` — terminal input (number/text/checkbox styling).
- `.section` — consistent divider + spacing rhythm.
- `.chip` — pill/box buttons (speed, step).
- `.label` (10px uppercase tracking-widest mute), `.readout` (tabular phosphor).

**Texture primitives** (static, reduced-motion-safe):
- `.crt` — faint scanline overlay (repeating 2px linear-gradient) + subtle vignette.
- `.crt-glow` — soft phosphor text-shadow bloom on headings/readouts.
- Low-opacity film grain over chrome only (never the canvas).

### Per-panel treatment

Every panel becomes a titled **terminal window** with a phosphor header. Common rule:
**green = observe/safe, amber = intervene/warn/danger.**

- **HUD** — primary readout screen; phosphor-green numbers with bloom; window-title header;
  keep the dotted-underline hover tooltips.
- **ControlPanel** — kills all grays. Play/pause/step/speed = terminal buttons (green
  active, dim-green idle); re-init/share/export/import = **amber** (interventions); seed +
  catch-up = `.field` inputs; sliders get phosphor track + square thumb.
- **Toolbar** — god-power palette; active tool glows **amber** ("you're touching the
  world"), idle tools dim-green.
- **Inspector** — "specimen readout"; creature #id terminal header; phosphor vital
  readouts; genome sliders match new style; delete = amber/danger.
- **Charts** — Recharts restyled to oscilloscope: phosphor-green primary line, amber
  secondary, thin dim-green grid; animation stays off (SPEC).
- **Timeline** — oscilloscope trace; green population line, amber extinction ticks, faint
  scanlines; keep "history · overview" + forward-only tooltip.
- **Overlays** — terminal system screens. Report → boot-log ("> SYSTEM REPORT ·
  GENERATION N"). Extinction → stark amber "SIGNAL LOST". Catch-up → boot/replay screen.
  Detached badge → amber. Landing title → chunkier terminal treatment.

### Onboarding (boot sequence)

Replaces the one-shot fade caption. On first entry to a live world, 3–4 phosphor
coach-marks type on (reduced-motion → instant), each spotlighting real chrome via a
dim scrim + highlight cutout:
1. `> BIOME MONITOR ONLINE` → the world ("Nobody scripted this…").
2. `> SPECIMEN SCAN` → inspect/creature ("Click any organism to read its genome…").
3. `> INTERVENTION TOOLS` → toolbar ("Amber tools let you play god…").
4. `> VITALS` → HUD ("The world's pulse. Hover any reading to decode it.").

Each has **skip** + **next**; dismissible immediately. **Replayable** via a `> intro`
affordance near the `?` help button (gated by existing `vivarium:visited` key, now
re-triggerable). No typing animation / flicker under reduced-motion.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Personality | Retro bio-terminal / CRT | Fits Vivarium's sim-toy heritage; strong indie identity; literal "terrarium under observation" |
| Palette | Green + amber two-phosphor | Classic terminal duality; gives semantic split observe/intervene |
| Canvas treatment | Untouched (no CRT tint) | Lineage hue is load-bearing; tinting destroys the visual language |
| Typography | Mono-first for chrome | Carries most of the personality; reserves display face for Landing |
| Texture | Static scanlines/grain/bloom | Flicker is a nausea/accessibility risk and violates SPEC motion rule |
| Semantic color rule | green=observe, amber=intervene | Single rule → coherent meaning across all panels |
| Onboarding | Terminal boot sequence, replayable | Diegetic to the look; fixes the never-returning 6.6s fade |
| Scope | Chrome only (`src/ui/` + `styles.css`) | Keeps deterministic sim/worker/render untouched; 275-test suite is the safety net |

## Rejected Alternatives

- **Naturalist's field journal** (parchment/ink/serif, botanical) — cozy and on-theme, but
  the developer chose CRT.
- **Soft organic / living UI** (blobby rounded panels, bioluminescent) — modern-indie
  cozy, but less distinctive than CRT and further from the sim-toy heritage.
- **New visual identity from scratch** (redefine everything) — highest risk; discards a
  deliberate identity for no clear gain over evolving it.
- **Structured dock/shell layout** — more app-like but reduces world-as-hero immersion and
  is a bigger structural change.
- **Animated CRT flicker / heavy glow** — nausea/accessibility problem; competes with the
  world; violates the SPEC "only the simulation moves" rule.
- **Polishing the existing telemetry look** — makes a nicer dashboard, not an indie game;
  doesn't address the "doesn't feel indie" problem.

## Edge Cases & Constraints

- **Contrast/a11y:** phosphor-green and amber text must clear contrast minimums on the
  near-black bg; preserve focus rings and keyboard nav.
- **`prefers-reduced-motion`:** disables typing animation and any motion; texture stays
  static regardless.
- **Recharts theming:** must restyle via props/CSS without re-enabling animation.
- **No sim coupling:** any UI test asserting on changed label text gets updated; the
  worker/protocol/render layers stay byte-for-byte the same.
- **Backdrop-blur cost:** keep panel blur modest; CRT texture must not tank render FPS
  (chrome repaints are cheap vs the canvas rAF loop, but avoid large animated filters).

## Rollout (each a commit, gated build→test→lint)

1. Foundation: new tokens + primitives + CRT texture classes in `styles.css`.
2. De-gray ControlPanel; move HUD/Toolbar/Inspector onto the terminal button/field/window
   language.
3. Charts + Timeline oscilloscope restyle.
4. Overlays as terminal system screens (report, extinction, catch-up, detached badge,
   Landing title).
5. Onboarding boot-sequence coach-marks + replay affordance.

## Open Questions

- (none)
