# Security model

- Background CLI instances additionally expose `/api/daemon/status` and `/api/daemon/stop`. They require an
  exact loopback Host/port, a POST with JSON content type, no Origin header and the instance's random control
  key from its private ownership record. The key is not returned by status or placed in process arguments.
  Foreground and MCP-owned servers do not expose these controls. The CLI verifies live ownership rather than
  signaling a stored PID, so stale metadata does not authorize stopping another process. State/log files are
  created with POSIX mode 0600 under a new mode-0700 directory; Windows uses the account's filesystem ACLs.
- The server listens on `127.0.0.1` only. WebSocket upgrades are accepted only from a loopback Host/Origin
  (blocks cross-site WebSocket hijacking and DNS rebinding). Every dashboard message is validated.
- The AI agent endpoints (`/mcp`, `/api/agent/<tool>`) refuse a Host other than `localhost` / `127.0.0.1` at
  the server's own port (DNS rebinding). `/mcp` refuses any `Origin` other than the dashboard's, and the JSON
  tool API refuses any `Origin` at all (CSRF); it also needs `Content-Type: application/json` and
  `X-Lionscope-Agent: 1`, which a web page can only send after a CORS preflight that the server never approves.
  Typed text never appears in errors or logs. Device-control tools follow the enabled-by-default device permission and client restrictions; disabled server
  permissions cannot be overridden by legacy allow headers. These settings are not a security boundary against
  local processes (which can already run adb). App data in tool results is marked as untrusted.
