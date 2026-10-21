package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReconnectPolicyTest {

    private val minute = 60_000L

    @Test
    fun usesOneTwoFiveSecondBackoffInTheForeground() {
        val policy = ReconnectPolicy(startMs = 0)
        policy.onForeground(true, 0)
        assertEquals(listOf(1_000L, 2_000L, 5_000L, 5_000L), List(4) { policy.nextDelayMs(1_000) })
    }

    @Test
    fun welcomeResetsTheBackoff() {
        val policy = ReconnectPolicy(startMs = 0)
        policy.onForeground(true, 0)
        repeat(3) { policy.nextDelayMs(0) }
        policy.onWelcome(10)
        assertEquals(1_000L, policy.nextDelayMs(20))
    }

    @Test
    fun parksOnlyAfterThirtySecondsWithoutAStartedActivity() {
        val policy = ReconnectPolicy(startMs = 0)
        assertFalse(policy.shouldPark(29_999)) // Process just started, no activity yet.
        assertTrue(policy.shouldPark(30_000))

        policy.onForeground(true, 40_000)
        assertFalse(policy.shouldPark(100_000))

        policy.onForeground(false, 100_000)
        assertFalse(policy.shouldPark(129_999))
        assertTrue(policy.shouldPark(130_000))
    }

    @Test
    fun slowsToFifteenSecondsAfterTenForegroundMinutesWithoutWelcome() {
        val policy = ReconnectPolicy(startMs = 0)
        policy.onForeground(true, 0)
        repeat(5) { policy.nextDelayMs(0) }
        assertEquals(5_000L, policy.nextDelayMs(10 * minute - 1))
        assertEquals(15_000L, policy.nextDelayMs(10 * minute))

        policy.onWelcome(11 * minute)
        assertEquals(1_000L, policy.nextDelayMs(12 * minute))
    }

    @Test
    fun foregroundTimeAccumulatesAcrossBackgroundStretches() {
        val policy = ReconnectPolicy(startMs = 0)
        policy.onForeground(true, 0)
        policy.onForeground(false, 6 * minute)
        repeat(5) { policy.nextDelayMs(0) }
        assertEquals(5_000L, policy.nextDelayMs(20 * minute)) // Background time does not count.
        policy.onForeground(true, 20 * minute)
        assertEquals(5_000L, policy.nextDelayMs(23 * minute))
        assertEquals(15_000L, policy.nextDelayMs(24 * minute))
    }
}
