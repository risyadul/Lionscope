package io.github.risyadul.lionscope

import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** `savedState` (v10) on a link without the link proof: written, like the profiling messages below v7. */
class SavedStateUnprovenTest {
    @Test
    fun aSavedStateReportIsWrittenOnAV10LinkWithoutTheProof() {
        val link = FakeLink()
        val main = FakeScheduler()
        val profiler = SavedStateProfiler(
            link = link,
            main = main,
            measure = { _, _, _ -> SavedStateMeasurement(20 * 1024, 0.5, null, null) },
            screenNameOf = { "orders" },
            apiLevel = 31,
            clock = { 1_792_516_385_000L },
        )
        link.welcome(true, DEVICE_PROTOCOL_V10, proven = false)
        main.runPosted()
        profiler.onActivityPostSaveInstanceState(PlainTestActivity(), Bundle())
        // The welcome queued the live-Activity list (liveActivities) first; the report is the second item.
        assertEquals(2, link.v10Items.size)
        val item = link.v10Items.last()
        var held = 0
        val line = checkNotNull(DeviceLink.encode(item, negotiatedVersion = 10, networkAuthenticated = false) { held++ })
        assertEquals("savedState", (TestJson.parse(line) as Map<*, *>)["type"])
        assertEquals(0, held)
        // The version gate is unchanged: not on a v9 link.
        assertNull(DeviceLink.encode(item, negotiatedVersion = 9, networkAuthenticated = true))
    }
}
