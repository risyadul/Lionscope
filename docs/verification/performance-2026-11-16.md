# Performance baseline, 16 November 2026

Measured commit `0f2f5a5` on an Apple M4 Pro with 24 GiB RAM, macOS 27.2.1, Node 26.8.2 and headless Chromium
147.0.0.0. Android runs used the existing Pixel 9 emulator, API 36, with host rendering. This is a small local
baseline for the recent dashboard/Storage work, not a general performance guarantee or a controlled benchmark
of the entire consumer app. [Recorded measurements](data/performance-2026-11-16.json) include individual Android
runs, browser summaries and measurement limits.

## Dashboard rendering

The existing browser fixture was built with Vite production optimizations and served separately on loopback.
It renders real Storage components with synthetic responses: 50 rows and three columns. At 1440 x 900 and
430 x 932, each action had five warm-ups and 30 measured repetitions. The probe starts immediately before
activating the control, waits for the expected DOM state, then waits two animation-frame callbacks.
Before each Query run, switching its database clears the previous result so the probe waits for fresh rows.

| Action                 | Desktop median / p95 | Narrow median / p95 |
| ---------------------- | -------------------- | ------------------- |
| Open row               | 33.4 / 33.5 ms       | 33.4 / 33.5 ms      |
| Open field draft       | 33.3 / 33.4 ms       | 33.2 / 33.4 ms      |
| Switch to Query        | 33.3 / 33.4 ms       | 33.4 / 33.5 ms      |
| Run synthetic Query UI | 50.0 / 50.1 ms       | 50.0 / 50.1 ms      |

No task over 50 ms was reported by PerformanceObserver during the measured interactions. A separate narrow
rerun captured a Chrome trace with 4,130 renderer main-thread tasks, a maximum of 13.547 ms and no task over
50 ms during the post-load interaction period. The raw trace is local at `/tmp/lionscope-ui-performance-trace.json`.

The two-frame wait imposes an approximately 33 ms floor, so these probes show that this small fixture settled
within two to three frames; they are not precise input latency or INP measurements. Programmatic control activation
does not reproduce all hardware input costs. The narrow run resizes desktop Chromium and does not emulate a
physical phone's CPU. The fixture excludes live profiler updates, real SQL/SDK latency and emulator decoding.
Heap snapshots without controlled GC do not establish memory overhead or absence of leaks.

The initial Query probe could observe the previous run's already-populated grid. Requiring a cleared result
before each execution corrected that probe; the table uses the final fresh-result runs rather than its earlier
approximately 33 ms Query result.

The two latest design/test commits introduce no executable production-source change: their only
`dashboard/src` difference is a token comment. Fixture markers and Playwright imports were absent from the
dashboard/CLI outputs. The production main bundle remains approximately 688 kB before compression, with the
existing large-chunk advisory; this task does not establish a before/after speedup for the earlier UI fixes.

## Server and emulator stream

CPU uses the change in macOS process CPU time over elapsed wall time. Both periods retain the existing
consumer profiling session. Other browser clients and host processes were not controlled. The second period
adds one owned screen WebSocket at 540 px, capped at 30 FPS; its PNG bytes were counted and discarded, with no
screenshots or app content retained.

| Observation                | Passive, about 30 s | One additional mirror, about 30 s |
| -------------------------- | ------------------- | --------------------------------- |
| Server CPU, one core       | 0.40%               | 6.32%                             |
| Median server RSS          | 52.5 MiB            | 115.3 MiB                         |
| Additional received frames | None                | 900, approximately 30 FPS         |
| Additional local traffic   | None                | 8.27 MiB/s                        |

This illustrates the cost of an active stream on this changing screen. It does not include browser decoding
or isolate emulator-process CPU. RSS is a process snapshot affected by GC and buffer residency, not an
allocation delta or leak diagnosis. An extra client may also duplicate work, so this is not a universal cost
per dashboard. Storage/Network's default shown mirror can activate this work when the workspace opens.
Hiding the mirror disables `useScreenStream`, closes its socket and disposes its decoder.

## Storage roundtrip

Constant-only recursive SELECT queries ran through the current consumer app's registered Room instance.
They read no application tables and performed no writes. Each case used five warm-ups and 30 samples, spaced
100 ms apart, through the dashboard WebSocket. Roundtrip includes server, SDK, transaction, encoding and
transport; `txMs` is the SDK's transaction measurement and has millisecond resolution.

| Requested result | Returned result                   | Roundtrip median / p95 | Transaction median / p95 |
| ---------------- | --------------------------------- | ---------------------- | ------------------------ |
| 50 x 3 cells     | 50 rows, about 4.8 kB             | 14.6 / 135.9 ms        | 0 / 62 ms                |
| 200 x 32 cells   | 165 rows, about 164 kB, truncated | 16.0 / 80.7 ms         | 6 / 29 ms                |

