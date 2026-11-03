# Configuration

| Flag                     | Env var                   | Default | Purpose                                                                                                      |
| ------------------------ | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `--port <port>`          | `LIONSCOPE_PORT`          | `8701`  | Dashboard HTTP + WebSocket port                                                                              |
| `--device-port <port>`   | `LIONSCOPE_DEVICE_PORT`   | `8700`  | SDK gateway (TCP, NDJSON); reached via `adb reverse`                                                         |
| `--adb <path>`           | `LIONSCOPE_ADB`           | auto    | Path to the `adb` binary                                                                                     |
| `--allow-device-control` |                           | off     | AI agents may take screenshots, tap, type, launch apps and boot / shut down emulators, and set network mocks |
| `--allow-network-bodies` |                           | off     | AI agents get HTTP request and response bodies in `get_network_request`                                      |
|                          | `LIONSCOPE_DASHBOARD_DIR` | auto    | Built dashboard to serve                                                                                     |

Flags win over environment variables. Without `LIONSCOPE_DASHBOARD_DIR`, the server serves the dashboard that
ships next to it in the npm package, or `dashboard/dist` in a clone. There is no option to listen on anything
but `127.0.0.1`.
