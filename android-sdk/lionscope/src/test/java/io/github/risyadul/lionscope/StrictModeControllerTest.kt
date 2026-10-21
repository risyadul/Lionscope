package io.github.risyadul.lionscope

import io.github.risyadul.lionscope.StrictModeMasks.DETECT_THREAD_NETWORK
import io.github.risyadul.lionscope.StrictModeMasks.DETECT_VM_CLEARTEXT_NETWORK
import io.github.risyadul.lionscope.StrictModeMasks.DETECT_VM_FILE_URI_EXPOSURE
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DEATH
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DEATH_ON_CLEARTEXT_NETWORK
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DEATH_ON_FILE_URI_EXPOSURE
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DEATH_ON_NETWORK
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DIALOG
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_DROPBOX
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_FLASH
import io.github.risyadul.lionscope.StrictModeMasks.PENALTY_LOG
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Policies are plain strings here; "x+ours" is "x" extended by Lionscope. */
private class FakePolicies(var current: Any) : PolicyAccess {
    val sets = ArrayList<Any>()
    var refuse: StrictModeRefusal? = null
    var busy = false
    var failOnSet: Exception? = null

    override fun current(): Any = current

    override fun set(policy: Any) {
        failOnSet?.let { throw it }
        sets += policy
        current = policy
    }

    override fun plan(policy: Any): PolicyPlan =
        refuse?.let { PolicyPlan.Refuse(it) } ?: PolicyPlan.Extend(detectNetwork = true)

    override fun extend(policy: Any, plan: PolicyPlan.Extend): Any = "$policy+ours"

    override fun isInstalled(current: Any, installed: Any): Boolean = current == installed

    override fun isBusy(current: Any): Boolean = busy
}

/** Reporter thread stand-in: tasks run only when the test says so. */
private class FakeReporter : StrictModeController.Reporter {
    var running = false
    var starts = 0
    var startResult = true
    val tasks = ArrayList<Pair<Long, Runnable>>()

    override fun start(): Boolean {
        if (!startResult) return false
        if (!running) starts++
        running = true
        return true
    }

    override fun stop() {
        running = false
    }

    override fun execute(delayMs: Long, task: Runnable) {
        tasks += delayMs to task
    }

    /** Runs queued tasks (and the retries they queue) until none is left; returns the delays seen. */
    fun runAll(): List<Long> {
        val delays = ArrayList<Long>()
        while (tasks.isNotEmpty()) {
            val (delay, task) = tasks.removeAt(0)
            delays += delay
            task.run()
        }
        return delays
    }
}

class StrictModeControllerTest {

    private val thread = FakePolicies("appThread")
    private val vm = FakePolicies("appVm")
    private val refusals = ArrayList<Pair<String, StrictModeRefusal>>()
    private val reporter = FakeReporter()
    private val main = FakeScheduler()
    private val controller = StrictModeController(
        PolicySlot(thread) { refusals += "thread" to it },
        PolicySlot(vm) { refusals += "vm" to it },
        reporter,
        main,
    )

    @Test
    fun enableExtendsTheAppPoliciesAndDisableRestoresThem() {
        controller.setEnabled(true)
        assertTrue(controller.isEnabled)
        assertTrue(reporter.running)
        assertEquals("appThread+ours", thread.current) // On the calling (main) thread.
        assertEquals("appVm", vm.current) // Not yet: VM changes run on the reporter thread.
        reporter.runAll()
        assertEquals("appVm+ours", vm.current)

        controller.setEnabled(true) // Idempotent.
        reporter.runAll()
        assertEquals(1, thread.sets.size)
        assertEquals(1, vm.sets.size)

        controller.setEnabled(false)
        assertFalse(reporter.running)
        assertEquals("appThread", thread.current)
        reporter.runAll()
        assertEquals("appVm", vm.current)
    }

    @Test
    fun aPolicyTheAppReplacedIsExtendedAgainOnResume() {
        controller.setEnabled(true)
        reporter.runAll()
        controller.onActivityResumed()
        reporter.runAll()
        assertEquals(1, thread.sets.size) // Still ours: nothing to do.

        thread.current = "appThread2" // The app set its own policies.
        vm.current = "appVm2"
        controller.onActivityResumed()
        reporter.runAll()
        assertEquals("appThread2+ours", thread.current)
        assertEquals("appVm2+ours", vm.current)

        controller.setEnabled(false)
        reporter.runAll()
        assertEquals("appThread2", thread.current) // Its newer policies are the ones restored.
        assertEquals("appVm2", vm.current)
    }

