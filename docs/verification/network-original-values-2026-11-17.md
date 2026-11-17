# Original Network values and Copy cURL, 17 November 2026

This report records verification of the combined local workspace before the PR split. Commit `1e4127f`
preserves the Network implementation from `550e593`; its Android and protocol trees are identical. The
background CLI is reviewed separately and is absent from this PR. Full-suite counts below include that earlier
combined workspace; the Network PR also records checks rerun on its isolated branch.

The user approved original Network data for debug inspection, including authentication. Negotiated device
protocol 14 preserves captured URLs, headers, text bodies and failure messages on the SDK and server. Links
below 14 retain credential redaction. SDK link proof, session gating, wire validation, capture limits,
in-memory retention and the AI body opt-in remain enforced. Logcat, crash and saved-state redaction are separate.

Copy cURL uses the complete request detail and preserves literal POSIX-shell arguments, repeated/empty headers
and UTF-8 body text. The command does not execute automatically. Missing, legacy or incomplete captures explain
why copying is unavailable. cURL supplies transport framing; the command replays captured interceptor data,
not TLS configuration or headers added later in OkHttp. See [Network](../features/network.md).

## Evidence and limits

- Protocol golden fixtures cover original auth/body values, completeness metadata and a version-14 welcome
  with its link proof. Existing legacy fixtures remain covered.
- Server tests cover raw request/response/error values, legacy redaction, byte-budget pruning, summary size,
  negotiated-version enforcement and rejection before link proof. Agent body opt-in remains covered by the suite.
- A generated cURL command was executed only against a synthetic HTTP listener on `127.0.0.1`. Assertions
  compare method, path/query, authentication/cookie headers, repeated and empty headers, and exact body bytes.
  Test strings include single quotes, shell substitutions, backticks, CR/LF, UTF-8 and a leading `@`.
- Dashboard tests cover the full detail URL rather than its shortened summary, clipboard success and refusal,
  and unavailable captures. Chromium checks Copy cURL using Enter, visible original auth, accessible disabled
  reasons, button bounds, 44 px touch targets and page overflow in six configurations. Screenshots were inspected
  for desktop light/dark and 320 px dark touch, including unavailable request details.
- Android JVM tests exercise the real OkHttp interceptor, MockWebServer and link queue on protocol 14, alongside
  legacy redaction tests. Encoder tests cover size/control bounds and incomplete request metadata. APK compilation
  and JVM tests do not establish Android device runtime behavior. The active Consumer app/session was not replaced.

Browser configurations: mouse light/dark at 1440 x 900, touch phones at 430 x 932 and 320 x 740, tablet touch at
768 x 1024 and wide touch at 1440 x 900. Fixtures use real components and explicitly synthetic data. Screenshot
artifacts are under ignored `test-results/ui/`; `npm run test:ui:report` opens the report. Browser clipboard writes
are stubbed to inspect content without putting test credentials on the host clipboard. The macOS clipboard
permission prompt itself was not tested.

