# Lionscope

Lionscope is a local workspace for profiling, inspecting, and operating a debug Android app.

## Language

**Profiler**:
The workspace for diagnosing app performance across a shared timeline, including screens, stalls, layout
inflation, and saved-state size.

**Layout Inspector**:
The workspace for examining an app's view hierarchy, layout sources, and view properties, including live edits.
_Avoid_: Inspector when it could also mean the Storage Inspector

**Network**:
The workspace for examining the app's HTTP requests and configuring mock responses or failures.

**Storage Inspector**:
The workspace for reading and editing the app's preferences and registered databases, labeled Storage in navigation.

**Query console**:
The SQL editor inside Storage for explicit queries and mutations on a registered database. Its result grid is a
read-only projection; SQL mutations have no row-editor compare-and-set or undo contract.

**Device**:
The workspace for viewing and operating the connected Android device or emulator.
