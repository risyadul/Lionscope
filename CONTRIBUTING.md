# Contributing to Lionscope

Thanks for helping. Bug reports, fixes and focused improvements are welcome; for larger changes, please open an
issue first so we can agree on the approach.

## Development setup

- Node.js ≥ 22.12 and `adb` (Android SDK platform-tools)
- For the Android SDK: JDK 17 and an Android SDK with platform 36

```bash
npm install
npm run dev        # server + dashboard with hot reload (http://localhost:5173)
```

## Before opening a pull request

Run the same checks as CI:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && npm run build

cd android-sdk
./gradlew :lionscope:test :lionscope-noop:assemble :sample:assembleDebug
```

- Add or update tests with every behaviour change (Vitest for TypeScript, JUnit for the SDK).
- If you change a message between the SDK and the server, update `protocol/src/wire.ts`, the validator in
  `protocol/src/index.ts` and the golden lines in `protocol/fixtures/device-messages.ndjson`; both the Kotlin and
  the TypeScript tests read that file.
- Test fixtures must not contain data from real private apps or devices; use neutral names such as
  `com.example.shop`.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes:

```
feat: add memory breakdown for graphics
fix: keep frames whose only flag bit is a vendor bit
docs: explain the screen alias convention
```

Other prefixes: `refactor:`, `test:`, `chore:`, `perf:`, `ci:`.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
