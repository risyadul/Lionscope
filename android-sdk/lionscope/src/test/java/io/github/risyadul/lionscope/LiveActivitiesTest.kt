package io.github.risyadul.lionscope

import android.app.Activity
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OtherTestActivity : Activity()

/** `liveActivities` and `savedState.instanceId` (device protocol 10): the SDK's numbering of Activity objects. */
class LiveActivitiesTest {
    private val link = FakeLink()
    private val main = FakeScheduler()
    private var now = 1_792_516_385_000L
    /** Activities destroyed for a configuration change (`isChangingConfigurations`). */
    private val changing = HashSet<Activity>()

    private val profiler = SavedStateProfiler(
        link = link,
        main = main,
        measure = { _, _, _ -> SavedStateMeasurement(20 * 1024, 0.5, null, null) },
        screenNameOf = { null },
        apiLevel = 31,
        clock = { now },
        instances = ActivityInstances(main, changingConfigurations = { it in changing }),
    )

    private fun session(version: Int = DEVICE_PROTOCOL_V10, proven: Boolean = true) {
        link.welcome(true, version, proven = proven)
        main.runPosted()
    }

    /** Runs this main-thread message's posts, then (past the interval) a list held back by it. */
    private fun settle() {
        main.runPosted()
        now += 1000
        main.runDelayed()
    }

    private fun lines(type: String) = link.v10Lines.map { TestJson.parse(it) as Map<*, *> }.filter { it["type"] == type }

    /** The newest list sent, as (id, prevId) pairs. */
    private fun lastList(): List<Pair<Int, Int?>> = listed(lines("liveActivities").last())

    private fun listed(line: Map<*, *>) = (line["activities"] as List<*>).map {
        val entry = it as Map<*, *>
        (entry["id"] as Double).toInt() to (entry["prevId"] as Double?)?.toInt()
    }

    private fun create(activity: Activity, restored: Boolean = false) =
        profiler.onActivityCreated(activity, if (restored) Bundle() else null)

    /** Rotation: Android destroys [old] and creates its successor in the same main-thread message. */
    private fun recreate(old: Activity, new: Activity) {
        changing += old
        profiler.onActivityDestroyed(old)
        create(new, restored = true)
    }

    @Test
    fun aConfigurationChangeChainsTheNewInstanceToTheOldOne() { // E-01
        session()
        val first = PlainTestActivity()
        create(first)
        settle()
        assertEquals(listOf(1 to null), lastList())
        recreate(first, PlainTestActivity())
        settle()
        assertEquals(listOf(2 to 1), lastList())

        // Control: a successor created in a later message is a new instance, not the old one's.
        val second = PlainTestActivity()
        create(second)
        settle()
        changing += second
        profiler.onActivityDestroyed(second)
        main.runPosted()
        create(PlainTestActivity(), restored = true)
        settle()
        assertEquals(listOf(2 to 1, 4 to null), lastList())
    }

    @Test
    fun aFinishedActivityLeavesTheList() { // E-02
        session()
        val kept = PlainTestActivity()
        val finished = OtherTestActivity()
        create(kept)
        create(finished)
        settle()
        assertEquals(listOf(1 to null, 2 to null), lastList())
        profiler.onActivityDestroyed(finished) // not changing configurations: no successor
        create(OtherTestActivity(), restored = true)
        settle()
        assertEquals(listOf(1 to null, 3 to null), lastList())
    }

    @Test
    fun nothingIsSentWithoutALinkAndTheWholeListAfterTheNextWelcome() { // E-04
        session()
        val stays = PlainTestActivity()
        val goes = OtherTestActivity()
        create(stays)
        create(goes)
        settle()
        assertEquals(listOf(1 to null, 2 to null), lastList())
        val sent = link.v10Lines.size
        link.welcome(false)
        main.runPosted()
        profiler.onActivityDestroyed(goes)
        settle()
        assertEquals(sent, link.v10Lines.size)
        session()
        assertEquals(sent + 1, link.v10Lines.size)
        assertEquals(listOf(1 to null), lastList())
    }

    @Test
    fun twoInstancesOfAClassKeepTheirOwnNumbersAndChainsOldestFirst() { // E-06
        session()
        val a = PlainTestActivity()
        val b = PlainTestActivity()
        create(a)
        create(b)
        settle()
        profiler.onActivityPostSaveInstanceState(a, Bundle())
        profiler.onActivityPostSaveInstanceState(b, Bundle())
        assertEquals(listOf(1.0, 2.0), lines("savedState").map { it["instanceId"] })
        // Both rotate in one message: destroyed a, b then created a', b' (Android relaunches them in turn).
        changing += a
        changing += b
        profiler.onActivityDestroyed(a)
        profiler.onActivityDestroyed(b)
        create(PlainTestActivity(), restored = true)
        create(PlainTestActivity(), restored = true)
        settle()
        assertEquals(listOf(3 to 1, 4 to 2), lastList())
    }

    @Test
    fun aLiveActivityThatNeverSavedIsListed() { // E-07
        session()
        create(PlainTestActivity())
        settle()
        assertEquals(listOf(1 to null), lastList())
        assertTrue(lines("savedState").isEmpty())
    }

