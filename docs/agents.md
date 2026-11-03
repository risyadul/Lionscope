# Use with AI agents

AI coding agents (Claude Code, Cursor, VS Code, Codex, Gemini CLI, Windsurf, Claude Desktop, …) can read what
Lionscope records and run profiling sessions: "profile the shop app on the emulator, then tell me which screen
janks most and which line blocks the main thread". They get the same numbers the dashboard shows (the Screens,
Stalls, Layouts and Logcat figures come from one shared module), and the dashboard stays open next to them.

Three ways in, one set of tools:

- **MCP over stdio**: `npx -y lionscope mcp`. It uses the Lionscope server already running on `--port` (default
  8701), or starts one in its own process when none is running: the dashboard is then at
  http://localhost:8701 until the agent disconnects. If the server it uses stops, its next tool call starts one
  (or attaches to whichever another client started). Logs go to stderr.
- **MCP over HTTP** (Streamable HTTP): `http://localhost:8701/mcp` on a running server (`npx lionscope`), for
  clients that are not web pages: a request with an `Origin` other than the dashboard's is refused. Desktop
  harnesses connect from a Node process and send none (VS Code's and Cursor's MCP clients run in their Node extension hosts);
  browser-based clients (VS Code for the Web, an MCP inspector page) can't use it, so give them the stdio
  command.
- **Shell**: `npx lionscope query <tool>` prints a tool's JSON result, for agents that can only run commands.

