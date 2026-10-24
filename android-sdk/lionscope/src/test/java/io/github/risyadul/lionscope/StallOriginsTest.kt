package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StallOriginsTest {

    @Test
    fun readsTheCoroutineOfADebugModeThreadName() {
        assertEquals("spike-refresh#3", CoroutineNames.parse("main @spike-refresh#3"))
        assertEquals("coroutine#12", CoroutineNames.parse("main @coroutine#12"))
        // A name with " @" of its own: the last separator is the coroutine's (debug mode replaces only that part).
        assertEquals("load#7", CoroutineNames.parse("main @ shop @load#7"))
    }

    @Test
    fun anyOtherThreadNameHasNoCoroutine() {
        assertNull(CoroutineNames.parse(null))
        assertNull(CoroutineNames.parse("main"))
        assertNull(CoroutineNames.parse("main @"))
        assertNull(CoroutineNames.parse("main @refresh"))
        assertNull(CoroutineNames.parse("main @#12"))
        assertNull(CoroutineNames.parse("main @refresh#"))
    }

    @Test
    fun theSitesMapComparesKeysByIdentity() {
        val map = BoundedWeakIdentityMap<Any, String>(8)
        val a = EqualKey()
        val b = EqualKey()
        assertTrue(map.put(a, "a"))
        assertTrue(map.put(b, "b"))
        assertEquals("a", map.get(a))
        assertEquals("b", map.get(b))
        assertEquals(2, map.size)
        map.clear()
        assertNull(map.get(a))
        assertEquals(0, map.size)
    }

    @Test
    fun aFullSitesMapRefusesNewKeysButUpdatesKnownOnes() {
        val map = BoundedWeakIdentityMap<Any, String>(2)
        val keys = List(3) { Any() }
        assertTrue(map.put(keys[0], "0"))
        assertTrue(map.put(keys[1], "1"))
        assertFalse(map.put(keys[2], "2"))
        assertTrue(map.put(keys[0], "0b"))
        assertEquals("0b", map.get(keys[0]))
        assertNull(map.get(keys[2]))
    }

    @Test
    fun theCaptureLimitAllowsSoManyPerSecond() {
        var now = 0L
        val limit = PerSecondLimit(3) { now }
        assertEquals(listOf(true, true, true, false), List(4) { limit.tryAcquire() })
        now += 999_999_999
        assertFalse(limit.tryAcquire())
        now += 1
        assertTrue(limit.tryAcquire())
    }

    /** All instances are equal: a map by equality would mix them up. */
    private class EqualKey {
        override fun equals(other: Any?): Boolean = other is EqualKey
        override fun hashCode(): Int = 1
    }
}
