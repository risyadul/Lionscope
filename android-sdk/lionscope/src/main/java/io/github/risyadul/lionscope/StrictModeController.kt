package io.github.risyadul.lionscope

import android.os.StrictMode
import android.os.SystemClock
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.Arrays
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** What [DiagnosticsController] drives; main thread only. */
internal interface StrictModeSwitch {
    fun setEnabled(enabled: Boolean)

    /** Re-installs Lionscope's policies if the app replaced them since (or tries again after a refusal). */
    fun onActivityResumed()
}

/** Why a policy was left alone. */
internal enum class StrictModeRefusal(val reason: String) {
    UNREADABLE("its mask could not be read"),
    DISRUPTIVE_PENALTY("it has a death, dialog, flash or dropbox penalty that our detections would trigger"),
    APP_LISTENER("it most likely has the app's own penaltyListener, which ours would replace"),
}

/** How to extend one policy, decided from its mask by [StrictModeMasks]. */
internal sealed class PolicyPlan {
    class Extend(val detectNetwork: Boolean) : PolicyPlan()
    class Refuse(val refusal: StrictModeRefusal) : PolicyPlan()
}

/**
 * Reads StrictMode policy masks (`toString()` is `[StrictMode.ThreadPolicy; mask=N]`). The bits are hidden
 * `StrictMode` constants, unchanged since API 28 (checked against the API 36 sources); an unreadable mask is refused.
 */
internal object StrictModeMasks {
    const val DETECT_THREAD_NETWORK = 1 shl 2
    const val DETECT_VM_FILE_URI_EXPOSURE = 1 shl 5
    const val DETECT_VM_CLEARTEXT_NETWORK = 1 shl 6
    private const val DETECT_ALL = 0x0000ffff
    const val PENALTY_LOG = 1 shl 30
    const val PENALTY_DIALOG = 1 shl 29
    const val PENALTY_DEATH = 1 shl 28
    const val PENALTY_FLASH = 1 shl 27
    const val PENALTY_DROPBOX = 1 shl 26
    const val PENALTY_DEATH_ON_NETWORK = 1 shl 25
    const val PENALTY_DEATH_ON_CLEARTEXT_NETWORK = 1 shl 24
    const val PENALTY_DEATH_ON_FILE_URI_EXPOSURE = 1 shl 23
    private const val DISRUPTIVE = PENALTY_DIALOG or PENALTY_DEATH or PENALTY_FLASH or PENALTY_DROPBOX
    /** Penalties `Builder.build()` checks before adding `penaltyLog` to a listener-less policy. */
    private const val BUILD_PENALTIES = PENALTY_LOG or PENALTY_DEATH or PENALTY_DROPBOX or PENALTY_DIALOG
    private val MASK = Regex("mask=(-?\\d+)")

    fun maskOf(policyDescription: String): Int? = MASK.find(policyDescription)?.groupValues?.get(1)?.toIntOrNull()

    /**
     * Never adds a detection whose dedicated death penalty is set: `permitNetwork()` / `permitAll()` clear
     * DETECT_NETWORK but keep PENALTY_DEATH_ON_NETWORK (set by default), so re-detecting network would make every
     * network call on the main thread throw.
     */
    fun planThread(mask: Int?): PolicyPlan {
        if (mask == null) return PolicyPlan.Refuse(StrictModeRefusal.UNREADABLE)
        val deathOnNetwork = mask and PENALTY_DEATH_ON_NETWORK != 0
        refusal(mask, covered = if (deathOnNetwork) DETECT_THREAD_NETWORK else 0)?.let { return PolicyPlan.Refuse(it) }
        return PolicyPlan.Extend(detectNetwork = !deathOnNetwork || mask and DETECT_THREAD_NETWORK != 0)
    }

