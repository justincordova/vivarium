# Soft Organic / Living-World Chrome

## Context

Vivarium's in-world chrome was inconsistent (the ControlPanel and Charts were hardcoded
gray while everything else used the themed teal tokens) and read as a clinical dashboard.
The developer wanted a more **indie** feel. A first attempt at a retro CRT bio-terminal
look was rejected (disliked the aesthetic) and reverted — it also introduced texture-layer
clipping bugs. This is the replacement direction: **soft organic / living UI**.

Chosen because Vivarium is a *dark* app — the world canvas is a dark field with glowing
creatures, and the layout is built around "world as the luminous hero on a dark stage." A
light/parchment "field journal" look would fight that (light panels shouting over the dark
world). Soft-organic keeps the dark base the app needs while replacing clinical rectangles
with warm, rounded, tactile panels and gentle bioluminescent accents.

Chrome-only: `src/ui/**` + `src/styles.css`. No sim/worker/render changes. The world
canvas and its lineage-hue color language are untouched.

## Goals

- One coherent identity across every panel (retire the hardcoded grays).
- A warm, dark, rounded, tactile "premium mobile nature game" feel.
- Keep the world the luminous hero; chrome recedes.
- Restrained motion; honor `prefers-reduced-motion`.

## Non-Goals

- No world-canvas restyle (lineage hue is load-bearing).
- **No `::before`/`::after` texture overlays on panels** — the CRT attempt proved they
  clip nested/scrolling content and fight `overflow-y-auto`. Panels stay plain surfaces.
- No new layout/structure; floating panels stay.
- No new dependencies.

## Design

**Tokens (`styles.css`):** warm dark base (`--bg: #0b1210`, a night forest floor), warm
mint panel edges, warm bioluminescent **aqua→lime** accent (`--accent: #5eeabe`,
`--accent-2: #a7e86a`), warm off-white/sage text. Generous rounding
(`--radius: 1.1rem`, `--radius-sm: 0.7rem`) is the core personality. Soft, diffuse,
layered shadow (no hard drop).

**Primitives:**
- `.panel` — rounded translucent blurred surface, soft shadow + faint inner top highlight.
  Plain surface, no texture pseudo-elements.
- `.btn-accent` — warm bioluminescent pill (999px), soft glow, tactile press.
- `.btn-ghost` — quiet rounded pill.
- `.ctl` / `.ctl-active` — the workhorse tactile control (playback/step/speed/seed/share);
  rounded, translucent, lifts on hover; `.ctl-active` = accent-tinted selected state.
- `.field` — soft rounded input.
- `.slider` — rounded pill track with a soft glowing thumb.

**Cascade discipline (learned from the CRT bug):** primitive classes set their own
properties but are used standalone; we do NOT layer a Tailwind `text-[...]` color on top of
a class that also sets `color` (un-layered base beats the utility). Buttons take their
color from the primitive.

**Panels:** HUD, Toolbar, Inspector, Landing, overlays already used tokens/`.btn-*`/
`.panel`, so they inherit the warm palette automatically. ControlPanel and Charts (the gray
holdouts) were moved onto `.ctl`/`.field`/`.slider` and token colors. Chart series became
warm aqua/lime; Timeline trace warm aqua with amber extinction ticks.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Direction | Soft organic (not field journal) | App is dark; a light UI would fight the dark-canvas hero |
| Palette | Warm dark + aqua→lime bioluminescence | Cozy indie feel while staying dark |
| Personality carrier | Rounding + soft glow + spacing | Achieves "organic/tactile" without fragile texture |
| Panel texture | None | CRT's ::before/::after overlays clipped content and broke scroll |
| Scope | Chrome only | Keeps deterministic sim/worker/render untouched |

## Rejected Alternatives

- **Retro CRT bio-terminal** — implemented then reverted; disliked, and its scanline
  texture layers caused clipping/scroll bugs.
- **Naturalist's field journal** (light parchment/serif) — would invert the dark-canvas
  hero relationship and visually out-shout the world.
- **Keep the teal dashboard look** — the "doesn't feel indie" complaint stands.
- **Panel texture via pseudo-elements** — root cause of the CRT clipping bugs.

## Edge Cases & Constraints

- Contrast: aqua/lime and warm off-white all clear minimums on the near-black bg.
- `prefers-reduced-motion`: disables button/field transitions and the landing float.
- No un-layered `color` overriding Tailwind utilities (cascade discipline above).
- Render/canvas world colors must stay exactly as-is (lineage hue).

## Open Questions

- (none)
