# lionscope

Lightweight Android profiler and Layout Inspector in your browser, and your AI agent can use it too. It shows CPU,
memory, frame rendering, main-thread stalls, layout inflation and logcat for one app on a connected device, on a
single shared time axis. Click a view to inspect it; with the SDK in the app you also see the XML layout and line it came from. Emulators and USB devices can be
operated from the dashboard, and AI agents get the same data as tools over MCP (`lionscope mcp`) or the CLI
(`lionscope query`). No Android Studio needed.

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
  --allow-device-control
                        Let AI agents operate devices: screenshots, taps, swipes, text, keys, launching
                        apps, booting and shutting down emulators (off by default)
  -h, --help            Show this help
  -v, --version         Print the version
```

AI agents: `npx -y lionscope mcp` is an MCP server on stdio (it uses the running Lionscope server, or starts
one), the running server also serves MCP at `http://localhost:8701/mcp`, and `npx lionscope query <tool>`
prints a tool's JSON result for shell-only agents (`npx lionscope query --list`). For example, in Claude Code:
`claude mcp add lionscope -- npx -y lionscope mcp`. Setup for other editors and agents is in the main README.

Nothing needs to be installed on the device. For screen names and per-frame `FrameMetrics`, add the optional
debug-only SDK to the app (`debugImplementation "com.github.risyadul.Lionscope:lionscope:0.5.0"` from JitPack).

Documentation, the SDK and the source: <https://github.com/risyadul/Lionscope>. Licensed under the
[Apache License 2.0](LICENSE); bundled third-party licenses are in `dist/THIRD_PARTY_NOTICES.txt`.
