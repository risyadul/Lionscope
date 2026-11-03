# Finding the line that blocks the main thread

With the SDK (0.2.0+ SDK and server), a watchdog thread posts a tick to the main thread every 50 ms. When a
tick is not run within the threshold, it samples the main thread's stack every 50 ms until the block ends, then
reports one stall: when it started, how long it lasted, the screen on top, and the most frequent sampled stack
(a block is cut at 30 s). The dashboard ranks stalls by their culprit line (`Class.method (File.kt:87)`): the
first app frame, skipping generated ViewBinding/DataBinding classes for the code that inflates them; when no app
frame was on the stack, the first library frame outside the Android, Java, Kotlin and AndroidX packages (a
third-party SDK blocking the main thread). It shows the stack with framework frames collapsed, and flags stalls
that happened while a debugger was attached.
The threshold is chosen in the Stalls tab (100, 150, 250, 500 or 1000 ms; default 150 ms). The watchdog runs only
while a dashboard is connected at protocol v2 and an activity is started.

**Where the work came from (0.9.0).** With RxJava's `observeOn(AndroidSchedulers.mainThread())` or a coroutine on
`Dispatchers.Main`, the main-thread stack shows the scheduler or the dispatcher and the lambda, not who scheduled
it. Each stall therefore also gets an **origin**, and the Stalls tab's **By origin** view ranks them like the
culprit lines (count, total and worst blocked time; a row filters the events):

- **RxJava**: the operator whose task ran (`observeOn`, `subscribeOn`, `timer`…) and **the line that subscribed
  the chain** (`HomeViewModel.load (HomeViewModel.kt:40)`, with its stack in the stall detail), plus the
  chain's final consumer. The subscribe site comes from the SDK's RxJava 2 hooks (below); without them the
  origin still names the operator and the first app frame it ran.
- **Coroutine**: the dispatcher (`Dispatchers.Main`, Compose's `AndroidUiDispatcher`), the continuation that
  was resumed (`HomeViewModel$refresh$1`, at its current line) and, when the app runs kotlinx.coroutines debug
  mode (`System.setProperty("kotlinx.coroutines.debug", "on")` in the debug `Application.onCreate`), the
  coroutine's name and id (`refresh-cart#2`, from `CoroutineName`).
- **Handler**: the posted `Runnable` (`lambda in HomeFragment`, `LiveData.postValue`) or the `Handler` that
  handled the message; **Input** (an input event, a click or long press); **Frame** (layout and draw, animators,
  Compose's frame); **Lifecycle** (activity, service and receiver callbacks); **Idle** (an idle handler).

The origin is read from the stack's outermost frames (the Looper's dispatch), which SDK 0.9.0 sends even when
the stack is longer than the 64 frames kept, so stalls from older SDKs get one too as long as their stack reaches
the Looper. The Main thread lane's tooltip names the origin of each bar.

**RxJava tracking (on by default, SDK 0.9.0, RxJava 2).** The switch in the Stalls tab installs two kinds of
`RxJavaPlugins` hooks during a session: a schedule handler that marks which Rx task the main thread is running,
and subscribe hooks that keep the stack of each `observeOn` subscription (kept as the VM captured it, at most 100
per second; turned into frames only for a stall, and dropped with the chain). Each hook calls the one the app had
installed before it, and is removed when the session ends or the switch goes off, unless the app has replaced it
since (then it stays in the app's chain as a pass-through, and is never installed twice). Nothing is installed
when `RxJavaPlugins` is locked down, outside a profiling session (an inspect-only link, no dashboard) or in an
app without RxJava 2 (RxJava stays a compile-only dependency of the SDK). Measured on an API 36 emulator: the
schedule handler costs nothing measurable, the subscribe hooks 1–3 µs per `observeOn` subscription (stack depth
14–58), against 13–14 µs when the stack is materialised at subscribe time like RxJava's assembly tracking does.
RxJava 3 is not hooked yet (its stalls still get an origin from the stack). The SDK's consumer ProGuard rules keep the
names of the RxJava operators and fields the hooks read, for debug builds that are shrunk.

**StrictMode (opt-in, off by default).** The Stalls tab has a toggle for it (Android 9 / API 28+). When on, the
SDK extends the app's current main-thread and process StrictMode policies with disk read/write, network, custom
slow call and leaked-closable detection, and reports each violation with its stack. It restores the app's
policies when you turn it off or the link closes. It refuses to touch a policy that has a death, dialog, flash
or dropbox penalty, or that looks like it has the app's own `penaltyListener`, and it never re-arms a
death-on-network penalty; the Stalls tab then says nothing was added. Violations are coalesced to one per second
per stack, and at most 10 per second overall.