    /** Leaked closables (the only VM detection added) have no dedicated death penalty. */
    fun planVm(mask: Int?): PolicyPlan {
        if (mask == null) return PolicyPlan.Refuse(StrictModeRefusal.UNREADABLE)
        var covered = 0
        if (mask and PENALTY_DEATH_ON_CLEARTEXT_NETWORK != 0) covered = covered or DETECT_VM_CLEARTEXT_NETWORK
        if (mask and PENALTY_DEATH_ON_FILE_URI_EXPOSURE != 0) covered = covered or DETECT_VM_FILE_URI_EXPOSURE
        return refusal(mask, covered)?.let { PolicyPlan.Refuse(it) } ?: PolicyPlan.Extend(detectNetwork = false)
    }

    /**
     * A listener is invisible through the public API, but `Builder.build()` adds `penaltyLog` to any policy that
     * detects something without a penalty or a listener: detections beyond those handled by a dedicated
     * `PENALTY_DEATH_ON_*` bit (the platform defaults) with no build-time penalty almost certainly mean a listener.
     * Not detectable: an app listener together with `penaltyLog` (it is then replaced while Lionscope reports).
     */
    private fun refusal(mask: Int, covered: Int): StrictModeRefusal? {
        if (mask and DISRUPTIVE != 0) return StrictModeRefusal.DISRUPTIVE_PENALTY
        if (mask and DETECT_ALL and covered.inv() != 0 && mask and BUILD_PENALTIES == 0) {
            return StrictModeRefusal.APP_LISTENER
        }
        return null
    }
}

/** One StrictMode policy kind (thread or VM), behind an interface so [PolicySlot] is testable on the JVM. */
internal interface PolicyAccess {
    fun current(): Any
    fun set(policy: Any)
    fun plan(policy: Any): PolicyPlan

    /** [policy] plus Lionscope's detections and listener, as [plan] allows. */
    fun extend(policy: Any, plan: PolicyPlan.Extend): Any

    /** Whether [current] is still the policy Lionscope [installed]. */
    fun isInstalled(current: Any, installed: Any): Boolean

    /** The policy is lifted for a moment (a StrictMode listener callback is running elsewhere): try again later. */
    fun isBusy(current: Any): Boolean = false
}

/**
 * Extends (never replaces) the app's policy and restores it afterwards. If the app installed its own policy in the
 * meantime, that one is left in place on [restore] and becomes the new base on [reapplyIfReplaced]. Operations
 * return false when the policy is busy (nothing done; retry). Confined to one thread per slot.
 */
internal class PolicySlot(private val access: PolicyAccess, private val onRefused: (StrictModeRefusal) -> Unit) {
    private var original: Any? = null
    private var installed: Any? = null

    /** Why the current base policy was left alone, or null. Readable from any thread. */
    @Volatile
    var refusal: StrictModeRefusal? = null
        private set

    val isInstalled: Boolean
        get() = installed != null

    /** Whether the current policy would be refused (read-only; any thread). */
    fun wouldRefuse(): Boolean = access.plan(access.current()) is PolicyPlan.Refuse

    fun install(): Boolean {
        if (installed != null) return true
        val current = access.current()
        if (access.isBusy(current)) return false
        when (val plan = access.plan(current)) {
            is PolicyPlan.Refuse -> {
                if (refusal != plan.refusal) onRefused(plan.refusal) // Once per reason, not on every resume.
                refusal = plan.refusal
            }
            is PolicyPlan.Extend -> {
                val extended = access.extend(current, plan)
                access.set(extended)
                original = current
                installed = extended
                refusal = null
            }
        }
        return true
    }

    /** Also retries a refused (not installed) slot: the app may have changed its policy since. */
    fun reapplyIfReplaced(): Boolean {
        val ours = installed ?: return install()
        val current = access.current()
        if (access.isBusy(current)) return false
        if (access.isInstalled(current, ours)) return true
        installed = null
        original = null
        return install()
    }

    fun restore(): Boolean {
        val ours = installed ?: return true
        val current = access.current()
        if (access.isBusy(current)) return false
        val base = original
        installed = null
        original = null
        if (base != null && access.isInstalled(current, ours)) access.set(base)
        return true
    }
}

