# QluePrint design system

The design language is **Obsidian Flow**: a quiet, dense developer tool where the chrome stays neutral and colour carries meaning. This file describes what the app ships today. The sources of truth are `apps/desktop/src/index.css` (tokens), `apps/desktop/src/components/ui/` (components), `apps/desktop/src/lib/spring.tsx` (motion) and the prototype `docs/design/QluePrint.dc.html`. The product spec's §4 sets the intent.

## Principles

- **Quiet chrome, rich content.** Backgrounds, borders and text are cool neutrals. Colour appears where it means something: the primary action, a selection, a status, syntax.
- **One accent.** Electric blue marks the primary action, the current selection and focus. Semantic colours (success, warning, danger, info) only carry meaning.
- **Dense, aligned, calm.** Small type, tight rows, everything on a 4 px rhythm, nothing that glows, pulses or bounces for decoration.
- **Both themes are first class.** Every token has a dark and a light value; dark is the default.
- **Keyboard and accessibility built in.** Visible focus rings, real labels, reduced motion honoured everywhere.

## Colour

All colours are OKLCH. The theme is set as `data-theme` on `<html>` (`light`, `dark`, or `system`, which follows the OS). Use the Tailwind names (`bg-surface`, `text-fg3`, `border-border-soft`…), never raw values.

### Surfaces

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `oklch(0.17 0.006 265)` | `oklch(0.972 0.002 265)` | App background |
| `--chrome` | `oklch(0.185 0.006 265)` | `oklch(0.985 0.002 265)` | Top bar, rail |
| `--panel` | `oklch(0.185 0.006 265)` | `oklch(0.985 0.002 265)` | Sidebar, inspector |
| `--editor-bg` | `oklch(0.205 0.006 265)` | `oklch(1 0 0)` | SQL editor |
| `--surface` | `oklch(0.205 0.006 265)` | `oklch(1 0 0)` | Results, cards |
| `--elev` | `oklch(0.235 0.007 265)` | `oklch(1 0 0)` | Popovers, menus, dialogs |
| `--muted` | `oklch(0.255 0.008 265)` | `oklch(0.948 0.004 265)` | Quiet fills, ghost-button hover |
| `--hover` | `oklch(1 0 0 / 0.045)` | `oklch(0.2 0.01 265 / 0.045)` | Row and item hover |
| `--header-bg` | `oklch(0.22 0.007 265)` | `oklch(0.968 0.003 265)` | Grid header |
| `--scrim` | `oklch(0.1 0.005 265 / 0.55)` | `oklch(0.3 0.01 265 / 0.22)` | Behind dialogs |

### Lines

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--border` | `oklch(0.32 0.008 265)` | `oklch(0.88 0.005 265)` | Inputs, strong dividers |
| `--border-soft` | `oklch(0.26 0.007 265)` | `oklch(0.925 0.004 265)` | Section dividers, bars |

### Text: four roles

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--fg` | `oklch(0.95 0.003 265)` | `oklch(0.23 0.01 265)` | Primary text |
| `--fg2` | `oklch(0.77 0.008 265)` | `oklch(0.42 0.012 265)` | Secondary text, values |
| `--fg3` | `oklch(0.62 0.01 265)` | `oklch(0.54 0.012 265)` | Labels, icons, hints |
| `--fg4` | `oklch(0.46 0.01 265)` | `oklch(0.7 0.008 265)` | Counts, meta, placeholders, NULL |

