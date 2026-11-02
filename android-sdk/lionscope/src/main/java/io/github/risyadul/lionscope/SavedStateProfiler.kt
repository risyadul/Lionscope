package io.github.risyadul.lionscope

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle

/** One measurement of an Activity's saved state (see [SavedStateProfiler]). */
internal class SavedStateMeasurement(
    val totalBytes: Int,
    val measureMs: Double,
    val breakdownMs: Double?,
    val breakdown: SavedStateBreakdown.Result?,
)

/**
 * Measures each Activity's saved state once it is COMPLETE: what the system then sends to system_server in
 * `activityStopped`, where an oversized state fails with TransactionTooLargeException.
 *
 * `onActivitySaveInstanceState` is no such point: it runs inside `Activity.onSaveInstanceState`, i.e. during the app's
 * `super.onSaveInstanceState()` call, before ComponentActivity saves its SavedStateRegistry (all Fragment state) and
 * before whatever the app puts after `super`. So, API 29+: `onActivityPostSaveInstanceState`, which runs after the
 * whole save; API 23-28: a main-thread post from `onActivitySaveInstanceState`, which runs after the save returned and
 * before the stop is reported (the system posts that report later in the same queue).
 *
 * Each report names its Activity object ([ActivityInstances]: `instanceId`), and the profiler lists the live ones
 * (`liveActivities`) whenever one is created or destroyed (at most every [LIVE_ACTIVITIES_MIN_INTERVAL_MS], the last
 * change always sent), after each welcome and when tracking is turned on, so the server can tell a live Activity whose
 * saves keep growing from one that is gone. The numbering runs all the time (a few map operations per lifecycle
 * callback): a session may start long after the Activities it has to list.
 *
 * Runs on a v10 session link whose `config` keeps `savedStateTracking` on (the default); idle otherwise. The total
 * (one Parcel write of the whole bundle) is taken every time; the per-key breakdown only from [breakdownMinBytes]. The
 * bundle itself is never changed: the breakdown reads copies ([AndroidStateAccess]). Main thread only.
 */