/**
 * StrictMode reporting while enabled (API 28+): the main thread's ThreadPolicy and the process VmPolicy are extended
 * with disk/network/slow-call and leaked-closable detection plus a `penaltyListener`, and restored when disabled.
 *
 * - The thread policy is changed on the main thread (it is per thread). The VM policy is changed on the reporter
 *   thread, where its listener callbacks also run: the platform wraps each callback in `allowVmViolations()` /
 *   `setVmPolicy(old)`, which would otherwise race a restore and could re-install our policy for good.
 * - Policies the app set up in a way we cannot safely extend are left alone ([StrictModeRefusal], logged once);
 *   when both are refused the reporter is not even started.
 * - Our detections inherit the base policy's penalties: the platform default thread policy carries `penaltyLog`,
 *   so violations are also logged at D/StrictMode while reporting is on.
 * - It stays on while the app is in the background as long as the link is up (violations there are just as real).
 * - Any failure restores what it can, logs once and turns the feature off for the process.
 */
internal class StrictModeController(
    private val thread: PolicySlot,
    private val vm: PolicySlot,
    private val reporter: Reporter,
    private val main: MainScheduler,
) : StrictModeSwitch {
    /** Where violations go, and the one thread that runs VM policy changes and violation callbacks. */
    interface Reporter {
        /** Starts reporting (idempotent); false if its thread could not be started. */
        fun start(): Boolean

        /** Stops reporting: violations and flushes still in flight are dropped. */
        fun stop()

        /** Runs [task] on the reporter thread after [delayMs]; never throws. */
        fun execute(delayMs: Long, task: Runnable)
    }

    var isEnabled = false
        private set
    private var failed = false
    private var reporting = false
    private var loggedBothRefused = false

    fun refusal(policy: StrictModePolicy): StrictModeRefusal? = when (policy) {
        StrictModePolicy.THREAD -> thread.refusal
        StrictModePolicy.VM -> vm.refusal
    }

    override fun setEnabled(enabled: Boolean) {
        if (failed || enabled == isEnabled) return
        isEnabled = enabled
        attempt { if (enabled) apply() else release() }
    }

    override fun onActivityResumed() {
        if (failed || !isEnabled) return
        attempt { apply() }
    }

    private fun apply() {
        thread.reapplyIfReplaced()
        if (!reporting) {
            if (!thread.isInstalled && vm.wouldRefuse()) {
                if (!loggedBothRefused) Log.i(LOG_TAG, "Lionscope StrictMode reporting idle: the app's policies were left alone")
                loggedBothRefused = true
                return
            }
            if (!reporter.start()) {
                fail(IllegalStateException("StrictMode reporter thread did not start"))
                return
            }
            reporting = true
        }
        onReporterThread { vm.reapplyIfReplaced() }
    }

    private fun release() {
        thread.restore()
        if (!reporting) return
        reporting = false
        reporter.stop()
        onReporterThread { vm.restore() }
    }

    /** Runs a VM slot operation on the reporter thread, retrying while the policy is busy. */
    private fun onReporterThread(delayMs: Long = 0, attemptsLeft: Int = BUSY_RETRIES, operation: () -> Boolean) {
        reporter.execute(delayMs, Runnable {
            try {
                if (!operation() && attemptsLeft > 0) onReporterThread(BUSY_RETRY_MS, attemptsLeft - 1, operation)
            } catch (t: Throwable) {
                if (isFatal(t)) throw t
                main.post(Runnable { fail(t) })
            }
        })
    }

    /** Contains everything but a genuine heap OOM (same policy as the watchdog's thread start). */
    private inline fun attempt(block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            fail(t)
        }
    }

    private fun fail(cause: Throwable) {
        if (failed) return
        failed = true
        isEnabled = false
        Log.w(LOG_TAG, "Lionscope StrictMode reporting disabled: $cause")
        try {
            thread.restore()
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
        }
        if (reporting) {
            reporting = false
            reporter.stop()
            onReporterThread { vm.restore() }
        }
    }

    companion object {
        private const val BUSY_RETRIES = 20
        private const val BUSY_RETRY_MS = 50L

        @RequiresApi(28)
        fun create(main: MainScheduler, screenName: () -> String?, emit: (ViolationEvent, Int) -> Unit): StrictModeController {
            val executor = BackgroundExecutor("lionscope-strictmode")
            val reporter = ViolationReporter(executor, screenName, emit)
            val listeners = ViolationListeners(reporter, executor)
            fun logRefusal(kind: String): (StrictModeRefusal) -> Unit =
                { refusal -> Log.i(LOG_TAG, "Lionscope left the app's $kind alone: ${refusal.reason}") }
            return StrictModeController(
                thread = PolicySlot(ThreadPolicyAccess(listeners), logRefusal("ThreadPolicy")),
                vm = PolicySlot(VmPolicyAccess(listeners), logRefusal("VmPolicy")),
                reporter = reporter,
                main = main,
            )
        }
    }
}