    @Test
    fun disableLeavesAPolicyTheAppReplacedInPlace() {
        controller.setEnabled(true)
        reporter.runAll()
        vm.current = "appVm2"
        controller.setEnabled(false)
        reporter.runAll()
        assertEquals("appVm2", vm.current)
        assertEquals("appThread", thread.current)
    }

    @Test
    fun aRefusedPolicyIsLeftAloneLoggedOnceAndRetriedOnResume() {
        thread.refuse = StrictModeRefusal.APP_LISTENER
        controller.setEnabled(true)
        reporter.runAll()
        assertSame("appThread", thread.current)
        assertEquals("appVm+ours", vm.current)
        assertEquals(StrictModeRefusal.APP_LISTENER, controller.refusal(StrictModePolicy.THREAD))
        assertNull(controller.refusal(StrictModePolicy.VM))

        controller.onActivityResumed()
        controller.onActivityResumed()
        assertEquals(listOf("thread" to StrictModeRefusal.APP_LISTENER), refusals)

        thread.refuse = null // The app changed its policy: now it can be extended.
        controller.onActivityResumed()
        assertEquals("appThread+ours", thread.current)
        assertNull(controller.refusal(StrictModePolicy.THREAD))
        controller.setEnabled(false)
        reporter.runAll()
        assertTrue(thread.sets.last() == "appThread" && vm.current == "appVm")
    }

    @Test
    fun whenBothPoliciesAreRefusedTheReporterIsNotStarted() {
        thread.refuse = StrictModeRefusal.DISRUPTIVE_PENALTY
        vm.refuse = StrictModeRefusal.DISRUPTIVE_PENALTY
        controller.setEnabled(true)
        controller.onActivityResumed()
        assertEquals(0, reporter.starts)
        assertTrue(reporter.tasks.isEmpty())
        assertTrue(controller.isEnabled)

        vm.refuse = null
        controller.onActivityResumed()
        assertEquals(1, reporter.starts)
        reporter.runAll()
        assertEquals("appVm+ours", vm.current)
    }

    @Test
    fun aReporterThatCannotStartDisablesForGood() {
        reporter.startResult = false
        controller.setEnabled(true)
        assertFalse(controller.isEnabled)
        assertEquals("appThread", thread.current) // The thread policy installed just before is restored.
        reporter.startResult = true
        controller.setEnabled(true)
        assertFalse(controller.isEnabled)
        assertEquals(0, reporter.starts)
    }

    @Test
    fun aFailureOnTheReporterThreadIsHandedToMainAndDisablesForGood() {
        vm.failOnSet = IllegalStateException("boom")
        controller.setEnabled(true)
        reporter.runAll()
        assertTrue(controller.isEnabled) // Not yet: the failure is posted to main.
        main.runPosted()
        assertFalse(controller.isEnabled)
        assertFalse(reporter.running)
        assertEquals("appThread", thread.current)

        vm.failOnSet = null
        controller.setEnabled(true)
        assertFalse(controller.isEnabled)
    }

    @Test
    fun aFailureOnMainIsContainedIncludingVirtualMachineErrors() {
        thread.failOnSet = null
        val failing = object : PolicyAccess by thread {
            override fun set(policy: Any) = throw StackOverflowError("deep")
        }
        val controller = StrictModeController(PolicySlot(failing) {}, PolicySlot(vm) {}, reporter, main)
        controller.setEnabled(true)
        assertFalse(controller.isEnabled)
    }

    @Test
    fun aBusyVmPolicyIsRetriedShortlyThenGivenUp() {
        vm.busy = true
        controller.setEnabled(true)
        val first = reporter.tasks.removeAt(0)
        first.second.run() // Busy: a retry is queued.
        assertEquals(1, reporter.tasks.size)
        assertTrue(reporter.tasks.single().first > 0)
        vm.busy = false
        reporter.runAll()
        assertEquals("appVm+ours", vm.current)

        vm.busy = true // Stays busy: restore gives up after a bounded number of retries.
        controller.setEnabled(false)
        val delays = reporter.runAll()
        assertTrue(delays.size in 2..50)
        assertEquals("appVm+ours", vm.current)
    }

