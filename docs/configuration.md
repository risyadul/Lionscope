# Configuration

| Flag                       | Env var                   | Default        | Purpose                                                                    |
| -------------------------- | ------------------------- | -------------- | -------------------------------------------------------------------------- |
| `--foreground`             |                           | off            | Run the server in this terminal rather than starting a background instance |
| `--port <port>`            | `LIONSCOPE_PORT`          | `8701`         | Dashboard HTTP + WebSocket port                                            |
| `--device-port <port>`     | `LIONSCOPE_DEVICE_PORT`   | `8700`         | SDK gateway (TCP, NDJSON); reached via `adb reverse`                       |
| `--adb <path>`             | `LIONSCOPE_ADB`           | auto           | Path to the `adb` binary                                                   |
|                            | `LIONSCOPE_FFMPEG`        | auto           | Path to `ffmpeg` for host-side emulator H.264 encoding                     |
| `--disable-device-control` |                           | enabled        | Disable agent device control; dashboard device controls are independent    |
| `--disable-network-bodies` |                           | enabled        | Hide captured body text from agents; dashboard capture is independent      |
| `--disable-storage-read`   |                           | enabled        | Disable Storage reads and writes in dashboard and tools                    |
| `--disable-storage-write`  |                           | enabled        | Keep Storage read-only, including SQL tools                                |
|                            | `LIONSCOPE_DASHBOARD_DIR` | auto           | Built dashboard to serve                                                   |
|                            | `LIONSCOPE_STATE_DIR`     | `~/.lionscope` | Private background state and operational log directory                     |

Flags win over environment variables. Without `LIONSCOPE_DASHBOARD_DIR`, the server serves the dashboard that
ships next to it in the npm package, or `dashboard/dist` in a clone. Without `LIONSCOPE_FFMPEG`, the server
probes `ffmpeg` on `PATH` for a working H.264 encoder (`h264_videotoolbox`, `h264_nvenc`, `h264_vaapi`,
`h264_qsv`, or `libx264`) and automatically falls back to gRPC `PNG` if none works. There is no option to
listen on anything but `127.0.0.1`.

## Background lifecycle

After global installation (`npm install -g lionscope@latest`), run `lionscope` from any directory. It starts in
the background and prints the dashboard URL, PID and log path only after the server is ready. It stays alive
when the launching terminal closes. This is an on-demand process, not a login/reboot service.

```bash
lionscope                         # same as lionscope start
lionscope status
lionscope logs                    # last 100 lines, reading at most 256 KiB
lionscope logs --follow            # Ctrl+C stops following, not the server
lionscope stop                    # graceful session/device cleanup
lionscope --foreground            # foreground server, Ctrl+C stops it
```

Use `--port <port>` consistently for an alternate instance. Background commands require a fixed dashboard
port; `--port 0` is supported with `--foreground` only.

## Permissions

Agent device control, Network bodies for agents, Storage read and Storage write are enabled on a fresh
installation. Open **Permissions** in the dashboard or use the CLI to change them without restarting:

```sh
lionscope permissions                         # current permissions as JSON
lionscope permissions --disable-storage-write # keep Storage read-only
lionscope permissions --disable-storage-read  # disable both Storage reads and writes
lionscope permissions --allow-storage-write   # re-enable both Storage reads and writes
lionscope --disable-device-control            # start or update the running instance
```

Use `--disable-network-bodies` to hide body text from agents. This does not stop Network capture or hide it
from the dashboard. Device control governs agent tools, not dashboard emulator controls. Permissions do not
remove SDK proof, active-session, registered-Room, SQL validation, bounds or conditional-edit checks.

Changes apply to new operations immediately after being saved. Already running operations may finish;
revocation does not roll back a committed edit. The SDK receives Storage consent through the existing v11+
config message without changing the link. Preferences live in `<port>.permissions.json` under
`LIONSCOPE_STATE_DIR` (default `~/.lionscope`), with mode 0600 on POSIX. They survive server restarts and are
independent by server port. A corrupt file refuses startup with its path, rather than silently re-enabling
permissions. Explicit startup flags override saved choices and save the result; absent flags preserve them.
The `--allow-*` flags remain supported for re-enabling permissions.

MCP stdio starts with all four client permissions enabled. Its `--disable-*` flags restrict that client;
an attached server's disabled permissions always take precedence. Legacy allow headers cannot override server
settings. MCP HTTP discovers the current enabled tool set on each request. A stdio client may still cache tool
names; execution checks current server permissions on every call. Reconnect when a harness needs discovery
refreshed. Permissions are not themselves exposed as an agent tool.

`lionscope stop` stops profiling and performs the usual cleanup, including shutting down emulators booted by
that instance. It does not kill a PID from a state file. Instances started in a foreground terminal, by MCP or
by an older CLI are reported as started elsewhere; manage them through their original owner. Startup errors
and occupied ports return an error and point to logs where available.

Each port has a private `<port>.json` ownership record and `<port>.log` under `LIONSCOPE_STATE_DIR`. The record
contains the local control key; keep it private. State/log files are created with mode 0600 and a new directory
with mode 0700 on POSIX. Logs append across restarts; a log at least 5 MiB is moved to `<port>.log.1` at the next
start, replacing the previous archive. A continuously running process does not rotate its log automatically.
Logs remain after stop and are not recordings of app storage or HTTP bodies. Stale state after an unclean
exit is checked against the live server and recovered on the next start. Deleting live ownership state loses
CLI lifecycle control of that instance.

Development scripts (`npm run dev`, `npm run lionscope`) retain foreground behavior. `lionscope mcp` continues
using stdio, and a server it creates in-process still stops when that MCP client disconnects.