/**
 * The first violation of a coalesced batch. [wallMs] is when Lionscope handled it on the reporter thread (StrictMode
 * delivers main-thread violations after the offending message finishes), not the instant of the violation.
 */
internal class ViolationEvent(
    val policy: StrictModePolicy,
    val violation: Throwable,
    val wallMs: Long,
    val screen: String?,
)

/** One background thread, started on demand and then kept (idle in its queue) for the process lifetime. */
internal interface SerialExecutor {
    /** Starts the thread now if needed; false if that failed. */
    fun prestart(): Boolean

    /** Runs [task] on the thread after [delayMs]; never throws (a task is dropped instead). */
    fun execute(delayMs: Long, task: Runnable)
}

/**
 * Never quit: the app may keep copies of our policies (e.g. a saved `getThreadPolicy()` restored later), whose
 * listener and executor then still point here. An idle thread costs nothing; a quit one would make those copies fail.
 */
internal class BackgroundExecutor(name: String) : SerialExecutor {
    private val pool = ScheduledThreadPoolExecutor(1) { task -> Thread(task, name).apply { isDaemon = true } }

    override fun prestart(): Boolean = try {
        pool.prestartCoreThread()
        true
    } catch (t: Throwable) {
        if (isFatal(t)) throw t
        false
    }

    override fun execute(delayMs: Long, task: Runnable) {
        try {
            pool.schedule(task, delayMs, TimeUnit.MILLISECONDS)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
        }
    }
}

/**
 * Coalesces violations on the reporter thread. Each [start] begins a new session (fresh coalescer); violations that
 * arrive while stopped, and flushes scheduled by an earlier session, are dropped.
 */
