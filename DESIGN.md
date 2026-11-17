# Lionscope dashboard design contract

Lionscope is a compact debugging workbench. Data, the selected app and the consequences of an action stay
visible together. Keep the approved instrument-panel direction: graphite surfaces, thin separators, IBM Plex
Sans for controls and prose, IBM Plex Mono for identifiers and exact values. ENERGY 1 / RHYTHM 1 / MOTION 1.

Read this before changing dashboard layout, controls, typography, themes or responsive behavior. Existing
components and [tokens](dashboard/src/styles/tokens.css) are the implementation reference. Deliberate changes
to these contracts need an updated rule and a reason in the same scope as their implementation and checks.

## Workflow

1. Identify the affected components and their available panel widths, including the device mirror.
2. Reuse an existing control and token before adding a variant. Record the purpose of a new variant.
3. Check the relevant states in a real browser and run the layout regressions documented in
   [Development](docs/development.md). Unit tests cover state and data; browser checks cover rendered geometry.
4. Report the checked states, viewports and outcomes. Update the relevant fixtures when a behavior changes.

## Density and type

These metrics describe the approved Storage workbench; they are not global replacements for every existing
control. Preserve other components' documented metrics until deliberately changing them.

| Element                              | Mouse layout                      | Narrow window or coarse pointer             | Purpose                                           |
| ------------------------------------ | --------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Shared primary buttons               | 30 px baseline                    | 44 px for touched action controls           | Compact desktop actions with usable touch targets |
| Storage row draft input              | 30 px                             | 44 px, 16 px input text                     | A single-line field stays a single-line field     |
| Storage Query tabs                   | 32 px                             | 44 px                                       | Clear local navigation without oversized chrome   |
| Query select/buttons and source rows | 30 px                             | 44 px                                       | Consistent control density within Storage         |
| Query editor                         | 120 px initial minimum; resizable | Same minimum; 16 px input text below 640 px | Give results room while allowing longer SQL       |
| Query result cells                   | 4 px block / 8 px inline padding  | Same compact read-only grid                 | Keep more rows visible                            |
| Table inspector rows                 | Existing 32 px baseline           | Preserve its selection/editor workflow      | Separate browsing density from input sizing       |

Touch-sized Storage controls apply below 640 px or when `any-pointer: coarse` matches, including wide touch
devices. New interactive controls need explicit desktop and touch sizing. Read-only data cells need not grow
to the same size as buttons. Keep existing body/meta type sizes; do not shrink text to hide overflow.

Spacing uses `--space-1` through `--space-6`: 4, 8, 12, 16, 24 and 32 px. Use 4/8 px for dense controls and
data rows, 12/16 px for panel boundaries and 24/32 px for larger structural separation. Keep input, label and
supporting text grouped; reserve larger gaps for a change in hierarchy.

## Shared controls and editors

- Use [Select](dashboard/src/components/ui/Select.tsx) for a native select with a dashboard chevron. Keep its
  keyboard/menu behavior, 10 px trailing chevron inset and at least 28 px trailing text space. The wrapper and
  select must share a width so the arrow stays attached to the field, including for long selected values.
- Label editable values visibly and keep the full accessible name. Reuse existing button and focus styles.
- Declare flex axes and sizing together. A width-oriented flex basis must not become an input height when a
  form changes to a column. Row draft inputs opt out of flex growth and use the field's available width.
- Keep Apply/Discard reachable while the field area scrolls. Editing several columns must not expand the
  editor into a series of large blank fields. Exact values and conditional editing retain their existing
  [Storage contract](docs/features/storage.md#editing).

## Data hierarchy and long content

- Separate Preferences and Databases into labeled groups. Nest table rows under their database using
  indentation and a connecting rule; use the existing file/database/table icons to distinguish source types.
- Give source entries their own row and separator. Source names stay on one line with ellipsis; full names
  remain in accessible names and native tooltips. A long filename must not merge visually with the next item.
- Selected sources have an explicit current state. Read-only sources remain browsable and expose an explicit
  read-only description; a lock alone is not the entire explanation.
- Result grids scroll internally. The page itself must fit its viewport. Keep table headers, data and
  pagination aligned; allow the result area to use the remaining workbench height.

## Panels and responsive behavior

Size a component against the space it actually receives. A wide window can still contain a narrow panel
because navigation, the emulator and a row editor are visible together.

- StatStrip reflows by its container width: six columns above 760 px, three from 421 through 760 px and two at
  420 px or below. Values and warning flags stay inside their metric. Warning text may wrap; it must not paint
  into the next metric or neighboring panel.
- Preserve Storage's source/grid/editor hierarchy on wide layouts. Below the existing 1200 px breakpoint,
  the editor is a sheet; below 640 px, sources stack above the data. Scroll the source list and field body
  independently without covering the action footer.
- Network and Storage start with the emulator shown and retain independent hide/show choices for the page.
  On narrow windows the device is a closable overlay. Preserve the behavior in
  [ADR 0002](docs/adr/0002-organize-navigation-by-debugging-workflow.md#navigation-and-context).
- Network detail actions wrap and move below the request title when their container is 520 px or narrower.
  Copy cURL reuses the shared copy control, with a visible, accessible reason when unavailable; action targets
  are at least 44 px below 640 px or with a coarse pointer.
- Keep empty, loading, error, disabled and success states readable at the same panel widths as populated data.

## Themes and interaction

Use the existing light/dark surface, text and semantic tokens. Brand marks and selected navigation use the
brand color; performance and errors use their semantic colors. New text pairings need measured contrast of
at least 4.5:1 for ordinary text. Existing verified colors do not need a second palette.

Retain native semantics, visible focus, pointer/disabled affordances and keyboard activation. Overlays close
with Escape and restore a useful focus target. New motion must serve state feedback and respect reduced
motion. A visually complete component includes its working actions and failure states.

## Browser acceptance cases

For changes to the components below, keep the matching browser checks meaningful:

- **Row editor:** multiple drafts at once, including an integer/primary key and text; correct field height,
  contained input width, Apply/Discard, a scrolling field area and a reachable footer.
- **Query select:** a long database name, inset chevron, reserved text space, native keyboard selection and
  both compact/touch densities.
- **Source list:** multiple long preference names, database/table nesting, separate row bounds, full titles,
  current selection and a read-only explanation.
- **StatStrip:** warning flags and values contained at narrow panel widths while the viewport stays wide;
  include 240, 320, 430, 680 and 800 px panels.
- **Device mirror:** initially shown in Storage/Network, independently hideable, with a closable narrow overlay.

Cover both themes, 320/430 px narrow layouts, a 768 px touch layout and 1440 px mouse/touch layouts. Browser
screenshots support review; geometric assertions enforce the bounds independently of OS font rasterization.
Add a focused case when changing a component's sizing/state contract, and document intentional exceptions.