## Checks

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run docs:check` and `git diff --check`: passed.
- `npm test -- --maxWorkers=2`: 2,419 tests passed across 143 files.
- `npm run test:ui`: all 42 cases passed. After the conditional-expression cleanup, the focused
  `npm run test:ui -- --grep 'Network|incomplete'` run passed all 18 cases; 105 focused TypeScript tests also passed.
- `npm run build:cli`: passed; `node cli/dist/lionscope.mjs --version` returned `0.12.0`. Synthetic browser fixture
  title/host markers were absent from the production JavaScript bundles.
- With JDK 17 and Android SDK configured, from `android-sdk/`:
  `./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug :ui-helper:test` passed.
  Debug, release and OkHttp 5 each ran 645 tests with no failures. No-op assembly and UI-helper tests passed.
- After removing a redundant private failure-helper argument,
  `./gradlew :lionscope:testDebugUnitTest --tests '*HttpMessagesTest' --tests '*OkHttpCaptureTest' --tests '*DeviceMessagesTest' --tests '*GatewayNetworkMessagesTest' :sample:assembleDebug`
  passed all 57 focused tests on the final SDK source, including the rebuilt sample APK.

Earlier runs found and resolved:

1. A new SDK test tried to access a private interceptor class; it now constructs the encoder's failure input
   directly, while a separate interceptor test verifies the runtime path.
2. Three TypeScript assertions assumed protocol 13 or the previous fixture count. The version assertions and
   byte-for-byte gateway fixture test were updated; legacy fixture ingestion also checks redaction of a v14-shaped
   request arriving on a v7 link.
3. Android fixture-count assertions and legacy error-message length failed. Snapshotting the bounded original
   failure and applying redaction before the legacy 160-character limit on the link thread preserves that behavior.
   The larger temporary failure snapshot is included in queue size accounting.
4. A fixture-editing script split an existing literal Unicode line separator into an NDJSON newline. The resulting
   two Android golden-parser failures were traced to that edit. The original fixture bytes were restored and only
   the new welcome line appended. Subsequent edits preserve NDJSON byte boundaries.

The browser build retains the existing large-chunk advisory. These checks do not measure a new performance
baseline or verify a hosted CI run, an installed Consumer build, Windows shells or an actual device.

## Hard Gate

- R-02 PASS: new UI copy uses concrete sentences without em dashes.
- R-03 PASS: browser assertions check action bounds, overlap and document width at all six configurations.
- R-17 PASS: the fixture is explicitly synthetic; no product performance number is claimed.
- R-18 PASS: no testimonials or avatars were added.
- R-23 PASS: the user explicitly approved original Network data; screenshots contain synthetic credentials.
- R-24 PASS: Copy cURL writes the formatted request; clipboard refusal produces feedback.
- R-25 PASS: existing ink, surface, rule and focus tokens are reused; light/dark screenshots were inspected.
- R-26 PASS: native buttons have labels, disabled states and measured touch bounds.
- R-27 PASS: complete, loading, gone, truncated and legacy request states are exercised.
- R-28 PASS: no FAQ was added.
- R-32 PASS: the copy action is exercised with keyboard focus and Enter.
- R-33 PASS: UI source changes used apply_patch and Prettier.
- R-34 PASS: desktop and narrow light/dark browser artifacts were reviewed.
- R-35 PASS: the real component runs in Chromium and the production CLI builds.
- R-36 PASS: device, clipboard, CI and performance evidence limits are stated above.
- R-37 PASS: DESIGN.md's compact workbench direction preceded implementation.
- R-38 PASS: no real credentials, invented customer claims or fictional product statistics were used.
- R-39 PASS: native controls preserve names and focus; disabled reasons use visible text and aria-describedby.
- R-40 PASS: no production media or third-party script was added; no new benchmark claim is made.

## Purpose Gate

- R-01 PASS: no gradient or glow was introduced.
- R-04 PASS: the existing copy/check glyphs communicate the copy action and result.
- R-06 PASS: existing IBM Plex type separates values from controls.
- R-07 PASS: existing separators retain the request/header hierarchy; no decorative grid was added.
- R-08 PASS: no decorative arrows were added.
- R-09 PASS: no new badge was introduced.
- R-10 PASS: no glass effect was introduced.
- R-12 PASS: no new elevation or shadow was introduced.
- R-13 PASS: no glow effect was introduced.
- R-14 PASS: actions remain grouped with the selected request rather than becoming cards.
- R-19 PASS: no new motion was introduced; screenshots disable animation.
- R-22 PASS: no illustration was added.

## Liveliness

- Dials PASS: ENERGY 1 / RHYTHM 1 / MOTION 1 follow DESIGN.md.
- Consistency PASS: existing workbench tokens and copy controls are reused.
- Focal point PASS: the selected request and its original data remain the focus.
- Whitespace PASS: actions wrap beneath the title at a 520 px container width; existing spacing tokens apply.
- Accent PASS: existing status and focus accents retain their functional roles.
- Identity PASS: compact request facts, header rows and IBM Plex values retain Lionscope's identity.
- Design Read PASS: the affected action row, request hierarchy and narrow container constraints were identified first.

## Craftsmanship and quality

- C-1 PASS: the new control and its reflow map to the copy task and DESIGN.md.
- C-2 PASS: successful and refused clipboard writes have visible feedback.
- C-3 PASS: the only new production action serves captured-request replay.
- C-4 PASS: the browser matrix covers both themes, keyboard, mouse, touch and unavailable states.
- C-5 PASS: synthetic evidence and runtime limits are explicit.
- R-05 PASS: no new page template was introduced.
- R-11 PASS: existing button radii are reused.
- R-15 PASS: Copy cURL names the action directly.
- R-16 PASS: no marketing copy was added.
- R-20 PASS: the control belongs to Lionscope's real Network workflow.
- R-21 PASS: light and dark modes remain available.
- R-29 PASS: no new palette was introduced.
- R-30 PASS: no external product design was copied.
- R-31 PASS: container reflow and control reuse are documented in DESIGN.md.
