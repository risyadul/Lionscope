# lionscope

Lightweight Android profiler and Layout Inspector in your browser, and your AI agent can use it too. It shows CPU,
memory, frame rendering, main-thread stalls, layout inflation and logcat for one app on a connected device, on a
single shared time axis. Click a view to inspect it; with the SDK in the app you also see the XML layout and line it
came from, the composables of Compose screens, and you can edit a View's properties live on the running app. With
the SDK, main-thread stalls name where their work came from (an RxJava chain, a coroutine, a posted Runnable), and
one line in the app's `OkHttpClient` adds its HTTP requests and mock responses. Emulators and USB devices can be
operated from the dashboard, and AI agents get the same data as tools over MCP (`lionscope mcp`) or the CLI
(`lionscope query`). No Android Studio needed.

The SDK also exposes SharedPreferences and registered Room databases through Storage: typed row edits,
primary-key edits and SQL through the Query console or `query_storage_sql` / `execute_storage_sql` tools.
Complete captured Network requests can be copied as cURL; protocol
14 preserves original auth headers and other captured values. Agent access to Network body text follows configurable permissions.

```bash
npm install -g lionscope@latest
lionscope
# open http://localhost:8701, pick the device and the app, press Start
```

The server runs in the background and returns the terminal after startup succeeds. It stays running when the
terminal closes. Repeating `lionscope` reuses the server on that port; it does not start another copy or change
startup connection options; permission flags update the running instance without restarting. Start it again after a reboot.

```bash
lionscope status
lionscope logs --follow
lionscope stop
lionscope --foreground       # attached to this terminal, Ctrl+C to stop
```

`lionscope start` is an explicit alias for the default command. Server instances are selected by `--port` (or
`LIONSCOPE_PORT`), so use the same port for start, status, logs and stop. Stop performs normal session/device
cleanup, including shutting down emulators this server booted. An instance started elsewhere is reported but
is not stopped by these commands; use its original terminal or process manager.

State and operational logs are private files in `~/.lionscope` (`LIONSCOPE_STATE_DIR` overrides it). Logs remain
readable after stop. See the repository's Configuration page for lifecycle and log-retention details.

For a one-off run, `npx lionscope@latest` works without global installation.

`@latest` makes npx check for a new release; a bare `npx lionscope` can keep running a version it cached
earlier.

Requirements: Node.js ≥ 22.12, Android SDK platform-tools (`adb`), and a device or emulator with USB debugging
on Android 6.0 (API 23) or newer for profiling. SDK FrameMetrics and UI-helper tree operations need API 24.
Everything listens on 127.0.0.1 only.

```text
Options:
  --foreground         Run attached to this terminal instead of in background
  --port <port>         Dashboard port (LIONSCOPE_PORT, default 8701)
  --device-port <port>  In-app SDK gateway port (LIONSCOPE_DEVICE_PORT, default 8700)
  --adb <path>          adb binary (LIONSCOPE_ADB; default: $ANDROID_HOME, the usual SDK location, then PATH)
  --disable-device-control Disable agent device control
  --disable-network-bodies Hide body text from agents
  --disable-storage-read   Disable Storage reads and writes
  --disable-storage-write  Keep Storage read-only
  --allow-*                Re-enable a permission; all permissions start enabled
  -h, --help            Show this help
  -v, --version         Print the version
```

AI agents: `npx -y lionscope mcp` is an MCP server on stdio (it uses the running Lionscope server, or starts
one), the running server also serves MCP at `http://localhost:8701/mcp`, and `npx lionscope query <tool>`
prints a tool's JSON result for shell-only agents (`npx lionscope query --list`). For example, in Claude Code:
`claude mcp add lionscope -- npx -y lionscope mcp`. Setup for other editors and agents is in the main README, with the Lionscope agent skill: `npx skills add risyadul/Lionscope`, or in Claude Code the plugin (`/plugin marketplace add risyadul/Lionscope`, then `/plugin install lionscope@lionscope`).

Nothing needs to be installed on the device. For screen names, per-frame `FrameMetrics`, stall lines and origins,
the Inspector's layout sources and Compose tree, live view edits and the network inspector, add the optional
debug-only SDK to the app (`debugImplementation "com.github.risyadul.Lionscope:lionscope:0.13.0"` from JitPack).

Register the app-owned Room instance with `Lionscope.trackDatabase(name, db)`; preferences are discovered
automatically. Apps calling Lionscope APIs also need
`releaseImplementation "com.github.risyadul.Lionscope:lionscope-noop:0.13.0"`.
All permissions start enabled. Change them live in the dashboard **Permissions** menu or with
`lionscope permissions --disable-storage-write` (read-only), `--disable-storage-read` (Storage off),
`--disable-device-control` or `--disable-network-bodies`. Use the corresponding `--allow-*` flag to re-enable.
Choices are saved locally per server port and survive restart. MCP stdio flags can further restrict its client;
an attached server's disabled settings always apply. See
[Configuration](https://github.com/risyadul/Lionscope/blob/main/docs/configuration.md).

Documentation, the SDK and the source: <https://github.com/risyadul/Lionscope>. Licensed under the
[Apache License 2.0](LICENSE); bundled third-party licenses are in `dist/THIRD_PARTY_NOTICES.txt`.
