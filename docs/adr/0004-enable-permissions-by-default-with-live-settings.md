---
status: accepted
---

# Enable debugging permissions by default with live settings

The user chose to enable all four debugging permissions from the first run and provide ways to disable them
through the CLI or dashboard. This replaces the startup-only opt-in policy retained in ADR 0001 and ADR 0003.
SDK authentication, session binding, supported Room connections, SQL validation, bounds and conditional row
editing remain unchanged.

## Permission settings

A fresh server enables agent device control, Network bodies for agents, Storage read and Storage write.
The dashboard Permissions dialog and `lionscope permissions` share the server's settings controller. Updates
are serialized, validated, saved privately per server port, then applied and broadcast to all dashboards.
An unsuccessful save leaves the live state unchanged. Saved choices survive restart; explicit startup flags
override and save those choices. Invalid saved data refuses startup instead of restoring permissive defaults.

Disabling Storage read also disables write. Enabling Storage write also enables read. An explicit contradictory
patch is rejected. Agent device control does not govern dashboard emulator controls; Network bodies governs
agent responses, not capture or dashboard display. Disabling a capability blocks subsequent requests; it does
not cancel an already running action or roll back a committed write. No write is automatically retried.

## Transport and compatibility

Server checks are authoritative. Legacy per-request allow headers and client flags cannot override a disabled
server permission. MCP stdio defaults to offering all capabilities, with client disable flags providing further
restrictions. Its cached discovery can require reconnecting; invocation always checks the current server state.
HTTP MCP discovers the current tool set per request. Permission administration is a local dashboard/CLI
operation, not an MCP tool.

Storage consent changes use the existing v11+ SDK config field, on pending and active links and future
sessions. SDK consent remains off until config arrives and resets on disconnect. Its worker rechecks consent
before queued work runs. The SDK protocol and Kotlin encoding do not change. Dashboard hello gains optional
permission state and the stream adds a control message for updates. Older dashboards ignore the new message;
new dashboards hide permission administration when older servers omit the capability. Existing SDK consent
version gates continue to apply.

The settings endpoint retains exact loopback Host/port, allowed Origin, JSON, custom-header and payload checks.
The existing local-machine trust model applies. Settings contain booleans only; SQL and app values are not saved.

## Interface

Keep permissions under one labeled button in the top bar, rather than adding navigation tabs. Four switches
show their scope and current state. Changes are confirmed by the server broadcast, with pending/offline/error
states and no optimistic replacement by late HTTP responses. The dialog follows DESIGN.md typography,
spacing, focus, scrolling and touch-target rules. ENERGY 1 / RHYTHM 1 / MOTION 1 preserves the debugging workbench.