    @Test
    fun aLiveActivitiesListIsWrittenOnAV10LinkWithoutTheProof() { // E-08
        session(proven = false)
        create(PlainTestActivity())
        settle()
        val item = link.v10Items.last()
        var held = 0
        val line = DeviceLink.encode(item, negotiatedVersion = 10, networkAuthenticated = false) { held++ }
        assertNotNull("liveActivities held back on a link without the link proof", line)
        assertEquals("liveActivities", (TestJson.parse(line!!) as Map<*, *>)["type"])
        assertEquals(0, held)
        // The version gate is unchanged: not on a v9 link.
        assertEquals(null, DeviceLink.encode(item, negotiatedVersion = 9, networkAuthenticated = true))
    }

    @Test
    fun aBurstSendsAtMostTwoListsAndTheLastOneIsTheFinalState() { // E-14
        session()
        val sentAtWelcome = lines("liveActivities").size
        now += 1000
        val open = ArrayList<Activity>()
        repeat(10) { step ->
            if (step % 3 == 2) {
                profiler.onActivityDestroyed(open.removeAt(0))
            } else {
                PlainTestActivity().also { open += it; create(it) }
            }
            main.runPosted()
            now += 10
        }
        // The trailing send, when its delay is up.
        assertTrue(main.delayed.single().second <= LIVE_ACTIVITIES_MIN_INTERVAL_MS)
        now += LIVE_ACTIVITIES_MIN_INTERVAL_MS
        main.runDelayed()
        val burst = lines("liveActivities").drop(sentAtWelcome)
        assertTrue("${burst.size} lists", burst.size in 1..2)
        assertEquals(listOf(4, 5, 6, 7), listed(burst.last()).map { it.first })
        assertTrue(main.delayed.isEmpty())
    }

    @Test
    fun theListIsACopy() { // E-14
        session()
        val first = PlainTestActivity()
        create(first)
        settle()
        val item = link.v10Items.last()
        profiler.onActivityDestroyed(first)
        create(PlainTestActivity())
        val line = checkNotNull(DeviceLink.encode(item, negotiatedVersion = 10, networkAuthenticated = true))
        assertEquals(listOf(1 to null), listed(TestJson.parse(line) as Map<*, *>))
    }

    @Test
    fun anActivityFirstSeenSavingGetsANumberThatTheNextListCarries() { // E-16
        session()
        val late = PlainTestActivity() // created before the SDK was installed
        profiler.onActivityPostSaveInstanceState(late, Bundle())
        assertEquals(1.0, lines("savedState").single()["instanceId"])
        settle()
        assertEquals(listOf(1 to null), lastList())
    }

    @Test
    fun theNumberingRunsWithoutASessionAndTrackingOnSendsTheList() { // D14, S5 (c)
        val before = PlainTestActivity()
        create(before)
        main.runPosted()
        assertTrue(link.v10Lines.isEmpty())
        session()
        assertEquals(listOf(1 to null), lastList())
        link.config(SdkOptions(150, strictMode = false, savedStateTracking = false))
        main.runPosted()
        create(PlainTestActivity())
        main.runPosted()
        assertEquals(1, lines("liveActivities").size)
        link.config(SdkOptions(150, strictMode = false))
        main.runPosted()
        assertEquals(listOf(1 to null, 2 to null), lastList())
        // Below v10: nothing.
        session(DEVICE_PROTOCOL_V9)
        create(PlainTestActivity())
        main.runPosted()
        assertEquals(2, lines("liveActivities").size)
    }

    @Test
    fun theListKeepsTheNewestInstancesWithinTheCap() {
        val instances = ActivityInstances(main, maxListed = 3)
        val activities = List(5) { PlainTestActivity() }
        activities.forEach { instances.onCreated(it, restored = false) }
        val list = instances.snapshot()
        assertEquals(listOf(3, 4, 5), list.entries.map { it.id })
        assertTrue(list.truncated)
    }
}

class LiveActivitiesMessageTest {
    @Test
    fun theWorstCaseListFitsALineAndIsSortedWithPrevIdAlwaysWritten() { // S6
        val name = "a." + "视".repeat(198)
        val entries = (MAX_LIVE_ACTIVITIES + 6 downTo 1).map { LiveActivity(Int.MAX_VALUE - it, name, if (it % 2 == 0) it else null) }
        val line = DeviceMessages.liveActivities(1L, entries, truncated = false)
        assertTrue(StackFrames.utf8Length(line) <= MAX_DEVICE_LINE_BYTES)
        assertTrue(line.startsWith("{\"type\":\"liveActivities\""))
        val parsed = TestJson.parse(line) as Map<*, *>
        val sent = (parsed["activities"] as List<*>).map { it as Map<*, *> }
        assertEquals(MAX_LIVE_ACTIVITIES, sent.size)
        assertEquals(sent.map { it["id"] as Double }.sorted(), sent.map { it["id"] as Double })
        assertEquals(true, parsed["truncated"])
        assertTrue(sent.all { it.containsKey("prevId") && (it["activity"] as String).length <= 200 })
        assertEquals(listOf("id", "activity", "prevId"), sent.first().keys.toList())
    }
}