internal class ViolationReporter(
    private val executor: SerialExecutor,
    private val screenName: () -> String?,
    private val emit: (ViolationEvent, Int) -> Unit,
    private val uptimeMs: () -> Long = SystemClock::uptimeMillis,
    private val wallMs: () -> Long = System::currentTimeMillis,
) : StrictModeController.Reporter {
    private data class Key(val policy: StrictModePolicy, val violation: String, val stackHash: Int)

    @Volatile
    private var session = 0 // written on main, read on the reporter thread

    @Volatile
    private var active = false

    // Reporter thread only.
    private var coalescer = ViolationCoalescer<ViolationEvent>()
    private var coalescerSession = -1
    private var flushScheduled = false

    override fun start(): Boolean {
        if (active) return true
        if (!executor.prestart()) return false
        session++
        active = true
        return true
    }

    override fun stop() {
        active = false
    }

    override fun execute(delayMs: Long, task: Runnable) = executor.execute(delayMs, task)

    /** Called on the reporter thread (the listeners' executor). */
    fun onViolation(policy: StrictModePolicy, violation: Throwable) = guarded {
        if (!active) return@guarded // Off, or a copy of our policy outlived it.
        val current = session
        val coalescer = coalescerFor(current)
        val key = Key(policy, violation.javaClass.name, Arrays.hashCode(violation.stackTrace))
        val emissions = coalescer.offer(key, uptimeMs()) { ViolationEvent(policy, violation, wallMs(), screenName()) }
        drain(current, coalescer, emissions)
    }

    private fun coalescerFor(current: Int): ViolationCoalescer<ViolationEvent> {
        if (coalescerSession != current) {
            coalescer = ViolationCoalescer()
            coalescerSession = current
            flushScheduled = false
        }
        return coalescer
    }

    private fun drain(
        current: Int,
        coalescer: ViolationCoalescer<ViolationEvent>,
        emissions: List<ViolationCoalescer.Emission<ViolationEvent>>,
    ) {
        for (emission in emissions) emit(emission.payload, emission.count)
        if (flushScheduled) return
        val delay = coalescer.nextFlushInMs(uptimeMs()) ?: return
        flushScheduled = true
        executor.execute(delay, Runnable { guarded { flush(current) } })
    }

    private fun flush(scheduledBy: Int) {
        if (!active || scheduledBy != session || scheduledBy != coalescerSession) return // Stale session.
        flushScheduled = false
        drain(scheduledBy, coalescer, coalescer.flush(uptimeMs()))
    }
}

/** The listener and executor objects handed to StrictMode; they stay valid for the process lifetime. */
@RequiresApi(28)
private class ViolationListeners(reporter: ViolationReporter, serial: SerialExecutor) {
    val executor = Executor { task -> serial.execute(0, task) }
    val thread = StrictMode.OnThreadViolationListener { reporter.onViolation(StrictModePolicy.THREAD, it) }
    val vm = StrictMode.OnVmViolationListener { reporter.onViolation(StrictModePolicy.VM, it) }
}

@RequiresApi(28)
private class ThreadPolicyAccess(private val listeners: ViolationListeners) : PolicyAccess {
    override fun current(): Any = StrictMode.getThreadPolicy()

    override fun set(policy: Any) = StrictMode.setThreadPolicy(policy as StrictMode.ThreadPolicy)

    override fun plan(policy: Any): PolicyPlan = StrictModeMasks.planThread(StrictModeMasks.maskOf(policy.toString()))

    override fun extend(policy: Any, plan: PolicyPlan.Extend): Any {
        val builder = StrictMode.ThreadPolicy.Builder(policy as StrictMode.ThreadPolicy)
            .detectDiskReads()
            .detectDiskWrites()
            .detectCustomSlowCalls()
        if (plan.detectNetwork) builder.detectNetwork()
        return builder.penaltyListener(listeners.executor, listeners.thread).build()
    }

    /** `getThreadPolicy()` allocates a new object per call: compare the masks instead. */
    override fun isInstalled(current: Any, installed: Any): Boolean = current.toString() == installed.toString()
}

@RequiresApi(28)
private class VmPolicyAccess(private val listeners: ViolationListeners) : PolicyAccess {
    override fun current(): Any = StrictMode.getVmPolicy()

    override fun set(policy: Any) = StrictMode.setVmPolicy(policy as StrictMode.VmPolicy)

    override fun plan(policy: Any): PolicyPlan = StrictModeMasks.planVm(StrictModeMasks.maskOf(policy.toString()))

    override fun extend(policy: Any, plan: PolicyPlan.Extend): Any =
        StrictMode.VmPolicy.Builder(policy as StrictMode.VmPolicy)
            .detectLeakedClosableObjects()
            .penaltyListener(listeners.executor, listeners.vm)
            .build()

    /** `getVmPolicy()` returns the installed object itself. */
    override fun isInstalled(current: Any, installed: Any): Boolean = current === installed

    /** `allowVmViolations()` swaps in LAX while some VM listener callback runs (on another executor's thread). */
    override fun isBusy(current: Any): Boolean = current === StrictMode.VmPolicy.LAX
}
