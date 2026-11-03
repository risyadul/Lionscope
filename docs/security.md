# Security model

- The server listens on `127.0.0.1` only. WebSocket upgrades are accepted only from a loopback Host/Origin
  (blocks cross-site WebSocket hijacking and DNS rebinding). Every dashboard message is validated.
- The AI agent endpoints (`/mcp`, `/api/agent/<tool>`) refuse a Host other than `localhost` / `127.0.0.1` at
  the server's own port (DNS rebinding). `/mcp` refuses any `Origin` other than the dashboard's, and the JSON
  tool API refuses any `Origin` at all (CSRF); it also needs `Content-Type: application/json` and
  `X-Lionscope-Agent: 1`, which a web page can only send after a CORS preflight that the server never approves.
  Typed text never appears in errors or logs. Device-control tools exist only with
  `--allow-device-control`; that flag keeps an AI from operating your phone unasked, it is not a security
  boundary (any local process can already run adb). App data in tool results is marked as untrusted.
- Device serials and package names are checked against strict patterns and passed to `adb` as argument arrays,
  never through a host shell.
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
  request's method, URL, headers, timings and up to 64 KB of each text body, after redacting credential-looking
  values (see [Network](features/network.md)). The server checks every field's size and redacts again.
  Unlike the other SDK data, network capture and mocks need proof that the listener on `127.0.0.1:8700` is the
  Lionscope server adb trusts: before welcoming the session's link, the server makes a random key for that app
  process and hands it over with `adb shell am broadcast` to the SDK's `LinkKeyReceiver`, which is guarded by
  `android.permission.DUMP` (only the shell and the system hold it, so no other app can set the key). The welcome
  then carries an HMAC-SHA256 of a fresh nonce from the SDK's hello under that key, and the SDK records requests and
  accepts mock rules only when it checks out. An app listening on that port in place of the server therefore gets
  no network data, can't inject mocks and can't edit views (0.9.0); it can still receive the screens, frames, stalls
  and Inspector view trees described above. Requests are kept in memory only (10 minutes, 32 MB) and never written to disk;
  bodies go to AI agents only with `--allow-network-bodies`. Mock rules are sent to the app only on its session link,
  are cleared when the session stops, and need `--allow-device-control` when an agent sets them (they change what
  the app sees).
- Location (0.10.0): coordinates are checked (WGS 84 ranges) and sent to the device as fixed-point numbers in fixed
  commands. On a physical device the shell's mock-location permission is set only while Lionscope moves it and is
  restored to its previous mode afterwards. The dashboard's CSP allows images from `https://tile.openstreetmap.org`
  for the map, which the browser fetches (with the dashboard's origin as Referer, as OSM's tile policy asks) only
  while the Location panel is open.
- Live view edits (0.9.0) reach only the app of the current Inspector snapshot, through the SDK link that captured
  it, and only views of that app's latest capture (by a key the SDK gives each View object; a recreated view gets a
  new one). They change what the app does (a disabled button enabled, a label rewritten), so the SDK applies them only
  on a link with the link proof above (a profiling session) and answers anything else `unauthenticated`. The dashboard sends one only when you commit a field; agents need `--allow-device-control`. Values are
  checked against fixed bounds by the server and again by the SDK, edits are rate-limited per device (a burst of
  10, then 5 per second) and again by the SDK itself, which keeps at most 256, lets at most 8 wait for the main
  thread, and drops one whose connection ended before it ran. The SDK only calls the platform setters (and AppCompat's background tint),
  never other app code, though those setters can run the app's listeners; it never reads or sets the text of a
  password field, nor keeps it once a field it edited becomes one.
