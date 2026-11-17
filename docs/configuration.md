# Configuration

| Flag                     | Env var                   | Default        | Purpose                                                                                                                 |
| ------------------------ | ------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--foreground`           |                           | off            | Run the server in this terminal rather than starting a background instance                                              |
| `--port <port>`          | `LIONSCOPE_PORT`          | `8701`         | Dashboard HTTP + WebSocket port                                                                                         |
| `--device-port <port>`   | `LIONSCOPE_DEVICE_PORT`   | `8700`         | SDK gateway (TCP, NDJSON); reached via `adb reverse`                                                                    |
| `--adb <path>`           | `LIONSCOPE_ADB`           | auto           | Path to the `adb` binary                                                                                                |
| `--allow-device-control` |                           | off            | AI agents may take screenshots, tap, type, launch apps and boot / shut down emulators, and set network mocks            |
| `--allow-network-bodies` |                           | off            | AI agents get HTTP request and response bodies in `get_network_request`                                                 |
| `--allow-storage-read`   |                           | off            | Dashboard and AI agents read the app's SharedPreferences and registered Room databases ([storage](features/storage.md)) |
| `--allow-storage-write`  |                           | off            | Conditional value/row edits and explicit SQL mutations (needs `--allow-storage-read`)                                   |
|                          | `LIONSCOPE_DASHBOARD_DIR` | auto           | Built dashboard to serve                                                                                                |
|                          | `LIONSCOPE_STATE_DIR`     | `~/.lionscope` | Private background state and operational log directory                                                                  |

Flags win over environment variables. Without `LIONSCOPE_DASHBOARD_DIR`, the server serves the dashboard that
ships next to it in the npm package, or `dashboard/dist` in a clone. There is no option to listen on anything
but `127.0.0.1`.

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
port; `--port 0` is supported with `--foreground` only. A running instance keeps its startup permissions; stop
it before restarting with different options. To enable Storage explicitly:

```bash
lionscope --allow-storage-read --allow-storage-write
```

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