- Device serials, package names, permission names, deep-link URIs, and host APK paths are checked against strict
  patterns and passed to `adb` as argument arrays, never through a host shell (with POSIX single-quoting for remote
  device shell metacharacters). Failed ADB calls sanitize `-d` intent URIs and redact credentials in stderr before
  logging or returning errors. `install_apk` accepts only an absolute path to an existing regular `.apk` file on the
  host (rejecting symlinks), opens the descriptor once, stages a private temporary snapshot for `adb install`, and
  deletes it afterwards. `clear_app_data`, `set_app_permissions`, and `get_notifications` are restricted to the
  profiling session's target device and package (`clear_app_data` also refuses all system packages;
  `set_app_permissions` validates every permission against declared permissions and Android's runtime/dangerous class
  before applying changes). `get_notifications` requests a package-filtered active dump, redacts credentials with the
  same rules as `search_logcat`, and marks all app-derived notification text as untrusted data. `set_orientation` and
  `set_display_options` record original device values before the first change and restore them automatically on
  `stop_session`, emulator shutdown, or server close (or explicitly via `restore_device_settings`). `pinch` runs
  through an exclusive multi-touch lease on the active mirror session (scrcpy or emulator gRPC) and lifts accepted
  down pointers in cleanup. All mutating E2E tools and screen/notification readers require enabled device-control
  permission and respect `--disable-device-control` (`wait_for_screen` without device control is restricted to the
  active session's device and package).
- The SDK gateway (TCP, `127.0.0.1` only) requires a valid `hello` as the first line within 1 s, closes
  HTTP-looking requests (browsers can POST to localhost), rate-limits hellos and lines, caps line size and
  connections, and answers nothing (not even `welcome`) until the hello's PID is verified with `pidof` on the
  device it came from; every refusal looks the same, so a probe can't learn which app is being profiled. Each
  device with an inspect-only link (0.9.0) gets its own gateway listener, so a link is always tied to its device;
  only debuggable apps are linked that way, and an Inspect only asks the app Android reports in the foreground.
  The `adb reverse tcp:8700` mapping for inspect links exists only while someone inspects that device, and is
  never taken from (or removed for) another running Lionscope server.
- The dashboard and screen sockets have no password of their own: any process of any user on the same machine
  that can reach `127.0.0.1` can use them, including operating a mirrored emulator. That is no more access than
  the adb server on `127.0.0.1:5037` already gives local processes; do not run Lionscope on a machine you share
  with people you don't trust.
- Emulator access tokens are read from the emulator's discovery file and used only by the server; they are
  never logged or sent to the browser. The screen socket (`/ws/screen`) has the same Host/Origin checks, a
  size cap and an input rate limit. AVD names must match `emulator -list-avds` before anything is spawned, and
  an emulator this server didn't boot is shut down only after the user confirms it in the dashboard, and only through
  its own gRPC endpoint or `adb emu kill` on its serial (never a process signal).
- For physical devices, the scrcpy server jar is checked against its SHA-256 before every push, the command line
  on the phone is built from fixed presets (no dashboard values reach the device shell), and the phone process
  and adb forward are removed on every exit path. Video and device messages from the phone are size-checked.
  While mirroring starts, adb briefly forwards a local port to the phone; it is removed as soon as Lionscope is
  connected. If you run the adb server with `adb -a` (listen on all interfaces), that port is reachable from your
  network for that moment, so keep adb on its default loopback binding.
- The SDK only sends screen class names / aliases, frame timings and, with stalls enabled, stack frames of the
  main thread (class, method, file, line; with RxJava tracking also the Rx task's and consumer's class names and the
  frames of the call that subscribed the chain, and a coroutine's name in debug mode) and StrictMode messages, and
  only from debuggable builds. When you
  Inspect, it also sends the view tree, including the text on screen (never the text of password fields). Without
  the `adb reverse` mapping, another app on the device listening on `127.0.0.1:8700` could act as the server and
  receive that stream, including view trees if it asks for them: don't keep untrusted apps on a device you
  inspect with Lionscope.
- During a profiling session the SDK sends each Activity's saved-state size and, from 64 KB, the keys of its largest
  entries, the class names of their values and of the Fragments they belong to: never the values themselves.
- With `Lionscope.okHttpInterceptor()` in the app, the SDK also sends, during a profiling session only, each HTTP
  request's method, URL, headers, timings and up to 64 KB of each text body. Negotiated device protocol 14
  preserves original Network values, including credentials; older links retain credential redaction
  (see [Network](features/network.md)). The server still validates every field and its size. Copy cURL explicitly
  places the captured request, including credentials, on the clipboard; it never executes it.
  Unlike the other SDK data, network capture and mocks need proof that the listener on `127.0.0.1:8700` is the
  Lionscope server adb trusts: before welcoming the session's link, the server makes a random key for that app
  process and hands it over with `adb shell am broadcast` to the SDK's `LinkKeyReceiver`, which is guarded by
  `android.permission.DUMP` (only the shell and the system hold it, so no other app can set the key). The welcome
  then carries an HMAC-SHA256 of a fresh nonce from the SDK's hello under that key, and the SDK records requests and
  accepts mock rules only when it checks out. An app listening on that port in place of the server therefore gets
  no network data, can't inject mocks and can't edit views (0.9.0); it can still receive the screens, frames, stalls
  and Inspector view trees described above. Requests are kept in memory only (10 minutes, 32 MB) and never written to disk;
  bodies follow the enabled-by-default Network bodies permission and client restrictions. Mock rules are sent to the app only on its session link,
  are cleared when the session stops, and need enabled device-control permission when an agent sets them (they change what
  the app sees).
- Location (0.10.0): coordinates are checked (WGS 84 ranges) and sent to the device as fixed-point numbers in fixed
  commands. On a physical device the shell's mock-location permission is set only while Lionscope moves it and is
  restored to its previous mode afterwards. The dashboard's CSP allows images from `https://tile.openstreetmap.org`
  for the map, which the browser fetches (with the dashboard's origin as Referer, as OSM's tile policy asks) only
  while the Location panel is open.
- Storage (0.13.0) starts with read/write permissions enabled on a fresh installation. The dashboard Permissions
  menu and CLI can disable them live; choices are saved locally per server port. Reads cover SharedPreferences
  and registered Room databases; writes include conditional edits and explicit SQL mutations. It works only on a profiling session's link with
  the link proof above, and the SDK checks the consent the welcome gave it again. On device protocol 12 links, Storage values are original, including credentials,
  and editable from the dashboard or agents under the same read/write permissions. Older negotiated links keep
  v11 redaction and primary-key restrictions. Views and virtual/internal tables remain read-only; paging cursors are opaque tokens the SDK keeps, never key values. EncryptedSharedPreferences
  are not read. The row editor updates existing values and deletes by primary key, compare-and-set, through the app's own
  connection; v12 row updates can include primary-key columns, compare every
  edited field, and apply all changes in one transaction with database constraints intact. An edit names the app link its values were read from and is refused
  on another. The server keeps an audit of every edit (who, what, where, the outcome) without values, primary keys
  as digests, in memory only. Protocol 13 also accepts one validated SELECT/WITH or INSERT/UPDATE/DELETE from
  the dashboard Query console and MCP/CLI SQL tools, with independent SDK consent checks, technical table restrictions and bounded
  results on the same Room connection. SQL mutations have no compare-and-set or undo. Transaction/schema commands
  and ROLLBACK conflict behavior are refused. SQL text and literals never enter audit metadata; history is session
  memory only. There is no second connection. See [Storage](features/storage.md).
- Live view edits (0.9.0) reach only the app of the current Inspector snapshot, through the SDK link that captured
  it, and only views of that app's latest capture (by a key the SDK gives each View object; a recreated view gets a
  new one). They change what the app does (a disabled button enabled, a label rewritten), so the SDK applies them only
  on a link with the link proof above (a profiling session) and answers anything else `unauthenticated`. The dashboard sends one only when you commit a field; agents need enabled device-control permission. Values are
  checked against fixed bounds by the server and again by the SDK, edits are rate-limited per device (a burst of
  10, then 5 per second) and again by the SDK itself, which keeps at most 256, lets at most 8 wait for the main
  thread, and drops one whose connection ended before it ran. The SDK only calls the platform setters (and AppCompat's background tint),
  never other app code, though those setters can run the app's listeners; it never reads or sets the text of a
  password field, nor keeps it once a field it edited becomes one.

Permission administration (`/api/permissions`) requires an exact loopback Host/port and a custom settings
header. Mutations additionally require JSON, an allowed dashboard Origin when present and at most 4096 bytes.
CLI clients send no Origin. The server validates and serializes updates, persists private boolean-only choices,
then changes enforcement and broadcasts state. The SDK receives existing version-gated config messages; no
server restart or link replacement is needed. Requests already executing may finish; disabling permission
does not undo a mutation. See [Configuration](configuration.md#permissions).
