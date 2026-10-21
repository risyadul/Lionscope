package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class WireTextTest {

    @Test
    fun controlAndFormatCharactersBecomeSpacesThenTrimmed() {
        assertEquals("Leaked a b", WireText.required("\nLeaked\ta\u200Eb\u0000\r\n", 256))
        // Supplementary format characters (tags) count too; other non-ASCII text is kept.
        assertEquals("\u00E9 x \uD83D\uDE00", WireText.required("\u00E9\uDB40\uDC01x \uD83D\uDE00", 256))
    }

    @Test
    fun bidiOverridesJoinersAndSpaceRunsCollapseToOneSpace() {
        assertEquals("evil txt.exe", WireText.clean("evil\u202Etxt.exe", 256))
        assertEquals("a b", WireText.clean("a\u200D\u200D b", 256))
        assertEquals("a b c", WireText.clean("a    b \n\t c", 256))
    }

    @Test
    fun requiredUsesTheGivenFallback() {
        assertEquals("Violation", WireText.required("\n", 128, "Violation"))
        assertEquals(WireText.UNKNOWN, WireText.required(null, 128))
    }

    @Test
    fun cleanTextIsReturnedAsIs() {
        val clean = "com.example.shop.ui.HomeViewModel"
        assertSame(clean, WireText.required(clean, 256))
    }

    @Test
    fun emptyAfterCleaningIsAPlaceholderOrNull() {
        assertEquals(WireText.UNKNOWN, WireText.required("", 256))
        assertEquals(WireText.UNKNOWN, WireText.required(" \u200B\n\t", 256))
        assertNull(WireText.clean("", 128))
        assertNull(WireText.clean("\u2028\u200F ", 128))
        assertNull(WireText.clean(null, 128))
    }

    @Test
    fun capsAfterCleaningWithoutSplittingSurrogatesOrEndingOnSpace() {
        assertEquals(256, WireText.required("a".repeat(300), 256).length)
        assertEquals("ab", WireText.required("ab \u0007cd", 3))
        assertEquals("ab", capLength("ab\uD83D\uDE00", 3))
        assertEquals("ab\uD83D\uDE00", capLength("ab\uD83D\uDE00", 4))
    }
}