internal class SavedStateProfiler(
    private val link: LinkPort,
    private val main: MainScheduler,
    private val measure: (bundle: Any, breakdownMinBytes: Int, classLoader: ClassLoader?) -> SavedStateMeasurement =
        AndroidStateAccess::measure,
    private val screenNameOf: (Activity) -> String? = { ScreenNames.nameOf(it) },
    private val apiLevel: Int = Build.VERSION.SDK_INT,
    private val clock: () -> Long = System::currentTimeMillis,
    private val breakdownMinBytes: Int = BREAKDOWN_MIN_BYTES,
    private val instances: ActivityInstances = ActivityInstances(main),
) : Application.ActivityLifecycleCallbacks {
    private var linkV10 = false
    private var options = SdkOptions.DEFAULT

    /** The live list changed since it was last sent. */
    private var listChanged = false
    /** A [flushList] is posted (now or delayed). */
    private var flushPosted = false
    private var listSentAt: Long? = null

    /** Measuring now (main thread). */
    val isEnabled: Boolean
        get() = linkV10 && options.savedStateTracking

    init {
        link.addSessionListener { active ->
            val version = if (active) link.negotiatedVersion ?: 0 else 0
            main.post(Runnable {
                guarded {
                    linkV10 = version >= DEVICE_PROTOCOL_V10
                    options = SdkOptions.DEFAULT
                    // Every welcome (a reconnect too) gets the whole list: what changed while no link was up.
                    if (isEnabled) sendList()
                }
            })
        }
        link.addConfigListener { options ->
            main.post(Runnable {
                guarded {
                    val wasEnabled = isEnabled
                    this.options = options
                    if (!wasEnabled && isEnabled) sendList()
                }
            })
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = guarded {
        instances.onCreated(activity, restored = savedInstanceState != null)
        listChanged()
    }

    override fun onActivityDestroyed(activity: Activity) = guarded {
        if (instances.onDestroyed(activity)) listChanged()
    }

    override fun onActivityStarted(activity: Activity) = guarded { seen(activity) }
    override fun onActivityResumed(activity: Activity) = guarded { seen(activity) }
    override fun onActivityPaused(activity: Activity) = guarded { seen(activity) }
    override fun onActivityStopped(activity: Activity) = guarded { seen(activity) }

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = guarded {
        seen(activity)
        if (apiLevel >= POST_SAVE_API || !isEnabled) return@guarded
        val instanceId = instances.idOf(activity)
        main.post(Runnable { guarded { record(activity, outState, SavedStateHook.POSTED, instanceId) } })
    }

    override fun onActivityPostSaveInstanceState(activity: Activity, outState: Bundle) = guarded {
        seen(activity)
        if (isEnabled) record(activity, outState, SavedStateHook.POST_SAVE)
    }

    /** [bundle] is the Activity's complete saved state; [instanceId] its number when it saved. */
    fun record(activity: Activity, bundle: Any, hook: SavedStateHook, instanceId: Int = instances.idOf(activity)) {
        if (!isEnabled) return
        val ts = clock()
        val measurement = measure(bundle, breakdownMinBytes, activity.javaClass.classLoader)
        val activityClass = activity.javaClass.name
        val screen = screenNameOf(activity)
        val entries = measurement.breakdown?.entries.orEmpty()
        link.sendV10(SIZE_HINT + entries.size * ENTRY_SIZE_HINT) {
            DeviceMessages.savedState(
                ts = ts,
                activity = activityClass,
                instanceId = instanceId,
                screen = screen,
                hook = hook,
                totalBytes = measurement.totalBytes,
                measureMs = measurement.measureMs,
                breakdownMs = measurement.breakdownMs,
                entries = entries,
                truncated = measurement.breakdown?.truncated ?: false,
            )
        }
    }

    /** An Activity created before the SDK was installed gets its number on its first callback. */
    private fun seen(activity: Activity) {
        if (!instances.isNew(activity)) return
        instances.idOf(activity)
        listChanged()
    }

    /** The live list changed: sent once the current main-thread message is done, and no sooner than the interval. */
    private fun listChanged() {
        listChanged = true
        if (!isEnabled || flushPosted) return
        flushPosted = true
        main.post(Runnable { guarded { flushList() } })
    }

    private fun flushList() {
        flushPosted = false
        if (!listChanged || !isEnabled) return
        val sentAt = listSentAt
        // At most the interval: a clock set back must not hold the list for longer.
        val wait = if (sentAt == null) 0L else (sentAt + LIVE_ACTIVITIES_MIN_INTERVAL_MS - clock()).coerceAtMost(LIVE_ACTIVITIES_MIN_INTERVAL_MS)
        if (wait > 0) {
            flushPosted = true
            main.postDelayed(Runnable { guarded { flushList() } }, wait)
            return
        }
        sendList()
    }

    /** The whole list now: a copy taken on the main thread, encoded later on the link thread. */
    private fun sendList() {
        val ts = clock()
        val list = instances.snapshot()
        listChanged = false
        listSentAt = ts
        link.sendV10(LIST_SIZE_HINT + list.entries.size * LIST_ENTRY_SIZE_HINT) {
            DeviceMessages.liveActivities(ts, list.entries, list.truncated)
        }
    }

    companion object {
        /** `ActivityLifecycleCallbacks.onActivityPostSaveInstanceState` exists from API 29 (Android 10). */
        const val POST_SAVE_API = 29

        /**
         * States at least this big get the per-key breakdown (smaller ones only their total). Its main-thread cost
         * (`breakdownMs`, once per save) was measured only on API 31 emulators with a ~440 KB state: a median of 1.1
         * and 2.4 ms in the two recorded runs, with a tail that varied widely between them (README, "Saved state").
         * Not a budget.
         */
        const val BREAKDOWN_MIN_BYTES = 64 * 1024
        private const val SIZE_HINT = 512
        private const val ENTRY_SIZE_HINT = 400
        private const val LIST_SIZE_HINT = 96
        private const val LIST_ENTRY_SIZE_HINT = 96
    }
}