| Tools                      | What they do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read (always)              | `status` (devices, emulators, session, SDK link), `list_apps`, `get_location` (the location Lionscope set on a device, an emulator's GPS fix), `get_summary` (CPU, memory, FPS, jank, stalls, top screens and layouts of the last 1/5/10 min), `get_screens`, `get_stalls` (by culprit line and by origin: the Rx chain's subscribe site, the coroutine, the posted Runnable), `get_strictmode`, `get_layouts`, `get_view_tree`, `search_logcat` (the newest 5000 lines, credentials redacted; from a time or between `mark` markers), `get_crashes` (the session's Java and native crashes from logcat's crash buffer, kept after their lines leave the log buffer; a TransactionTooLargeException's parcel size and failed call), `get_saved_state` (TransactionTooLarge failures from logcat, without the SDK too; with it each Activity's saved-state size and its largest keys and Fragments)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Session (always)           | `start_session`, `stop_session`, `set_sdk_options` (stall threshold, StrictMode, inflation tracking, RxJava tracking, saved-state tracking), `mark` (names a moment of the session, e.g. the start of a test run, for `sinceMarker` / `untilMarker` in `search_logcat` and `get_crashes`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Inspector (always)         | `get_inspector_selection` (the element you selected in the dashboard's Layout Inspector: its attributes, a view's XML layout and line or a composable's Kotlin call site, owning Fragment, Activity and destination, ancestors and children, and a crop of the screenshot; structure only for a node the agent selected), `select_inspector_node` (highlights a node in the dashboard, marked AI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Network (always)           | `get_network` (the app's HTTP requests in the last 1/5/10 min: method, URL, status, timings, sizes, mocked; filter by method, status class, host, text), `get_network_request` (one request's headers and timings; its bodies only with `--allow-network-bodies`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Device (opt-in, see below) | `get_ui_tree` (the screen's elements: text, description, id, bounds, flags), `inspect_screen` (a Layout Inspector snapshot, shown in the dashboard too), `set_view_property` / `revert_view_properties` (change a View of the snapshot live, temporarily: visibility, alpha, padding, margins, size, translation, elevation, colors, TextView text and size; SDK 0.9.0+, during a session), `tap_element`, `wait_for`, `scroll_to` (find elements by text, id, description or hint), `screenshot` (720 px short edge, with the screen's mean luminance, non-black share and a `blank` flag for a one-colour screen), `tap`, `swipe`, `type_text`, `press_key` (navigation and editing keys; never power, sleep or lock), `run_inputs` (a timed sequence of taps, element taps, keys and waits in one adb call), `launch_app`, `stop_app` (force-stop an app; its unsaved state is lost), `get_activity_instance` (the activity on screen and whether it was recreated or its process restarted since the last call), `set_dont_keep_activities` (Developer options' "Don't keep activities", effective at once), `simulate_process_death` (kill a backgrounded app keeping its task, then reopen it), `bring_to_front` (an app's task back as Recents does it), `boot_emulator`, `shutdown_emulator`, `set_network_mock`, `clear_network_mocks` (mock responses or failures, see [Network](features/network.md)), `set_location`, `clear_location` (move the device, see [Location](features/location.md)) |

**"Why is this button misaligned?"** Select the element in the dashboard's Layout Inspector (Inspect, then click
it) and ask about "this element": the agent calls `get_inspector_selection` and gets what the Inspector tab
shows (class, id, text, bounds, padding, margins, layout width and height, `view_dashboard_actions.xml` line 15,
the owning Fragment) plus a cropped screenshot of the element, at most 512 px (none for a window root or an element
covering more than half of the screen). The line is where the start tag ends, which the tool says too. With
device control on, `inspect_screen` takes a snapshot itself (with a query to find nodes; it replaces the snapshot
you see) and `select_inspector_node` points you at the node it means, marked **AI**. For a node the agent selected
itself, `get_inspector_selection` returns its structure only (class, id, layout source, owner, bounds), never its
text or an image: an agent without device control can't read the screen that way. Without the SDK in the app the
snapshot comes from uiautomator, without layout sources or owners. With device control, SDK 0.9.0+ and a profiling
session the agent can also try its fix on the running app: `set_view_property { nodeId, property: "padding", value: [16, 8, 16, 8] }`
answers with the element as the next snapshot shows it, and `revert_view_properties` undoes it (the edits are
temporary either way; see [Editing views live](features/layout-inspector.md#editing-views-live)).

**"Why does checkout fail?"** With the interceptor in the app, `get_network` lists the requests around it
(`status: "5xx"` or `"failed"`) and `get_network_request` gives one request's headers, timing and error. Header
values that look like credentials are already redacted. Bodies stay out of tool results unless the server or the
MCP client runs with `--allow-network-bodies` (e.g. `npx -y lionscope mcp --allow-network-bodies`, or
`lionscope query network-request --id 12 --allow-network-bodies`); with it, they are marked as untrusted data like
other app strings. With device control on, `set_network_mock` answers a URL with a canned response, an error status
or a timeout (shown in the dashboard as an **AI** rule), and `clear_network_mocks` removes it: ask the agent to
clear them when it is done, or stop the session.

## Setup

Each harness starts `npx -y lionscope mcp` itself; add `--allow-device-control` to its arguments to let it
[operate the device](#letting-an-agent-operate-the-device). The HTTP variants talk to a server you started
with `npx lionscope`. Formats as documented by each tool in October 2026.

**Claude Code** ([docs](https://code.claude.com/docs/en/mcp)), or install the [plugin](#agent-skill), which adds
the server and the skill together:

```bash
claude mcp add lionscope -- npx -y lionscope mcp
# or, against a running server:
claude mcp add --transport http lionscope http://localhost:8701/mcp
```

Add `--scope project` to share it through the project's `.mcp.json`, or `--scope user` for every project.

**Cursor** ([docs](https://cursor.com/docs/context/mcp)): `.cursor/mcp.json` in the project, or
`~/.cursor/mcp.json` for every project.

```json
{
  "mcpServers": {
    "lionscope": { "type": "stdio", "command": "npx", "args": ["-y", "lionscope", "mcp"] }
  }
}
```

HTTP: `"lionscope": { "url": "http://localhost:8701/mcp" }`.

**VS Code** (GitHub Copilot agent mode, [docs](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)):
`.vscode/mcp.json` in the workspace; note the top-level key is `servers`.

```json
{
  "servers": {
    "lionscope": { "type": "stdio", "command": "npx", "args": ["-y", "lionscope", "mcp"] }
  }
}
```

HTTP: `"lionscope": { "type": "http", "url": "http://localhost:8701/mcp" }`. Or from a terminal:
`code --add-mcp '{"name":"lionscope","type":"stdio","command":"npx","args":["-y","lionscope","mcp"]}'`.

**Codex** ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)): `~/.codex/config.toml`, or
`codex mcp add lionscope -- npx -y lionscope mcp`.

```toml
[mcp_servers.lionscope]
command = "npx"
args = ["-y", "lionscope", "mcp"]
```

HTTP: `url = "http://localhost:8701/mcp"` in place of `command` and `args`.

**Gemini CLI** ([docs](https://geminicli.com/docs/tools/mcp-server/)): `.gemini/settings.json` in the project,
or `~/.gemini/settings.json`.

```json
{
  "mcpServers": {
    "lionscope": { "command": "npx", "args": ["-y", "lionscope", "mcp"] }
  }
}
```

HTTP: `"lionscope": { "httpUrl": "http://localhost:8701/mcp" }` as documented (newer releases also accept
`"url": "http://localhost:8701/mcp", "type": "http"`, which `gemini mcp add --transport http` writes). To add it
from a terminal: `gemini mcp add -s user lionscope npx -- -y lionscope mcp` (the `--` keeps `-y` for npx).

**Windsurf** (renamed Devin Desktop in June 2026, [docs](https://docs.devin.ai/desktop/cascade/mcp)):
`~/.config/devin/mcp_config.json` on macOS and Linux, `%APPDATA%\devin\mcp_config.json` on Windows (projects
can also use `.devin/mcp_config.json`), with the same `mcpServers` entry as Gemini CLI above. HTTP:
`"lionscope": { "serverUrl": "http://localhost:8701/mcp" }` for the Cascade agent,
`"lionscope": { "url": "http://localhost:8701/mcp" }` for the Devin Local agent.

**Claude Desktop** ([docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers)): Settings →
Developer → Edit Config opens `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS,
`%APPDATA%\Claude\` on Windows); add the same `mcpServers` entry as Gemini CLI above and restart Claude Desktop.
Use the stdio entry: Claude Desktop's custom connectors reach remote servers from Anthropic's side, so they can't
reach `localhost`.

**Any other MCP client**: run `npx -y lionscope mcp` as a stdio server, or connect to
`http://localhost:8701/mcp` (Streamable HTTP, no authentication, loopback only).

## Agent skill

The MCP tools say what each call does; the **Lionscope skill** (`skills/lionscope/SKILL.md`) tells an agent how to
use them for a task: where to start, the playbooks for a janky screen, a blocked main thread (by line and by
origin), the element the user picked in the Inspector (and trying a fix with a live edit), the app's requests and
mocked error states, and checking a fix before and after. It works with or without the MCP server: without one, it
uses `npx lionscope query` from the shell. It is one [Agent Skills](https://agentskills.io) folder, so every
harness that reads `SKILL.md` can use it; only where it goes differs.

**Claude Code: the plugin** (the MCP server and the skill in one install). Pick one of the two plugins:

```text
/plugin marketplace add risyadul/Lionscope
/plugin install lionscope@lionscope                   # read tools and sessions
/plugin install lionscope-device-control@lionscope    # also the device tools (taps, edits, mocks, emulators)
```

From a terminal, `claude plugin install lionscope --marketplace risyadul/Lionscope` does both steps at once. The
plugin runs `npx -y lionscope@<version> mcp` itself: remove a `lionscope` MCP server you added by hand, or the
agent sees every tool twice. New releases arrive with `/plugin marketplace update lionscope` (or with the
marketplace's auto-update turned on in `/plugin`).

**Any harness, with the skills CLI** ([vercel-labs/skills](https://github.com/vercel-labs/skills), which knows
where each agent keeps its skills): `npx skills add risyadul/Lionscope` (add `-a codex`, `-a opencode`, … to pick
the agents, `-g` for your user rather than the project).

**By hand**: copy the `skills/lionscope` folder (or download its `SKILL.md` into a folder named `lionscope`) to:

| Harness                               | Project                                                                            | Your user                                                                                                                                     |
| :------------------------------------ | :--------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                           | `.claude/skills/lionscope/`                                                        | `~/.claude/skills/lionscope/`                                                                                                                 |
| Codex                                 | `.agents/skills/lionscope/`                                                        | `~/.agents/skills/lionscope/`                                                                                                                 |
| OpenCode                              | `.opencode/skills/lionscope/` (also reads `.agents/skills/` and `.claude/skills/`) | `~/.config/opencode/skills/lionscope/`                                                                                                        |
| Hermes Agent                          |                                                                                    | `~/.hermes/skills/lionscope/`, or `hermes skills install https://raw.githubusercontent.com/risyadul/Lionscope/main/skills/lionscope/SKILL.md` |
| Cursor, Gemini CLI, GitHub Copilot, … | their skills folder (see their docs)                                               |                                                                                                                                               |

A copied skill stays at the version you copied: copy it again after updating Lionscope. Installs from the skills
CLI update with `npx skills update`. The skill pins the npm version it was written for (`npx -y lionscope@<version>
query`), so its shell commands match the tools it describes.

## Letting an agent operate the device

Device tools are off by default: an agent can read data and start or stop sessions, but not touch the screen.
Turn them on with `--allow-device-control`, either for one MCP client (`npx -y lionscope mcp
--allow-device-control`, e.g. `claude mcp add lionscope -- npx -y lionscope mcp --allow-device-control`) or for
the whole server (`npx lionscope --allow-device-control`, which also enables them on `/mcp`). They run through
adb (`screencap`, `uiautomator`, `input`, `am start -W`) on emulators and physical devices alike, so they can do anything you could
do with the device in your hand: keep them off while a phone with personal data is connected. Emulators this
server did not boot are shut down only with `confirm: true`.

Two ways to aim:

- **By element** (precise): `get_ui_tree` reads the screen's accessibility tree (see below), and
  `tap_element { text: "Checkout" }`, `wait_for { text: "Order placed" }` and `scroll_to { id: "row_title",
text: "Row 40" }` find elements by visible text or content description, resource id (`login_button`),
  description or a field's hint (`hint: "First name"`, which keeps matching once the field has text where the
  dump lists hints), and tap the exact center of the element. A selector that matches several elements taps
  nothing and returns the candidates; `nth` picks one. `tap_element` reads the element back after the tap
  (`after`, `null` when it moved or is gone; `checked` before and after for a switch, also the only one inside a
  tapped row; `screenChanged`, which content that changes on its own also sets, so `false` is the reliable
  signal; `readBack: false` skips that dump). An element under the soft keyboard is not tapped (the dump does
  not show the keyboard, so `tap_element` reads its frame from `dumpsys window`): the part above a docked keyboard
  is tapped when it is high enough and no other element that takes taps (a button bar the app lifted above the
  keyboard) is there; otherwise nothing is tapped and the error says to hide the keyboard (`press_key back`)
  first. Other windows on top (another app's dialog, an overlay) are not checked.
  `type_text { text, field: { id: "email" } }` taps the field first,
  then reads the field back (`field`, `sameField`, and `matches`: whether the text arrived). Text goes in at the
  caret (where the tap landed); `mode: "append"` types at the end, `mode: "replace"` instead of the field's text,
  and `replace` with `text: ""` clears the field. Password fields never return their text.
- **By coordinates**: `screenshot`, then `tap` / `swipe` in the screenshot's pixels. Use it where the tree
  can't see: Jetpack Compose elements get a resource id only with `Modifier.testTag` plus
  `testTagsAsResourceId = true` (otherwise use their text or content description), and WebView, canvas, game
  or video content may be missing from the tree. `readBack: true` compares screenshots taken before and after
  (300 ms after a tap, 500 ms after a swipe), leaving out the status and navigation bars: `screenChanged` (a
  16×16 px area or more differs) and `changedShare` (how much of the screen differs), which also sees a map or
  canvas that moved; it adds 1 to 3 s. A blinking caret or an animation sets it too, so `false` is the reliable
  signal. A `tap` on the soft keyboard returns a `warning`.

Each of those tools is one round trip, far too slow to put two taps 50 ms apart. `run_inputs` runs a sequence
in one `adb shell` call: `{ "type": "tap", "x": 360, "y": 800 }` (screenshot pixels, like `tap`),
`{ "type": "tap_element", "text": "Save" }` (the selectors of `tap_element`, plus `index` and `nth`),
`{ "type": "key", "key": "back" }` (the keys of `press_key`) and `{ "type": "wait", "ms": 50 }`. It takes at most 100
steps, waits of at most 60 s in total, and at most 80 s for the waits plus 500 ms per input (what `input` can take on
older Android, where it starts a VM), so that the sequence fits in one call. Every element is found in one fresh UI
dump and every coordinate mapped before the first input is sent, so a selector that matches nothing, or several
without `nth`, fails the call with nothing sent. It also means a `tap_element` step must name an element that is on
the screen when the call starts: for one that an earlier step opens (a dialog's OK), use a `tap` with coordinates
from a screenshot of that screen, or a separate call, or a match on the current screen is tapped where it was. The
soft keyboard is checked as `tap_element` checks it, as it is when the call starts: a `tap_element` step whose
element the keyboard covers fails the call with nothing sent (hide the keyboard with `press_key back` first), unless
enough of it shows above a docked keyboard to tap there. The
spacing between two inputs is the wait plus what the input itself costs (`input` took 15-30 ms per tap on an Android
16 emulator, a key more, and it costs more on older versions; a `sleep` runs 5-10 ms longer than asked): the result
gives each step's end (`atMs`, from the start) and duration (`tookMs`) as the device's shell clock
(`$EPOCHREALTIME`, Android 7.0+) measured them, and `totalMs`, the end of the last step that finished. A step that
fails stops the sequence and is named in `failed`. If the sequence stops otherwise (adb drops, the time runs out),
`incomplete` says why and how many steps ran; later ones may have run too, so check the screen before running it
again. When adb fails only after every step ran, `warning` says so instead.

The tree comes from Lionscope's UI helper (Android 7.0 and later): a small program the server runs on the device
over adb that keeps one accessibility (UiAutomation) connection open, reads a screen in a few hundred ms and does
not wait for animations to stop. While it is connected (until 20 s after the last read) apps see accessibility as
enabled, which some change their behaviour or performance for, and no other UI automation (Appium, a uiautomator
test) can connect. When the helper can't be used it falls back to `uiautomator dump`, which takes a second or two
and needs the screen to be idle; on a screen that keeps animating it fails (after retries) and the error suggests
the screenshot route. Coordinates follow the device's current
rotation (from `wm size` and the display rotation, never from a dialog's window): a screenshot taken before the
screen rotated is refused instead of tapping the wrong spot, so take a new one. `type_text` takes printable
ASCII and can't type the sequence `%s` (adb's own escape for a space). Its `append` and `replace` modes use
ctrl+End and ctrl+A on Android 13 and later; on older versions `append` presses End (the end of the caret's line in
a multi-line field) and `replace` deletes the characters the UI tree shows, so it can't clear a password field
there, and in a multi-line field whose text wraps without line breaks it may leave part of the text. Unless the
field takes the focus (one that opens a picker doesn't), they send no key. `launch_app` starts the launcher activity with `am start -W` and returns Android's launch time. At most
two device actions run at once per device; more get a busy answer.

For state-restore bugs (a form that loses its text after the app comes back), these tools reproduce what Android
does to an app in the background, and show that it happened:

- `get_activity_instance` returns the activity on screen, the identity hash of its Activity object (from
  `dumpsys activity top`) and the app's PID. Called before and after a scenario it says whether the activity was
  recreated (`recreated`) and whether the process was restarted (`processRestarted`). Going to the background and
  back keeps the same instance.
- `set_dont_keep_activities { enabled: true }` turns on Developer options' "Don't keep activities": every activity
  is destroyed as soon as it leaves the screen (HOME, or the next screen opening). Like Settings, it calls the
  activity manager's `setAlwaysFinish` (from a one-shot run of the UI helper's jar), so it takes effect at once;
  `settings put global always_finish_activities 1` alone changes only the stored value, which the system reads
  at boot. `verified` needs the activity manager's own flag (`dumpsys activity processes`) and, when turning it
  on, that the activities in the background that still had their process were destroyed (`destroyCheck`, null when
  there were none or it was on already; `destroyed: 0` means not yet: Android does it at its next process-priority
  update). If it cannot be switched on, the call fails and nothing is changed. It applies to every app on the
  device until turned off with `enabled: false`. What Lionscope turned on it puts back as it was (the flag and the
  stored setting) when the device's profiling session stops or Lionscope stops, and retries a failed put-back when
  the device comes back (`autoOff`); `status` lists it per device (`dontKeepActivities`). A value that was already
  on before is left to you.
- `simulate_process_death { packageName }` presses HOME, waits until the app's activity is stopped (its state
  saved), kills the process with `am kill` (only a background process, unlike `stop_app`'s force-stop, which
  discards the saved state and the task), checks that it is gone, and brings the task back the way Recents does
  (`startActivityFromRecents`, from another one-shot run of the UI helper's jar): the activity that was on top is
  recreated in a new process. A launcher intent (`am start`) is not used: it would add an activity on top of a
  task that was started by `am start -n` (as `launch_app` does). `am kill` spares a process with a foreground
  service (`killed: false`); `reopen: false` only kills. `resumed: false` means the activity did not come back
  within 15 s, e.g., because the app crashed while restoring its state (see `get_crashes`).
- `bring_to_front { packageName }` brings an app's task back the same Recents way without killing it: use it to
  return to the app after HOME. `launch_app` (`am start -n`) can instead start the launcher activity on top of a
  task the user opened from the home screen.

## From the shell

```bash
npx lionscope query --list                       # every tool, its description and input schema
npx lionscope query status
npx lionscope query summary --window 5m
npx lionscope query stalls --include-stacks
npx lionscope query logcat --level E --limit 50
npx lionscope query crashes --limit 5
npx lionscope query start-session --serial emulator-5554 --package-name com.example.shop
npx lionscope query screenshot --allow-device-control --out screen.png
npx lionscope query run-inputs --allow-device-control \
  --steps '[{"type":"tap_element","text":"Save"},{"type":"wait","ms":50},{"type":"key","key":"back"}]'
npx lionscope query inspector-selection --out element.png   # what you selected in the Inspector
npx lionscope query network --status 5xx --window 10m
npx lionscope query network-request --id 12 --allow-network-bodies
```

Arguments are `--name value` flags (kebab or camel case) or `--json '{"window":"5m"}'`; short names work
without the `get_` / `search_` prefix. The result is JSON on stdout; on failure the exit code is 1 and stdout
holds `{"ok": false, "error": "…"}`. `query` needs a running server (`--port` to pick it).

## Safety notes

- Everything stays on this machine: the endpoints listen on 127.0.0.1 and refuse requests a web page could make
  (see [Security model](security.md)).
- Log lines, tags, screen, layout and class names and stack frames come from the app being profiled, and so do
  the view text, content descriptions, resource ids and image crops in Inspector results. Tool results mark them as untrusted data, and agents should treat them
  as such: a log line or a label is never an instruction.
- Text on the screen reaches an agent through the Inspector only via `get_inspector_selection` for the one element
  _you_ selected (with a crop of it, never of a whole window or a large part of the screen) and via
  `inspect_screen` (device control; no image). An element the agent selects itself (`select_inspector_node`,
  marked **AI** in the dashboard) gives it structure only: class, id, layout source, owner and bounds. Password
  fields are never read, and screenshots are never cached by the browser.
- URLs, headers and bodies of HTTP requests come from the app and its servers and are marked as untrusted data too.
  Credential-looking values in headers, URLs, forms, JSON and XML are redacted before they leave the device; bodies
  reach an agent only with `--allow-network-bodies`.
- `--allow-device-control` keeps an AI from operating a device unasked; it is not a security boundary, since
  any local process can already use adb. The same goes for `--allow-network-bodies` (any local process can read
  the dashboard socket); it keeps request and response bodies out of an AI's context unless you want them there.
