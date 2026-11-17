# Architecture

```
 device                                     laptop (everything listens on 127.0.0.1)

 app (debug) + :lionscope SDK ── TCP :8700 ── adb reverse ──▶ server/ SDK gateway (NDJSON)
 adbd ◀───────────── adb shell: /proc, dumpsys, logcat ─────── server/ collectors
                                                                 │
                                                                 ▼
                                                               session store (10 min)
                                                                 │ HTTP + WebSocket :8701
                                                                 ▼
                                                               dashboard/ in the browser
 emulator ◀─────────── gRPC (EmulatorController, token) ─────── server/ emulator manager + /ws/screen
 phone ◀── adb forward ── scrcpy-server (H.264 + control) ───── server/ scrcpy session + /ws/screen
```

| Directory      | What it is                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol/`    | The wire contract shared by server and dashboard: types (`wire.ts`), zod validation (`index.ts`), golden SDK lines (`fixtures/`), and `insights/`: the dashboard's figures (screens, stalls, layouts, logcat filter) as pure functions the agent tools reuse |
| `server/`      | Node.js + TypeScript: adb collectors and parsers, session store (10-minute ring buffers), WebSocket gateway, SDK gateway, and `agent/`: the AI agent tools behind `/mcp`, `/api/agent` and `lionscope mcp` / `query`                                         |
| `dashboard/`   | Vite + React + uPlot single-page app, served by the server                                                                                                                                                                                                   |
| `android-sdk/` | Gradle build: `:lionscope` (debug SDK), `:lionscope-noop` (release no-op), `:sample` (demo app)                                                                                                                                                              |
| `cli/`         | The `lionscope` npm package: the server bundled with esbuild into `dist/lionscope.mjs`, plus the built dashboard                                                                                                                                             |

The SDK talks to the server over plain TCP with one JSON object per line rather than WebSocket: apps with
`usesCleartextTraffic=false` (or a network security config without localhost) would block `ws://localhost`,
while plain sockets are not subject to that policy. The Kotlin encoders and the server's validator are both
tested against the same golden file, `protocol/fixtures/device-messages.ndjson`.

The SDK's `hello` carries its protocol version (14 in release 0.13.0); the server answers `welcome` with the lower
of that and its own
(the negotiated version, accepted from 1 to 1000), and lines of a message type the server does not know are
skipped and counted instead of closing the connection; known types are still validated strictly. From 0.1.1 on,
an SDK and a server from different releases therefore keep working together: a 0.1.1 server or SDK negotiates
protocol 1, and stalls and StrictMode are simply unavailable. The server drops invalid stall or StrictMode
messages instead of closing the link. A 0.1.0 server only accepts
protocol version 1 and closes the connection on unknown message types.

The network inspector needs device protocol 7 on both sides (SDK and server 0.9.0 or later): with an older server
the interceptor stays a pass-through, and an older SDK simply sends no requests. HTTP request and response lines
may be up to 256 KiB; Storage result lines also have a 256 KiB cap, with a 240 KiB SDK reply budget. Other SDK
lines keep the 64 KiB cap. The server's mock rules reach the SDK as flat lines of at most 512 KiB.

Storage begins at device protocol 11 and requires explicit server consent plus a proven profiling link.
Protocol 12 adds original Storage values and primary-key row edits; protocol 13 adds the dashboard's SQL Query
console on the registered app-owned Room connection. Protocol 14 preserves original captured Network values
and reports request completeness for Copy cURL. Older negotiated links retain their earlier behavior. See
[Storage](features/storage.md) and [Network](features/network.md) for bounds and write contracts.

Stall origins use device protocol 9 (SDK and server 0.9.0): its stalls may carry the stack's outermost frames, the
RxJava hooks' findings and the coroutine name, and `config` carries the RxJava switch. With an older server the
SDK sends stalls as before and leaves its RxJava hooks off; stalls from an older SDK still get an origin from
their stack.
