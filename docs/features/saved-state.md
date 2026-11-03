# Saved state: what makes it too large

When an Activity goes to the background, Android sends its saved state (`onSaveInstanceState`, including every
Fragment's state and arguments) to the system in one binder call. Above about 500 KB-1 MB that call fails, and
since Android 7 the app crashes with `TransactionTooLargeException` while the user is not even looking at it.

**Without the SDK**, the server reads these failures from logcat: JavaBinder's `!!! FAILED BINDER TRANSACTION !!!
(parcel size = N)` line of the app's process and the crash caused by the exception (`data parcel size N bytes`,
the failed call such as `IActivityManager.activityStopped`, or `IActivityClientController.activityStopped` from
Android 12). A line and its crash within 3 s are one failure. Each failure is a **TOO LARGE n KB** marker on the
timeline and a row in the **State** tab, `get_crashes` adds `transactionTooLarge` (parcel size, failed call) to such
a crash, and `get_saved_state` lists them (the screen on top, when the SDK names screens).

**With the SDK (0.12.0+)**, every Activity's saved state is measured once the save is complete, i.e. what the system
is about to send: its size as the system parcels it and, from 64 KB, the largest keys down through nested and child
fragments, each Fragment's state named by its class (`OrderListFragment (fragment_b2…)`). The State tab lists the
reports of the selected window, largest first; a report opens to its keys, indented by depth, with each key's share of
the total (a key includes everything nested in it). States of 64 KB or more are also **STATE n KB** markers on the
timeline. A failure is joined with the newest report of the same process at or before it within 3 s (the nearest one
after it when there is none before); the SDK and logcat are separate streams, so a report that arrives late replaces
an older one. `get_saved_state` answers both "what failed" and "which fragment made it big".

- **When it measures.** `ActivityLifecycleCallbacks.onActivitySaveInstanceState` is too early: it runs inside the
  Activity's `super.onSaveInstanceState()`, before `ComponentActivity` saves the Fragment state and before keys the
  app puts after `super` (measured there, the sample's 440 KB state reads 1.5 KB). On API 29+ the SDK measures in
  `onActivityPostSaveInstanceState`. On API 23-28 it posts the measurement from `onActivitySaveInstanceState` to the
  main thread: it runs after the save returned and before the system reports the stop (that report is posted to the
  same queue later; checked on API 23, 28 and 31 by the order of the measurement and JavaBinder's line; on API 23-27
  the save comes before `onStop`, and the measurement after it). Both see keys added after `super` and an Activity
  that goes to the background without being destroyed.
- **The app's bundle is never changed.** The total is one `Parcel` write of the bundle; the breakdown writes copies
  (`Bundle(Bundle)`) key by key. Values are never read into the report: only keys, value class names and sizes.
  Keys are strings the app chooses, so they are redacted like captured HTTP text, on the device and again on the
  server: a URL's query values and userinfo, sensitive `name=value` pairs and `Bearer …` credentials become
  `‹redacted›`; a plain key name such as `token` or `password` stays.
- **Fragments.** With androidx.fragment 1.5+ each Fragment's state is a `fragment_<who>` Bundle; with 1.4 the SDK
  opens androidx's own state records by reflection (tested with 1.4.1 and 1.6.2). Without androidx.fragment, or if
  a future version renames those fields, the record is listed by its size and class without the Fragments in it.
  Each Fragment instance is listed once, also one nested in a Fragment of its own class.
- **Per Activity, live and trend.** The SDK numbers each Activity object of the process (1, 2, 3…) and tells the
  server which ones are alive whenever one is created or destroyed (at most four times a second, the last change
  always sent) and after each (re)connect. The State tab lists the **Live** Activities, each with its last save, its
  number (`#2`) and how its saves grew in the window (`125 → 163 KB · 3 saves`, or `not saved yet`), largest or latest
  first; a row opens to its saves, newest first, each with its keys. An Activity recreated by a configuration change
  (rotation) continues the row of the one it replaced (`#2 ← #1`). Finished ones and those of an ended process fold
  into **Closed**. A TransactionTooLarge failure keeps its saved-state report, keys included, for the whole session
  (up to 1 MB of reports together, the oldest go first). Limits: an Activity recreated any other way ("Don't keep
  activities", process death) is a new row; after the link was down, a finished Activity closes when the SDK
  reconnects, not when it finished; a PID that a new process reuses within the window could be mistaken for the old
  one. Reports from a pre-release 0.12.0 SDK carry no number and are listed apart (**Unattributed**).

Main-thread cost. Each report carries two **separate** timings: `measureMs`, the one `Parcel` write that gives the
total, and `breakdownMs`, the key-by-key breakdown that follows it (from 64 KB only; it does not include
`measureMs`). What the save costs is their sum for that report; its percentiles below are of the per-report sums,
not sums of percentiles. The measurement runs on the main thread after the save and before the system reports the
stop (`activityStopped`), so it delays that report by this much; the latency of the binder call itself was not
measured. Saving happens once each time an Activity goes to the background, never per frame.

Sample state (443 KB: 3 ViewPager pages, each with a nested child fragment, plus 120 KB put after `super`), debug
build, androidx.fragment 1.6.2, API 31 emulator (Pixel 4a), 130 saves of which the first 10 are left out as warm-up:

| Run                                          | `measureMs` p50 / p95 | `breakdownMs` p50 / p95 | Per-save total p50 / p95 / max | p95 of the total per 40 saves |
| -------------------------------------------- | --------------------- | ----------------------- | ------------------------------ | ----------------------------- |
| Run 1 (renderer and host load not recorded)  | 0.68 / 6.16 ms        | 1.10 / 4.86 ms          | 1.86 / 14.98 / 49.89 ms        | 25.28, 3.76, 15.22 ms         |
| Run 2 (software renderer, host load avg ~37) | 1.07 / 12.08 ms       | 2.39 / 43.23 ms         | 4.77 / 83.02 / 166.53 ms       | 49.33, 52.47, 83.02 ms        |

These are local results, not a budget or a guarantee. The median is a few milliseconds; the tail moves a lot between
runs and between batches of the same run (the p95 of 40 saves ranged from 3.8 to 25 ms in run 1), and it was far
higher in run 2, on a loaded host with software rendering. What causes the spikes (GC, JIT, host scheduling) was
not isolated. An earlier 20-save run gave a p95 `measureMs` of 9.88 ms on the API 31 emulator and 0.47 ms on an
API 28 one (total p95 not computed then); 20 saves are too few for a stable tail. A 13 KB state costs about 0.3 ms
(the total only, no breakdown).

Turn it off with the **Saved-state tracking** switch in the State tab (`set_sdk_options` `savedStateTracking:
false`) and nothing is measured; switch it on again the same way. It is also idle outside a profiling session and on
servers older than 0.12.0.
