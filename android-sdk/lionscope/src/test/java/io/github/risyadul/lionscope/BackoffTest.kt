package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {

    @Test
    fun growsOneTwoFiveSecondsThenCaps() {
        val backoff = Backoff()
        assertEquals(listOf(1_000L, 2_000L, 5_000L, 5_000L, 5_000L), List(5) { backoff.next() })
    }

    @Test
    fun resetStartsOverAtOneSecond() {
        val backoff = Backoff()
        repeat(4) { backoff.next() }
        backoff.reset()
        assertEquals(listOf(1_000L, 2_000L), List(2) { backoff.next() })
    }
}
