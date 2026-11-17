# Consumer ID Network setup, 17 November 2026

The local Consumer ID development app now runs with the original-value Network capture from Lionscope commit
`550e593`. The dashboard/server uses the bundled local CLI, and the app negotiates device protocol 14.

## Build and installation

The Consumer checkout is `/Volumes/TopraxSSD/StudioProjects/android-consumer`, HEAD `fe987edbff`, with existing
local integration and business changes. Its interceptor already follows the auth interceptors. No Consumer
source or dependency declaration was changed, and its tracked diff and working-tree status were compared before
and after installation and remained identical. No Consumer changes were staged or committed.

The existing exclusive Maven-local coordinate was retained. From Lionscope's `android-sdk/`, using JDK 17 and
the local Android SDK, this passed:

```sh
./gradlew :lionscope:publishReleasePublicationToMavenLocal \
  :lionscope-noop:publishReleasePublicationToMavenLocal \
  -PlionscopeVersion=0.13.0-pr34-local
```

This replaces the local artifacts at that coordinate with the protocol-14 implementation; it is not a remote
release or an SDK version bump in tracked configuration. AAR SHA-256:
`34eb490d7ebda2b9ebbf6f20b71aca94c7dddeeee952f3ca3ddca1b1f08bdb3d`.

From Consumer, `./gradlew :app:assembleDevelopmentDebug --offline` passed in 1m19s. Its existing Tracker trial
was not enabled by additional Gradle flags. The build emitted Heap/Contentsquare Compose-resolution and ASM
unresolved-class advisories; these were warnings, not a failed build. The runtime checks below establish app
launch and Network capture, not exhaustive validation of those third-party integrations.

The APK at `app/build/outputs/apk/development/debug/app-development-debug.apk` was installed with
`adb -s emulator-5554 install -r`, preserving application data. APK SHA-256:
`e9d093e000c4a5cc75bcc941fa132ea18e630706ec90a1a60cd214d76a306b5a`.

## Runtime evidence

- No Lionscope server or profiling session was active at setup time. The local `lionscope` command started a
  background server at <http://localhost:8701> with device control and the previously used Storage read/write
  capabilities. Agent Network body access remains off.
- Pixel_9 was off and was quick-booted through Lionscope. It became `emulator-5554`, API 36, with host rendering.
- The installed app is `com.lionparcel.services.consumer.dev`, Consumer ID `developmentDebug`, version
  `3.8.4-dev (0)` / `308041`. A new profiling session was started and its launcher opened.
- The SDK connected as `0.13.0-pr34-local`, negotiated **protocol 14**, passed link proof, and reported Network
  active. The initial capture contained 45 exchanges and no mock rules.
- Five recent GET requests returned HTTP 200 and reported `originalValues: true`, `requestComplete: true`.
  Each had an Authorization header without the redaction marker. Verification printed only booleans and IDs,
  never credential values. These captures satisfy Copy cURL's completeness requirements.
- One captured POST with a reported zero-byte body had `requestComplete: false`; copying remains unavailable
  for that incomplete capture. No synthetic replacement, mock or credential refresh was performed.

The server, emulator and Consumer profiling session are intentionally left running for the user's inspection.
Open Network, select a newly captured complete request, inspect Headers and use Copy cURL. The preceding
[feature verification](network-original-values-2026-11-17.md) covers synthetic clipboard and command-replay
tests; this setup did not place real app credentials on the host clipboard or replay real API requests.
