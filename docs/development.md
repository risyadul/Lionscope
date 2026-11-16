# Development

```bash
npm install
npm run dev              # server (tsx watch, --dev allows the Vite origin) + Vite on http://localhost:5173
npm test                 # all unit tests (protocol, server, dashboard)
npm run test:ui          # Chromium dashboard layout contracts (install the browser below first)
npm run test:coverage
npm run typecheck
npm run lint
npm run format:check     # or `npm run format` to fix
npm run build            # production dashboard build
npm run build:cli        # the npm package in cli/ (dashboard + bundled server); `cd cli && npm pack` to try it
```

## Dashboard layout checks

Read [DESIGN.md](../DESIGN.md) before changing dashboard layout, controls or responsive behavior. Install the
test browser once after `npm ci`, then run the browser suite:

```bash
npx playwright install chromium
npm run test:ui
npm run test:ui -- --project mouse-dark --grep "row drafts"
npm run test:ui:report
```

The suite starts a separate Vite fixture server on `127.0.0.1:4178` and stops it afterward. That port must be
free. Fixtures render real dashboard components with synthetic Storage responses and metric samples; no ADB,
SDK, profiling server or private app data is needed. They are outside the production dashboard entry point.

Six Chromium configurations cover light/dark themes, 320/430 px phones, a 768 px touch layout and 1440 px
mouse/touch layouts. Assertions measure input height, chevron inset, source hierarchy, metric containment and
mirror visibility. Panel widths are varied independently of viewport width. Screenshots support human review;
this is a geometry regression suite, not a pixel-baseline comparison. Add cases when changing a component's
layout or state contract.

The HTML report includes review screenshots; failures also retain a trace and screenshot. Artifacts live in
ignored `playwright-report/` and `test-results/ui/`. CI runs the suite and uploads these artifacts for seven
days. Browser emulation checks dashboard rendering and does not establish Android SDK/device compatibility.

## Android SDK

Android SDK (JDK 17 and the Android SDK required):

```bash
cd android-sdk
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug
./gradlew :lionscope:publishToMavenLocal :lionscope-noop:publishToMavenLocal   # same coordinates as JitPack
```

The published version comes from the `lionscopeVersion` Gradle property (default `0.12.0`); on JitPack it is
the git tag. See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to contribute.