### Accent

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--primary` | `oklch(0.62 0.17 258)` | `oklch(0.54 0.2 260)` | Primary button, selection, active tab |
| `--primary-hover` | `oklch(0.67 0.16 258)` | `oklch(0.49 0.2 260)` | Its hover |
| `--primary-fg` | `oklch(0.99 0 0)` | `oklch(0.99 0 0)` | Text on primary |
| `--primary-soft` | `oklch(0.64 0.17 258 / 0.16)` | `oklch(0.55 0.2 260 / 0.1)` | Selected row background |
| `--primary-text` | `oklch(0.77 0.12 258)` | `oklch(0.5 0.19 260)` | Accent used as text |
| `--focus` | `oklch(0.64 0.17 258 / 0.45)` | `oklch(0.55 0.2 260 / 0.35)` | Focus ring |
| `--sel` | `oklch(0.64 0.17 258 / 0.2)` | `oklch(0.55 0.2 260 / 0.12)` | Text and cell selection |

### Status

Each has a solid value and a `-soft` background (`--success-soft`…).

| Token | Dark | Light | Means |
| --- | --- | --- | --- |
| `--success` | `oklch(0.74 0.15 155)` | `oklch(0.55 0.14 155)` | Connected, saved, OK |
| `--warning` | `oklch(0.8 0.14 80)` | `oklch(0.6 0.14 65)` | Unsaved changes, connecting |
| `--danger` | `oklch(0.7 0.17 25)` | `oklch(0.55 0.2 25)` | Errors, destructive actions |
| `--info` | `oklch(0.76 0.11 230)` | `oklch(0.52 0.12 230)` | Neutral notices |

### SQL syntax

| Token | Dark | Light |
| --- | --- | --- |
| `--syn-kw` keyword | `oklch(0.75 0.13 260)` | `oklch(0.5 0.19 260)` |
| `--syn-fn` function | `oklch(0.79 0.11 300)` | `oklch(0.5 0.16 310)` |
| `--syn-str` string | `oklch(0.8 0.12 150)` | `oklch(0.5 0.13 150)` |
| `--syn-num` number | `oklch(0.82 0.12 65)` | `oklch(0.55 0.14 50)` |
| `--syn-com` comment | `oklch(0.58 0.012 265)` | `oklch(0.6 0.01 265)` |

Monaco reads these through `src/lib/monaco.ts`.

## Typography

| Family | Font | Use |
| --- | --- | --- |
| Sans | **Geist Variable** | All interface text |
| Mono | **JetBrains Mono Variable** | SQL, data cells, counts, sizes, keycaps, the WHERE bar |

Sizes, smallest to largest, as used:

| Size | Use |
| --- | --- |
| 11 px (`text-[11px]`) | Meta: sizes and counts in the explorer, column types, mono hints |
| 12 px (`text-xs`) | Secondary UI: status bars, field hints, menus' section labels |
| 13 px (`text-[13px]`) | Tabs, tree rows, menu items |
| 14 px (`text-sm`) | Body: dialogs, forms, the welcome screen |
| 16 px (`text-base`) | Dialog titles |

- Weights 400 and 500; 600 only for the product name and rare emphasis.
- Hierarchy comes from size and colour role, not weight.
- Sentence case everywhere. No uppercase tracked labels, no italics for emphasis.
- Numbers in data and counts use `tabular-nums`.
- Typography details: curly quotes and apostrophes (’ “ ”), a real ellipsis (…), middle dot (·) between inline items, no trailing periods on labels and buttons.

## Spacing and sizing

Everything sits on a 4 px grid (2 px nudges inside small controls).

| Element | Height | Notes |
| --- | --- | --- |
| Top bar | 44 px (`h-11`) | Logo, workspace switcher, Changes, theme switch |
| Tab strip | 36 px (`h-9`) | Query and table tabs |
| Panel header | 40 px (`h-10`) | Results / Messages / Plan, WHERE bar |
| Button, default | 32 px (`h-8`) | `sm` 28 px, `xs` 24 px, `lg` 36 px, icon 32 px |
| Tree row, menu item | 28–32 px (`h-7`, `h-8`) | Explorer, workspace menu |
| Grid row | 28 px | Results grid |

- Padding follows density: 12–14 px in bars and panels, 16 px in dialogs and popovers' content.
- Space inside a group is smaller than space between groups.

## Shape and depth

- `--radius` is 0.5 rem (8 px). Controls use `rounded-md`, popovers and dialogs `rounded-lg`/`rounded-xl`, status dots and toggles `rounded-full`.
- Nested radius: an inner radius is the outer minus the padding between them, never under 4 px.
- Depth comes from surface steps and hairline borders. `--shadow` is used only on floating layers (menus, popovers, dialogs): a soft neutral shadow plus a 1 px ring. Nothing glows.

## Iconography

- [Lucide](https://lucide.dev) only, 14 px (`size-3.5`) in rows and bars, 16 px (`size-4`) in larger buttons, default stroke.
- Icons take their text's colour role, usually `text-fg3`; they never get their own colours.
- Database engines use their own logos (`components/shell/engine-logos.tsx`).

## Motion

Physically based springs (`src/lib/spring.tsx`), chosen in View › Motion:

| Choice | Feel | Base spring (stiffness, damping) |
| --- | --- | --- |
| Spring (default) | Slight overshoot | k 340, c 24 |
| Subtle | Critically damped | k 520, c 46 |
| Off | No motion | — |

- `--spring-ease` is rewritten at runtime as a `linear()` curve traced from the chosen spring, so CSS transitions follow it too.
- Off, or the OS asking for reduced motion, sets `data-motion="off"`; the `motion-reduce:` variant then stops animations.
- Animate only colour, opacity and transform, named explicitly (`transition-colors`, `transition-[transform,opacity]`). Never `transition-all`, never animate layout.
- Hover is a quick colour or surface change; a press is a tiny scale-down (`active:scale-97`); menus fade and rise a few pixels.

## Components

Built on shadcn/ui and Radix, restyled with the tokens above (`src/components/ui/`):

`AlertDialog` · `Button` (default, outline, secondary, ghost, destructive, link) · `Calendar` · `ContextMenu` (with submenus and a destructive item) · `Dialog` · `Input` · `Kbd` · `Label` · `Menubar` · `Popover` · `Resizable` · `Select` · `Separator` · `Switch` · `Tabs` (line variant) · `Spinner` and `Skeleton` (`loading.tsx`).

## Patterns

- **Status dot** (`StatusDot`): 6 px — success when open, warning when connecting, danger when failed, `fg4` when closed. On a connection it sits on the engine logo's corner.
- **Spinner**: a 12-spoke, macOS-style activity indicator in the text colour, for work in progress (connecting).
- **Skeletons**: placeholder bars the shape of the coming content (schemas, a table's first rows), with a gentle pulse that stops under reduced motion.
- **Focus**: `focus-visible:ring-2 ring-ring/50` on every control.
- **Selection**: `bg-primary-soft` with `text-primary-text` (the inspected table, the selected cell).
- **Counts and meta**: quiet `text-fg4`, often mono, never pills.
- **Keyboard shortcuts**: `Kbd` keycaps.
- **Destructive actions**: confirmed in an `AlertDialog` that says exactly what happens and what isn't touched.
- **Empty states**: one line saying what goes here and the shortcut to start.

## Brand

The QluePrint logo, icon, colours and wordmark are in [docs/brand](brand/README.md). The blueprint blue `#173f9e` belongs to the logo; the interface's accent is `--primary`.
