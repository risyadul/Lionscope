# Vendored binaries

`scrcpy-server-v5.0.1` is the device-side server of [scrcpy](https://github.com/Genymobile/scrcpy) v5.0.1
(Apache-2.0, © Genymobile and contributors), downloaded unmodified from the
[official release](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1). Lionscope pushes it to a physical
device over adb to mirror and operate the device's screen; it is removed again when mirroring stops.

`scrcpy-server-v5.0.1.sha256` is the line for this file from the release's `SHA256SUMS.txt`. The server checks
the file against it before pushing. Verify by hand with `shasum -a 256 -c scrcpy-server-v5.0.1.sha256`.

`lionscope-ui-helper-v1.jar` is Lionscope's own UI helper (Apache-2.0), built from `android-sdk/ui-helper`: a
long-lived replacement for `uiautomator dump` that the server runs on a device with `app_process` for the agent's
UI tools and the Inspector (it deletes itself from the device once started). Rebuild it, its `.sha256` line and the
checksum built into the server (`server/src/agent/uiHelperJar.ts`) with `cd android-sdk && ./gradlew :ui-helper:vendor`
(pinned to a JDK 17 toolchain and build-tools 36.0.0, so the same sources give the same bytes; CI rebuilds it and
fails when the result differs from the committed jar).