    @Test
    fun threadMasksNeverReArmNetworkDeath() {
        // Platform default: detectNetwork + penaltyDeathOnNetwork (+ the penaltyLog build() adds).
        val default = DETECT_THREAD_NETWORK or PENALTY_DEATH_ON_NETWORK or PENALTY_LOG
        assertEquals(true, (StrictModeMasks.planThread(default) as PolicyPlan.Extend).detectNetwork)
        // permitNetwork()/permitAll() clear DETECT_NETWORK but keep the death bit: never detect network again.
        val permitted = PENALTY_DEATH_ON_NETWORK or PENALTY_LOG
        assertEquals(false, (StrictModeMasks.planThread(permitted) as PolicyPlan.Extend).detectNetwork)
        assertEquals(false, (StrictModeMasks.planThread(PENALTY_DEATH_ON_NETWORK) as PolicyPlan.Extend).detectNetwork)
        assertEquals(true, (StrictModeMasks.planThread(0) as PolicyPlan.Extend).detectNetwork)
        // Detection covered by its dedicated death bit alone is not a listener.
        assertTrue(StrictModeMasks.planThread(DETECT_THREAD_NETWORK or PENALTY_DEATH_ON_NETWORK) is PolicyPlan.Extend)
    }

    @Test
    fun disruptivePenaltiesAndLikelyListenersAreRefused() {
        fun threadRefusal(mask: Int?) = (StrictModeMasks.planThread(mask) as? PolicyPlan.Refuse)?.refusal
        val diskRead = 1 shl 1
        for (penalty in listOf(PENALTY_DEATH, PENALTY_DIALOG, PENALTY_FLASH, PENALTY_DROPBOX)) {
            assertEquals(StrictModeRefusal.DISRUPTIVE_PENALTY, threadRefusal(diskRead or penalty))
        }
        assertEquals(StrictModeRefusal.APP_LISTENER, threadRefusal(diskRead))
        assertEquals(StrictModeRefusal.APP_LISTENER, threadRefusal(diskRead or PENALTY_DEATH_ON_NETWORK))
        assertNull(threadRefusal(diskRead or PENALTY_LOG)) // A listener next to penaltyLog is not detectable.
        assertEquals(StrictModeRefusal.UNREADABLE, threadRefusal(null))
    }

    @Test
    fun vmMasks() {
        fun vmRefusal(mask: Int) = (StrictModeMasks.planVm(mask) as? PolicyPlan.Refuse)?.refusal
        val closable = 1 shl 1
        // Platform default: file:// exposure with its own death penalty (+ penaltyLog).
        assertNull(vmRefusal(DETECT_VM_FILE_URI_EXPOSURE or PENALTY_DEATH_ON_FILE_URI_EXPOSURE or PENALTY_LOG))
        assertNull(vmRefusal(DETECT_VM_FILE_URI_EXPOSURE or PENALTY_DEATH_ON_FILE_URI_EXPOSURE))
        assertNull(vmRefusal(DETECT_VM_CLEARTEXT_NETWORK or PENALTY_DEATH_ON_CLEARTEXT_NETWORK))
        assertEquals(StrictModeRefusal.APP_LISTENER, vmRefusal(closable))
        assertEquals(StrictModeRefusal.DISRUPTIVE_PENALTY, vmRefusal(closable or PENALTY_DEATH))
        assertEquals(StrictModeRefusal.DISRUPTIVE_PENALTY, vmRefusal(PENALTY_DROPBOX))
    }

    @Test
    fun masksAreReadFromThePolicyDescription() {
        assertEquals(4, StrictModeMasks.maskOf("[StrictMode.ThreadPolicy; mask=4]"))
        assertEquals(Int.MIN_VALUE, StrictModeMasks.maskOf("[StrictMode.VmPolicy; mask=-2147483648]"))
        assertNull(StrictModeMasks.maskOf("something else"))
    }
}
