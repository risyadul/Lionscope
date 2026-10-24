package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.util.Collections
import java.util.IdentityHashMap

/**
 * Turns the v2 features on and off (main thread only). The watchdog runs in a session link at v2 and an
 * activity is started; StrictMode reporting in a session link at v2 and the session's `config` asks for
 * it, deliberately also while the app is in the background with the link up (background violations are just as
 * real). The RxJava hooks ([rx]) run in a session link at v9 whose options keep `rxTracking` on, in the background
 * too (a chain subscribed there may stall the main thread later). Options fall back to [SdkOptions.DEFAULT] on every
 * link change until the next `config`.
 */
internal class DiagnosticsController(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val watchdog: Watchdog,
    private val strictMode: StrictModeSwitch?,
    private val rx: RxTracking? = null,
) : Application.ActivityLifecycleCallbacks {
    private val started: MutableSet<Activity> = Collections.newSetFromMap(IdentityHashMap())
    private var linkV2 = false
    private var linkV9 = false

    var options = SdkOptions.DEFAULT
        private set

    init {
        link.addSessionListener { welcomed ->
            val version = if (welcomed) link.negotiatedVersion ?: 0 else 0
            main.post(Runnable { guarded { onLinkChanged(version) } })
        }
        link.addConfigListener { options -> main.post(Runnable { guarded { onConfig(options) } }) }
    }

    override fun onActivityStarted(activity: Activity) = guarded {
        started.add(activity)
        update()
    }

    override fun onActivityStopped(activity: Activity) = guarded {
        started.remove(activity)
        update()
    }

    override fun onActivityDestroyed(activity: Activity) = guarded {
        if (started.remove(activity)) update()
    }

    override fun onActivityResumed(activity: Activity) = guarded { strictMode?.onActivityResumed() }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    private fun onLinkChanged(version: Int) {
        linkV2 = version >= DEVICE_PROTOCOL_V2
        linkV9 = version >= DEVICE_PROTOCOL_V9
        options = SdkOptions.DEFAULT
        update()
    }

    private fun onConfig(options: SdkOptions) {
        if (!linkV2) return
        this.options = options
        update()
    }

    private fun update() {
        watchdog.thresholdMs = options.stallThresholdMs
        if (linkV2 && started.isNotEmpty()) watchdog.start() else watchdog.stop()
        strictMode?.setEnabled(linkV2 && options.strictMode)
        rx?.setEnabled(linkV9 && options.rxTracking)
    }
}

/**
 * Queues stalls and StrictMode samples as v2 messages, encoded later on the link thread (never on main, never under
 * the watchdog's lock). Frames are app-owned by the same rule as screens, against the top activity at encoding time.
 */
internal class DiagnosticsSink(
    private val link: LinkPort,
    private val ownership: AppOwnership,
    private val rx: RxTracking? = null,
    private val topActivityClass: () -> String?,
) {
    /** The v9 origin fields (outer frames, the Rx chain, the coroutine name) only go out on a v9 link. */
    fun stall(stall: StallDetector.Stall) {
        link.sendV2(sizeHint(stall.stack) + sizeHint(stall.outer)) {
            val v9 = DeviceLink.speaks(link.negotiatedVersion, DEVICE_PROTOCOL_V9)
            val outer = if (v9 && stall.outer.isNotEmpty()) map(stall.outer, longer = false).frames else emptyList()
            val task = stall.rxTask
            val rxOrigin = if (v9 && task != null) rx?.describe(task) { map(it, longer = false).frames } else null
            val coroutine = if (v9) CoroutineNames.parse(stall.threadName) else null
            StackFrames.fitLine(map(stall.stack, stall.stackCut)) { frames, truncated ->
                DeviceMessages.stall(
                    ts = stall.ts,
                    durationMs = stall.durationMs,
                    frames = frames,
                    samples = stall.samples,
                    truncated = truncated,
                    screen = stall.screen,
                    debugger = stall.debugger,
                    outerFrames = outer,
                    rx = rxOrigin,
                    coroutine = coroutine,
                )
            }
        }
    }

    /** No `truncated` on the wire for StrictMode: a cut stack is simply shorter. */
    fun strictMode(event: ViolationEvent, count: Int) {
        val stack = event.violation.stackTrace
        link.sendV2(sizeHint(stack)) {
            StackFrames.fitLine(map(stack, longer = false)) { frames, _ ->
                DeviceMessages.strictMode(
                    ts = event.wallMs,
                    policy = event.policy,
                    violation = event.violation.javaClass.simpleName,
                    message = event.violation.message,
                    frames = frames,
                    count = count,
                    screen = event.screen,
                )
            }
        }
    }

    private fun map(stack: Array<StackTraceElement>, longer: Boolean): StackFrames.Mapped {
        val activity = topActivityClass()
        return StackFrames.map(stack, longer) { ownership.isOwned(it, activity) }
    }

    private companion object {
        /** Rough encoded size of one frame, for the outbound queue's byte budget. */
        const val FRAME_SIZE_HINT = 160
        const val MESSAGE_SIZE_HINT = 256

        fun sizeHint(stack: Array<StackTraceElement>): Int =
            MESSAGE_SIZE_HINT + minOf(stack.size, MAX_STACK_FRAMES) * FRAME_SIZE_HINT
    }
}
