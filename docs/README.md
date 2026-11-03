<!-- docs:added -->

# Lionscope docs

Start with the [README](../README.md): what Lionscope is, requirements, quick start and adding the SDK.

| Page                                                                                  | What's in it                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [What the dashboard shows](dashboard.md)                                              | The page, its three views, the panels and where each figure comes from             |
| [Finding the line that blocks the main thread](features/stalls.md)                    | Main-thread stalls, their lines and origins, StrictMode, RxJava tracking           |
| [Layouts: what inflating XML costs](features/layouts.md)                              | Inflation timing per layout                                                        |
| [Layout Inspector: pick a view, see where it came from](features/layout-inspector.md) | The view tree, layout sources and owners, Compose, editing views live              |
| [Network: requests and mocks](features/network.md)                                    | The OkHttp interceptor, the Network tab, mock rules                                |
| [Saved state: what makes it too large](features/saved-state.md)                       | `TransactionTooLargeException` and each Activity's saved-state size                |
| [Operating a device](features/device.md)                                              | Emulators (also headless) and USB devices in the Device column                     |
| [Changing the device's location](features/location.md)                                | Moving a device on a map, and how its real location comes back                     |
| [The SDK](sdk.md)                                                                     | Screen names, Navigation Compose, Network, release builds, cost when not connected |
| [Use with AI agents](agents.md)                                                       | MCP and shell setup per client, the tools, the agent skill, safety notes           |
| [Architecture](architecture.md)                                                       | How the server, dashboard, SDK and protocol fit together                           |
| [Security model](security.md)                                                         | What the server accepts and what reaches an agent                                  |
| [Known limitations](limitations.md)                                                   | What Lionscope doesn't see or do                                                   |
| [Configuration](configuration.md)                                                     | Flags and environment variables                                                    |
| [Development](development.md)                                                         | Building and testing from source                                                   |

<!-- /docs:added -->
