package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WindowRegistryTest {

    private val attached = ArrayList<String>()
    private val detached = ArrayList<String>()
    private var nextHandle = 0
    private val registry = WindowRegistry<String, Int>(
        attach = { window, name -> attached += "$window/$name"; ++nextHandle },
        detach = { window, _ -> detached += window },
    )

    @Test
    fun windowsAreOnlyMeasuredWhileActive() {
        registry.show("activity", "w1", "Main")
        registry.show("dialog", "w2", "Promo")
        assertEquals(emptyList<String>(), attached)

        registry.setActive(true)
        assertEquals(listOf("w1/Main", "w2/Promo"), attached.sorted())
        assertEquals(2, registry.attachedCount)

        registry.setActive(false)
        assertEquals(listOf("w1", "w2"), detached.sorted())
        assertEquals(0, registry.attachedCount)
    }

    @Test
    fun showWhileActiveAttachesImmediatelyAndHideDetaches() {
        registry.setActive(true)
        registry.show("dialog", "w2", "Promo")
        assertEquals(listOf("w2/Promo"), attached)
        assertEquals("Promo", registry.hide("dialog"))
        assertEquals(listOf("w2"), detached)
        assertNull(registry.hide("dialog"))
    }

    @Test
    fun hideWhileInactiveDoesNotDetach() {
        registry.show("activity", "w1", "Main")
        assertEquals("Main", registry.hide("activity"))
        assertEquals(emptyList<String>(), detached)
    }

    @Test
    fun sameWindowIsNotAttachedTwiceAndANewWindowReplacesTheOld() {
        registry.setActive(true)
        registry.show("activity", "w1", "Main")
        registry.show("activity", "w1", "Main")
        assertEquals(1, attached.size)
        registry.show("activity", "w3", "Main")
        assertEquals(listOf("w1"), detached)
        assertEquals(listOf("w1/Main", "w3/Main"), attached)
    }

    @Test
    fun failedAttachLeavesTheWindowUnmeasured() {
        val failing = WindowRegistry<String, Int>(attach = { _, _ -> null }, detach = { window, _ -> detached += window })
        failing.setActive(true)
        failing.show("activity", "w1", "Main")
        assertEquals(0, failing.attachedCount)
        failing.hide("activity")
        assertEquals(emptyList<String>(), detached)
    }
}
