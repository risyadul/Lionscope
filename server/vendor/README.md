# Vendored binaries

`scrcpy-server-v5.0.1` is the device-side server of [scrcpy](https://github.com/Genymobile/scrcpy) v5.0.1
(Apache-2.0, © Genymobile and contributors), downloaded unmodified from the
[official release](https://github.com/Genymobile/scrcpy/releases/tag/v5.0.1). Lionscope pushes it to a physical
device over adb to mirror and operate the device's screen; it is removed again when mirroring stops.

`scrcpy-server-v5.0.1.sha256` is the line for this file from the release's `SHA256SUMS.txt`. The server checks
the file against it before pushing. Verify by hand with `shasum -a 256 -c scrcpy-server-v5.0.1.sha256`.
