# Development

```bash
npm install
npm run dev              # server (tsx watch, --dev allows the Vite origin) + Vite on http://localhost:5173
npm test                 # all unit tests (protocol, server, dashboard)
npm run test:coverage
npm run typecheck
npm run lint
npm run format:check     # or `npm run format` to fix
npm run build            # production dashboard build
npm run build:cli        # the npm package in cli/ (dashboard + bundled server); `cd cli && npm pack` to try it
```

Android SDK (JDK 17 and the Android SDK required):

```bash
cd android-sdk
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug
./gradlew :lionscope:publishToMavenLocal :lionscope-noop:publishToMavenLocal   # same coordinates as JitPack
```

The published version comes from the `lionscopeVersion` Gradle property (default `0.12.0`); on JitPack it is
the git tag. See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to contribute.
