# Query workbench verification, 16 November 2026

Scope: the Storage Query workbench and its integration with Tables. Direction follows the user's Android Studio
reference and Lionscope's existing developer interface. ENERGY 1 / RHYTHM 1 / MOTION 1. Layout reasons and execution
tradeoffs are recorded in [ADR 0003](../adr/0003-add-a-database-query-workbench.md).

## Evidence

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check` and `git diff --check`:
  passed. Lint initially caught a ternary expression used as a statement in a navigation handler; replacing it
  with if/else resolved the finding.

- `npm test -- --maxWorkers=2`: 140 files, 2,384 tests passed. The initial run failed one dashboard assertion that
  still expected protocol 12; it was updated to 13 and the full rerun passed.
- `npm run build:cli`: passed, with Vite's existing large-chunk advisory. CLI version/help and package dry run passed.
- From `android-sdk`, `./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug :ui-helper:test`:
  passed, including debug, release and OkHttp 5. The first full run failed an SDK version assertion that still
  compared the version to V12; the corrected full rerun passed in 7m 26s.
- A later focused run of `:lionscope:testDebugUnitTest` for `*StorageQueryTest`, `*StorageRequestsTest` and
  `*StorageContractTest` passed, including temporary-table shadowing and temporary-trigger deferred-key cases.
- Shared TypeScript/Kotlin fixtures cover SQL classification and v13 query envelopes. SQLite JDBC executes joins,
  CTEs, pagination, exact integers/BLOBs, mutations, constraint rollback and transaction-budget rollback.
- Synthetic browser harness: desktop 1440×900, tablet 768×1024, mobile 430×932 and 320×740. Document width equaled
  viewport width at each measured size; the result grid scrolls internally. Both OS light/dark themes were checked.
- Browser click-through: New Query, database selection, editor, Run, Ctrl+Enter, Next, Previous, History,
  loading a history entry, Clear history, Tables, Back and reopening Query. Unit coverage also exercises selected
  SQL execution, original target binding, write consent, late outcomes and table-draft invalidation.
- Loading disabled navigation and duplicate Run. Empty results, SQLite errors and mutation row counts displayed
  correctly. Browser verification found History shrinking to one pixel under a full result grid; `flex: none`
  fixed it. Hit testing then reached Clear history and the click emptied history without rerunning SQL.
- Keyboard Tab reached the database selector with a visible 2px focus outline. Query buttons/selects measured
  44px tall. Reduced-motion emulation was checked; the Query workbench introduces no animation.
- Measured foreground contrast: secondary text 8.11:1 in light and 8.99:1 in dark; dark result text 15.18:1.
- Browser page errors were empty; console contained Vite/React development notices only. One browser automation
  wait hung during repeated checks and its isolated QA session was restarted; subsequent checks passed.
- Screenshots were inspected locally at `/tmp/lionscope-query-desktop-light.png`,
  `/tmp/lionscope-query-desktop-dark.png`, `/tmp/lionscope-query-mobile-light.png`,
  `/tmp/lionscope-query-mobile-dark.png` and `/tmp/lionscope-query-mobile-320.png`.

The browser harness used synthetic data and was removed after verification. It does not establish SDK behavior
on Android. New Query behavior has not been runtime-verified on a device or any API/Room version.

## Hard Gate

- R-02 PASS: new Query copy and ADR contain no em dash; source text was scanned.
- R-03 PASS: measured document widths 1440, 768, 430 and 320 matched their viewports; grid overflow stays internal.
- R-17 PASS: row counts and timings come from execution outcomes; fixture figures are explicitly synthetic.
- R-18 PASS: no testimonials or customer avatars were added.
- R-23 PASS: the user supplied the Query/navigation reference; no new image or brand assets were created.
- R-24 PASS: Tables and Query buttons switch real mounted views; there are no new destination links.
- R-25 PASS: measured normal text contrast exceeds 4.5:1 in both themes.
- R-26 PASS: every new control has working handlers; browser and component tests exercise their actions.
- R-27 PASS: initial, running, empty, error, success and timeout/late-result states are implemented and tested.
- R-28 PASS: no FAQ was added.
- R-32 PASS: native controls, Ctrl/Command+Enter execution and explicit visible focus styles support keyboard use.
- R-33 PASS: source/CSS edits used apply_patch; Prettier only formatted the resulting source.
- R-34 PASS: inspected light/dark screenshots use the existing theme tokens.
- R-35 PASS: production CLI/dashboard build passed and browser interaction evidence is listed above.
- R-36 PASS: runtime limitations are explicit; there are no new unmeasured performance or security claims.
- R-37 PASS: workbench direction and 1/1/1 dials were declared before UI implementation and recorded in ADR 0003.
- R-38 PASS: synthetic browser data is labeled as verification data and is absent from production UI source.
- R-39 PASS: labeled native fields/buttons, pointer/disabled cursors and focus styles are present; no motion was added.
- R-40 PASS: no media or third-party scripts were added; existing fonts/tokens are reused.

## Purpose Gate

- R-01 PASS: no gradients or glows were added.
- R-04 PASS: text labels identify Query actions; no decorative icon set was added.
- R-06 PASS: IBM Plex Mono distinguishes executable SQL and exact result values, as recorded in ADR 0003.
- R-07 PASS: the grid represents actual database results; there is no decorative background grid.
- R-08 PASS: controls use action labels without decorative arrows.
- R-09 PASS: no badges or capsules were added.
- R-10 PASS: no glass effects were added.
- R-12 PASS: the workbench uses separators rather than elevated cards or shadows.
- R-13 PASS: no glow effects were added.
- R-14 PASS: there are no feature-card templates; editor, toolbar and results follow the execution task.
- R-19 PASS: no new animations; MOTION 1 remains consistent with the existing interface.
- R-22 PASS: no illustration was added.

## Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 1 / MOTION 1 are explicit in the design record.
- Consistency PASS: compact controls and stable layout match a low-motion developer workbench.
- Focal point PASS: the SQL editor and primary Run button lead the execution task.
- Whitespace PASS: distinct editor, toolbar and results bands separate preparation, execution and inspection.
- Accent PASS: the existing brand color marks the active workbench tab.
- Identity PASS: existing IBM Plex typography, exact-value grid and thin separators retain Lionscope's interface.
- Design Read PASS: the supplied reference and existing-product direction were declared before generation.

## Craftsmanship and quality

- C-1 PASS: layout, typography, spacing and accent choices each have a purpose in ADR 0003.
- C-2 PASS: control click-through and regression tests verify actual actions.
- C-3 PASS: every band serves query preparation, execution or result inspection.
- C-4 PASS: light/dark, narrow/wide, keyboard, loading, empty and error states were checked.
- C-5 PASS: verification distinguishes synthetic browser/JDBC evidence from Android runtime proof.
- R-05 PASS: the layout follows the database task; no marketing page structure was added.
- R-11 PASS: native rectangular fields and existing button radii are retained; there are no pill controls.
- R-15 PASS: Run, Tables, History, Clear history, Previous and Next name concrete actions.
- R-16 PASS: Query copy contains no marketing buzzwords.
- R-20 PASS: the result grid, app-link lifetime and existing typography remain specific to Lionscope's debugging UI.
- R-21 PASS: the existing OS theme preference remains authoritative; both themes were verified.
- R-29 PASS: existing neutral surfaces, semantic text and one active-tab accent are reused.
- R-30 PASS: the requested database workflow is implemented with Lionscope components and tokens.
- R-31 PASS: one-line layout and interaction reasons are documented in ADR 0003.