The wide result correctly reaches the console's 160 KiB row budget and advertises truncation. The initial
benchmark incorrectly required all 200 rows and failed twice; inspecting `consoleRows` identified the intended
bound, and the completed run accepts a bounded, truncated result. Those failures were benchmark assumptions,
not a product defect. A 0 ms median transaction is below timer resolution, not evidence of zero work.

These lightweight queries do not establish latency for real joins, sorts, large offsets, mutations or
contended databases. Storage work runs on `lionscope-storage`, but a Room transaction can delay app writers;
the cooperative 250 ms transaction budget is not a hard SQL deadline. See [Storage](../features/storage.md#what-it-does-to-the-app).
This API 36 measurement does not replace the feature's broader compatibility acceptance tests.

## Android profiling modes

Two APKs used the same debug sample configuration, with the real SDK dependency substituted by `lionscope-noop`
for the baseline. Both are debuggable; the real APK has LionscopeInitializer and the no-op APK does not. These
were built from the measured source, without modifying the consumer app or publishing a new dependency.
The sample reports SDK version 0.12.0, the repository's default version label; the measured consumer link
reports 0.13.0-pr34-local. No version was changed for this test.

Run order was no-op, SDK, SDK, no-op, no-op, SDK. Each run cold-started the sample, selected its normal List,
verified deliberate slow binding was off, warmed up three up/down swipe pairs, measured 15 seconds idle, then
ten up/down swipe pairs at 300 ms per gesture plus one second to settle. CPU comes from app process ticks
(`CLK_TCK=100`); memory is `dumpsys meminfo -s` PSS after scrolling.

These PSS probes did not use the profiler's `--local` system-side option. App-side memory dumping can induce
GC, so treat them as post-dump snapshots rather than steady-state memory usage or allocation cost. The same
probe was used in both variants, outside the timed CPU interval, but its effects on subsequent work are not isolated.

| Metric, median of three runs | No-op / ADB-only | SDK active |
| ---------------------------- | ---------------- | ---------- |
| Idle app CPU, one core       | 0.33%            | 0.53%      |
| Scrolling app CPU, one core  | 10.40%           | 10.99%     |
| App PSS after scrolling      | 99.3 MiB         | 99.8 MiB   |
| App threads                  | 21               | 25         |

Idle CPU differs by about 0.20 percentage points and scroll CPU by 0.59 points in these medians. Scroll CPU
ranges overlap: 10.03–13.30% without SDK and 10.18–11.76% with it. PSS ranges also overlap: 92.1–102.2 MiB and
98.1–107.7 MiB. Three runs and uncontrolled GC/JIT/host load do not establish a precise 0.5 MiB memory cost or a
statistically reliable scroll slowdown.

This compares operational profiling modes. Without the SDK, Lionscope polls gfxinfo; with SDK frames flowing,
it pauses that poll. The differing collector work prevents interpreting the difference as isolated SDK cost.
The first A/B attempt was discarded because the profiler's `gfxinfo ... reset` cleared the separate frame dump.
The final runs retain session frame diagnostics, but their gfxinfo/SDK sources differ; frame/jank differences
are not presented as an SDK regression. The normal sample list also does not measure heavy Compose, HTTP
capture, Storage-under-write-contention or long-session SDK behavior.

The user approved replacing the active recording. After measurement the sample was stopped, the consumer
profiling session was recreated and its existing task brought forward. Status confirmed it running with SDK
0.13.0-pr34-local connected. Its process ID differs from the pre-test one, so this was not restoration of the
original in-memory process or recording. The consumer APK and persistent application data were not modified.

## Assessment and follow-up

The measured small Storage UI remains responsive, and these sample runs do not show a large CPU/memory penalty
for the SDK-enabled profiling mode. The mirror is the clearest additional server/traffic cost measured here.
Keep its shown-by-default behavior, but include active streaming in future end-to-end performance checks.

Before setting hard performance gates, repeat on a quiet host and a physical device, use a matched external
frame source, test larger UI payloads and real database contention, and run a longer memory soak. Add dedicated
SDK startup/CPU/allocation measurements if an isolated SDK overhead claim is needed. The layout suite is not
a substitute for those checks, and its screenshots do not measure render latency.

Commands used include `npx vite build --config dashboard/browser/vite.config.ts --outDir /tmp/lionscope-performance-ui-dist`,
`agent-browser profiler start/stop`, local browser timing probes, `./gradlew :sample:assembleDebug`, a second
debug assembly with a temporary no-op dependency-substitution init script, and Lionscope CLI/ADB measurements.
Both APK builds passed. Benchmark harness issues and their corrections are recorded above. This scope adds
measurement documentation only; formatting, documentation links and `git diff --check` are the applicable
repository checks. No product implementation or CI performance threshold was changed.
