# lionscope

Lightweight Android profiler with a web dashboard. It shows CPU, memory, frame rendering and logcat for one app
on a connected device, on a single shared time axis, without opening Android Studio.

```bash
npx lionscope@latest
# open http://localhost:8701, pick the device and the app, press Start
```

`@latest` makes npx check for a new release; a bare `npx lionscope` can keep running a version it cached
earlier.

Requirements: Node.js ≥ 22.12, Android SDK platform-tools (`adb`), and a device or emulator with USB debugging
on Android 7.0 (API 24) or newer. Everything listens on 127.0.0.1 only.

```text
Options:
  --port <port>         Dashboard port (LIONSCOPE_PORT, default 8701)
  --device-port <port>  In-app SDK gateway port (LIONSCOPE_DEVICE_PORT, default 8700)
  --adb <path>          adb binary (LIONSCOPE_ADB; default: $ANDROID_HOME, the usual SDK location, then PATH)
  -h, --help            Show this help
  -v, --version         Print the version
```

Nothing needs to be installed on the device. For screen names and per-frame `FrameMetrics`, add the optional
debug-only SDK to the app (`debugImplementation "com.github.risyadul.Lionscope:lionscope:0.3.0"` from JitPack).

Documentation, the SDK and the source: <https://github.com/risyadul/Lionscope>. Licensed under the
[Apache License 2.0](LICENSE); bundled third-party licenses are in `dist/THIRD_PARTY_NOTICES.txt`.
