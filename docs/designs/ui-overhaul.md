# UI Overhaul — Beautiful Welcoming Observatory

## Context

Vivarium's beta shipped a UI faithful to the original SPEC §Visual Design: an
austere "scientific instrument" — all-grayscale chrome, the world the only
saturated element, floating absolute-positioned panels, and a one-shot 6.6s
"cold open" caption as the entire onboarding. In practice a first-time visitor is
dropped into motion with no framing and cannot tell what they are looking at.
Panels overlap and get clipped on smaller viewports, wheel-zoom is undiscoverable,
and spawning is unreliable.

This is a deliberate product pivot, driven by the owner's changed taste, away from
"scientific instrument" toward a **beautiful, welcoming observatory with a real
front door**. It reverses four explicit SPEC decisions ("no game UI", "grayscale
chrome", "scientific instrument", "cold open not tutorial"). It is **almost
entirely presentation**: the pure `sim/` is completely untouched, and the vast
majority of work lives in `render/` (pure function of a frame) and `ui/` (React
chrome + the Zustand store). The **one** non-presentation change is a small
`worker/` protocol addition so the landing screen can *choose* the world source
(see Section 1 — the current `boot` hardcodes the source precedence). No score,
goals, or progression are added — the sim's emergent behavior remains the reward.

North star: **a newcomer instantly "gets it" and enjoys it.**

## Goals

- A real landing/front-door screen; the primary action enters the gorgeous
  pre-evolved cold-open world (instant emergence, the sim's strongest first
  impression), with a secondary "fresh world" and a "continue" for returning
  visitors.
- Beautiful, themed, hierarchical UI (drop the austere grayscale-only rule) using
  a single token source; monospace retained for numbers.
- A robust responsive layout: nothing is ever clipped or overlapping; panels dock
  and scroll.
- Prettier creature/environment rendering that stays **derived from the genome**
  (meaning preserved), at 60fps under density.
- Onboarding that a newcomer understands: a persistent, reopenable **legend** that
  decodes the visual language, a reopenable **help/controls** affordance,
  on-screen **zoom controls**, and reliable **spawn** (one click, hardier
  creature, auto-inspected).

## Non-Goals

- No changes to `sim/`; determinism, energy/water ledgers, brains, and the save
  format are untouched. The only `worker/` change is an additive `boot`-source
  selector (Section 1); persistence and catch-up *semantics* are unchanged.
- No game objectives, score, win/lose, or progression systems.
- No designed creature sprites / character art — appearance stays procedurally
  derived from the genome.
- No new persistence backend; "continue" reads the existing IndexedDB save.
- Post-beta modes (Terrarium/Laboratory) remain deferred.

## Design

> **Process constraint (binding):** all visual/frontend work in `ui/` and `render/`
> is executed under the **frontend-design skill** (autopilot mode). That means:
> scan and follow existing conventions first (Tailwind 4, existing tokens,
> monospace-for-numbers); theme via tokens, never hardcoded colors; deliberate
> typography/color/spacing/motion; verify responsive + accessible + no dead code.
> Explicitly avoid the skill's named anti-patterns — **no Inter/Roboto/system font
> as the primary display face, no purple-gradient-on-white cliché, no
> animate-everything.** Load the frontend-design skill at the start of each UI
> execution session.

### 1. Landing screen & world-entry flow

Introduce an explicit UI lifecycle phase in the store:

```
"landing" → [Enter the living world]  → "entering" (boot + optional catch-up) → "live"
            [Start a fresh world]     ↗
            [Continue]  (only if a save exists) ↗
```

- New `Landing.tsx`, a full-screen overlay above the canvas.
- Hook line: "A world of creatures with evolved brains — nobody scripted what
  they do."
- **Primary** "Enter the living world" → boots the pre-evolved cold-open snapshot
  (the instant-wow path; the current default source).
- **Secondary** "Start a fresh world" → boots a seeded empty world; labeled
  honestly (evolution from scratch, no instant drama).
- **Tertiary** "Continue" → shown only when an IndexedDB save exists; resumes it
  (replaces today's silent auto-resume).
- A dimmed/blurred **live preview** of the sim renders behind the menu so the
  front door itself is alive.
- `startWorker()` no longer auto-boots into autoplay on mount; mount shows Landing.
  The chosen button triggers boot with the corresponding source.
- **Required worker change (the one non-presentation edit).** Today `boot`
  (`sim.worker.ts:150`, `protocol.ts:177`) hardcodes a fixed source precedence:
  `loadNewest` (saved world) > `coldOpen` > founders. The caller cannot pick. The
  three buttons need explicit selection, so add an additive `source` discriminator
  to the `boot` command:
  - `"continue"` → current behavior (load saved slot; the button only shows when a
    save exists).
  - `"cold-open"` → **ignore** the save and load the supplied cold-open snapshot
    (the "Enter the living world" path).
  - `"fresh"` → **bypass** `loadNewest` and `createWorld(seed, config)` from
    founders (the "Start a fresh world" path).
  This is a small, additive `worker/`+`protocol.ts` change; `sim/` is untouched.
  Backward-compatible default: an absent `source` preserves today's precedence.
  Note "fresh"/"cold-open" starting a world while a save exists implies overwriting
  that save on the next autosave rotation — acceptable and expected, but call it out
  in the landing copy for "fresh".
- The existing `CatchupOverlay` and boot sequence play during "entering"; Landing
  fades to "live" when the store's `ready` fires.
- Repurpose the existing `vivarium:visited` localStorage flag: first-ever visit
  emphasizes "Enter the living world"; returning visitors with a save promote
  "Continue".

### 2. Theming

- Single token source: CSS custom properties in `index.css` + a Tailwind theme
  extension. Deep-space base (~`#0a0b12`), cool slate translucent panel surface
  with backdrop-blur, one bioluminescent teal→cyan **accent** for
  primary/interactive elements, and sparse semantic colors (positive/warn/danger).
  Deliberately **not** the purple-on-white AI cliché; the accent is chosen to feel
  like the world's own bioluminescence.
- Panels become themed cards: soft border, subtle inner highlight, rounded, gentle
  shadow.
- Typography: monospace retained for all numbers; pair a **display face with
  character** (not Inter/Roboto/system-default) for headings with a clean readable
  body face. Two faces max per surface, a clear type scale. Actual faces chosen at
  execution time under the frontend-design skill against what the project already
  loads.
- Motion is sparing and purposeful (landing preview, panel transitions, coachmarks)
  — never animate-everything; honor `prefers-reduced-motion` for all of it.

### 3. Layout system

Replace floating absolute panels with a CSS Grid app shell:

- `grid-rows-[auto_1fr_auto]`: top bar (title + world stats + global play/speed),
  center canvas (fills), bottom bar (timeline).
- **Left dock**: tools + control sliders (collapsible). **Right dock**: inspector
  + charts + legend (collapsible). Docks are `overflow-y-auto` with a `max-h`, so
  content scrolls and is **never clipped**.
- Responsive: below a width breakpoint, docks collapse to icon toggles that slide
  over the canvas rather than squeezing it; the canvas is never clipped.
- Canvas keeps only transient overlays (death-note toast, onboarding coachmarks).

### 4. Creature & environment rendering

- Appearance stays **derived from the genome**: shape morphs round↔angular by
  `diet`; radial gradient + soft glow tinted by `hue`; saturation driven by energy
  (starving = washed out); spikes/ornaments from `armor`/`toxicity` as clean
  tapered shapes; faint age ring; subtle motion-direction cue.
- Environment: richer water/plant field underlay, full-canvas day/night tint
  (already in SPEC), low-alpha trail blur retained.
- `render/` stays a pure function of a frame — no sim coupling. Additive/gradient
  work scales down past a creature-count threshold to hold 60fps under density;
  pulsing disabled under `prefers-reduced-motion`.

### 5. Onboarding, legend & discoverable controls

- **Legend panel** (right dock, persistent + reopenable): decodes hue = lineage,
  angular = carnivore, spikes = armor/toxicity, washed-out = starving, ring = age.
- **Help/controls** affordance (`?`, always available): pan (drag), zoom (wheel +
  on-screen `+ / − / fit`), tools.
- **On-screen zoom controls** (`+ / − / fit`) wired to the existing camera
  `zoomAt`/`fitCamera`.
- **Onboarding**: replace the one-shot 6.6s fade with a short, dismissible,
  **re-openable** first-run coachmark sequence pointing at the legend and controls.
- **Spawn UX**: raise the click-vs-drag threshold / treat a quick tap as a click so
  one click spawns; spawned creature gets more starting energy/hydration and is
  **auto-inspected**; tooltips on every tool.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pivot depth | Re-skin + one additive worker `boot` source selector | Architecture isolates sim from render/ui; only the source-precedence choice must move from worker-hardcoded to caller-chosen |
| Front-door primary action | Enter the **pre-evolved** world | A fresh world shows flailing random creatures — the least impressive state; emergence is the wow |
| Game systems | None (no score/goals) | North star is comprehension + delight, not game-feel; goals clash with the sim's soul and touch store/worker |
| Creature art | Genome-derived, prettier | Preserves meaning (visuals encode genes) while raising beauty; avoids decoupling appearance from data |
| Grayscale rule | Dropped | Warmth + hierarchy help newcomers; single accent keeps it disciplined |
| Layout | CSS Grid shell + scrollable docks | Directly fixes clipping/overlap; replaces brittle absolute offsets |
| Onboarding | Reopenable legend + coachmarks | "Never hide information" survives; the one-shot fade did not |
| Visual execution | frontend-design skill (autopilot), binding | Enforces intentional, non-generic design; codifies anti-cliché guardrails (fonts, palette, motion) |

## Rejected Alternatives

- **Full game pivot (objectives, score, progression).** Rejected: highest cost,
  touches store/worker, and a "New World" front door lands on an unimpressive
  empty world; goals fight the sim's emergent strength.
- **Designed creature sprites / character art.** Rejected: decouples appearance
  from the genome, discarding the "appearance is derived, never designed"
  information channel that makes the world legible.
- **Keep austere grayscale, only add a legend.** Rejected: does not meet the
  owner's explicit desire for beauty and a welcoming feel.
- **Targeted bug-fixes only (no redesign).** Rejected: does not address the core
  "newcomer has no idea what's happening" problem.

## Edge Cases & Constraints

- Boot sequencing: Landing → boot → (catch-up overlay if ticks owed) → ready →
  live. Landing must not race the worker `ready` event; gate the fade on `ready`.
- Shared-URL deep link (`#...`): should skip Landing and boot the shared world
  directly (preserve current behavior) — a link is an explicit intent to enter.
- "Continue" visibility depends on an async IndexedDB check; default to hiding it
  until the check resolves to avoid a flash.
- Render perf: gradients/glow are the risk; must degrade past a creature-count
  threshold and stay a pure frame function (headless runner + determinism tests
  must remain green — they exercise sim, not render, so no test change expected).
- `prefers-reduced-motion` must disable landing preview animation, coachmark
  motion, and creature pulsing.
- Accessibility: keyboard-focusable landing buttons and dock toggles; tooltips
  have accessible labels.
- `boot` source selector must stay backward-compatible: an absent `source`
  preserves today's precedence (saved > coldOpen > founders), so existing
  callers/tests are unaffected. "fresh"/"cold-open" chosen while a save exists will
  overwrite that save on the next autosave rotation — expected; surface it in the
  "fresh" landing copy.
- The "motion-direction cue" (Section 4) reads the frame's existing `heading`
  field (already emitted per creature) — no sim/frame change needed.

## Open Questions

- None. (Art-direction specifics — exact accent, glow intensity — will be tuned
  during execution against the north star.)
