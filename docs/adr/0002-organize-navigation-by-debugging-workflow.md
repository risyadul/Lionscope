---
status: accepted
---

# Organize navigation by debugging workflow

The Profiler's side panel currently mixes seven tabs while Layout Inspector also has its own top-level mode.
Use five primary workspaces: Profiler (timeline, Screens, Stalls, Layouts, and Saved State), Layout Inspector,
Network (Requests and Mocks), Storage (databases and preferences), and Device. Network and Storage need room
for their own workflows, while Profiler's tabs should focus on performance analysis; a request selected on the
timeline must still lead to that request's details.

## Navigation and context

A labeled left sidebar replaces the current Profiler/Inspector/Device mode switch; at narrow widths it becomes
a drawer. Clicking a request on the Profiler timeline opens contextual details alongside the charts, with an
Open in Network action for the dedicated workspace.

Switching workspaces preserves Storage's selected table, selected row, and draft while the app and SDK link
remain the same. A different app or a newly established SDK link clears the old draft; navigation must never
retarget a draft to another row or link.

The device mirror remains available in Profiler and Layout Inspector. In Network and Storage it starts closed
and can be opened explicitly, leaving room for request details and data editing. Device makes the screen its
primary content. Global device selection, app selection, and session Start/Stop controls remain outside the
individual workspaces; switching workspaces does not stop session recording.

Storage uses a database/table list, grid, and row editor, with a sheet for the editor at narrow widths; its
draft, conflict, and revert behavior is defined in [the Storage editing decision](0001-edit-storage-values-for-debugging.md).

## Implementation status

Implemented with device protocol 12 for original Storage values and atomic row edits. Older negotiated links
retain their legacy restrictions; single-field Room drafts can use the v11 scalar update. JVM tests and synthetic
dashboard browser checks cover the new behavior; these checks do not establish runtime behavior on an Android
device or additional API/Room versions.
