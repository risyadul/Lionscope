# Dashboard layout contract, 16 November 2026

The approved follow-up makes the recent UI fixes repeatable: a root [design contract](../../DESIGN.md), an
AGENTS.md entry point, permanent browser regressions and CI artifacts. It preserves the compact debugging
workbench direction: ENERGY 1 / RHYTHM 1 / MOTION 1. Product behavior and palette are unchanged. The only
production-source edit is a token comment describing the existing brand-color usage accurately.

## Evidence and limits

`npm run test:ui` runs five cases in six Chromium configurations: mouse light/dark at 1440 x 900, touch phones
at 430 x 932 and 320 x 740, a touch tablet at 768 x 1024 and wide touch at 1440 x 900. Each page gets an isolated
synthetic store. Fixtures import the real StoragePanel, StatStrip, DeviceColumn and useDeviceColumn; no device,
SDK connection or private app data is used. The separate fixture server owns port 4178 and exits after the run.

- Row editing checks multiple drafts, integer/primary-key and text field dimensions, focus, Apply/Discard and
  footer position. Screenshots include the open drafts, not just the final state.
- Query checks the long database value, 10 px chevron inset, reserved text padding, control density, Tab focus,
  native option changes, Run, pagination, empty results and an SQL error. Option selection uses Playwright's
  native-select API; the suite does not automate the OS menu's individual keyboard choices.
- Sources check long-name titles, one-line labels, row height, nesting, selected state and read-only reasons.
- StatStrip checks two warning flags, container-based column counts and value/flag bounds at requested panel
  widths 240, 320, 430, 680 and 800 px. Narrow viewports constrain those widths to their available space.
- Mirror checks exercise initially shown Storage/Network, independent hide choices, reopen and Escape.

Screenshots were inspected for desktop light row drafts, 320 px dark row drafts, desktop dark long selector,
320 px dark Query results, tablet light source navigation and the 240 px dark metric panel. They live under
ignored `test-results/ui/`; `npm run test:ui:report` opens the linked HTML report. Geometry assertions are the
automated gate; screenshots support review and are not pixel-diff baselines. Tests also reject browser console
and page errors. This covers the listed components, not every dashboard screen or Android runtime behavior.

The initial matrix had 27 passes and three failed select-value assertions: ArrowDown/Enter did not choose the
second native option in desktop Chromium. Replacing ArrowDown with End still failed the same three cases.
The final test uses native option selection and checks keyboard focus separately; no production fix was
needed. The completed matrix passes all 30 cases. An initial formatting command included ignore files, for
which Prettier has no parser; the repository formatting check subsequently passed.

Checks: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check`,
`npm test -- --maxWorkers=2` (2,389 tests, 140 files), `npm run test:ui`, `npm run build:cli` and
`git diff --check` passed. The build retains its existing large-chunk advisory. A search of dashboard and CLI
build outputs found none of the fixture title/database markers. CI is configured to install Chromium, run
the suite and retain reports/screenshots for seven days; the hosted workflow has not run as part of this
local verification.

## Hard Gate

- R-02 PASS: new fixture copy and design rules use no em dash.
- R-03 PASS: six browser configurations check document width and affected component bounds.
- R-17 PASS: metric samples are explicitly labeled synthetic, not product performance claims.
- R-18 PASS: no testimonials or avatars were added.
- R-23 PASS: the user approved the contract and regression work; fixture emulator content is labeled synthetic.
- R-24 PASS: fixture workspace buttons switch between the implemented Storage/Network fixture states.
- R-25 PASS: fixtures reuse the existing verified text/surface tokens without introducing a color pairing.
- R-26 PASS: row edits, Query actions and mirror controls have recorded automated interactions.
- R-27 PASS: Query populated/empty/error states are exercised; existing unit tests cover loading/outcomes.
- R-28 PASS: no FAQ was added.
- R-32 PASS: tests check input focus, select-to-button Tab focus and mirror Escape dismissal.
- R-33 PASS: edits used apply_patch and Prettier; no external source-replacement script was used.
- R-34 PASS: light and dark screenshot artifacts were inspected.
- R-35 PASS: the fixture ran in Chromium, tested its actions and the production CLI built successfully.
- R-36 PASS: the report distinguishes synthetic browser evidence from hosted CI and Android evidence.
- R-37 PASS: the approved workbench direction and concrete screenshot defects preceded this scope.
- R-38 PASS: fixture content is visibly synthetic and absent from production output markers.
- R-39 PASS: fixture buttons retain native semantics; HTML has language, title, viewport and landmarks.
- R-40 PASS: no production media or external script was added; the fixture placeholder has a bounded panel.

## Purpose Gate

- R-01 PASS: no gradients or glows were added.
- R-04 PASS: existing source and chevron glyphs represent source types and dropdown behavior.
- R-06 PASS: fixtures load the same IBM Plex fonts as production so measurements match the workbench.
- R-07 PASS: separators describe source and panel boundaries; no decorative grid was added.
- R-08 PASS: existing chevrons remain functional affordances under measurement.
- R-09 PASS: warning badges represent explicitly synthetic metric conditions for overflow testing.
- R-10 PASS: no glass effects were added.
- R-12 PASS: fixture styling introduces no elevation or large shadows.
- R-13 PASS: no glow effects were added.
- R-14 PASS: fixtures preserve source nesting and metric structure from real components.
- R-19 PASS: no animation was added; tests use reduced motion and disable animation during screenshots.
- R-22 PASS: no illustrations were created.

## Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 1 / MOTION 1 are explicit in DESIGN.md and this report.
- Consistency PASS: fixtures retain the existing compact data workbench components.
- Focal point PASS: screenshots target edited values, the selected source or warning metrics.
- Whitespace PASS: the contract assigns control, data and panel spacing distinct purposes.
- Accent PASS: existing brand/navigation and semantic warning accents are retained.
- Identity PASS: the fixtures preserve Lionscope's typography and data hierarchy.
- Design Read PASS: the previous screenshot fixes determine the acceptance cases.

## Craftsmanship and quality

- C-1 PASS: each assertion maps to a documented layout or interaction contract.
- C-2 PASS: tested edits, pagination, option changes and mirror choices produce visible state changes.
- C-3 PASS: fixture sections exist to reproduce workbench constraints, including the device column.
- C-4 PASS: browser cases cover mouse/touch, narrow panels, both themes and keyboard focus/dismissal.
- C-5 PASS: test data and evidence limits are stated explicitly.
- R-05 PASS: real debugging components are reused without a new page template.
- R-11 PASS: fixture controls reuse existing button/input radii.
- R-15 PASS: existing concrete action labels are retained.
- R-16 PASS: no marketing copy was added.
- R-20 PASS: fixtures preserve actual Storage and profiler concepts.
- R-21 PASS: each project's theme follows an explicit browser color scheme.
- R-29 PASS: the existing palette is reused.
- R-30 PASS: no external product design was introduced.
- R-31 PASS: DESIGN.md explains control density, chevron spacing, source grouping and panel reflow.
