package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The SDK's own bounds of edit values (the same as `normalizeViewValue` in protocol/src/wire.ts). */
class ViewValuesTest {

    private fun parse(property: ViewProperty, raw: Any?) = ViewValues.parse(property, raw)

    @Test
    fun visibilityEnabledAndAlpha() {
        assertEquals(ViewVisibility.GONE, parse(ViewProperty.VISIBILITY, "gone"))
        assertEquals(ViewVisibility.INVISIBLE, parse(ViewProperty.VISIBILITY, "invisible"))
        assertNull(parse(ViewProperty.VISIBILITY, "hidden"))
        assertNull(parse(ViewProperty.VISIBILITY, 8.0))
        assertEquals(false, parse(ViewProperty.ENABLED, false))
        assertNull(parse(ViewProperty.ENABLED, "false"))
        assertEquals(0.35f, parse(ViewProperty.ALPHA, 0.35))
        assertEquals(0f, parse(ViewProperty.ALPHA, 0.0))
        assertEquals(1f, parse(ViewProperty.ALPHA, 1.0))
        for (bad in listOf(-0.01, 1.01, Double.NaN, "0.5", true)) assertNull("$bad", parse(ViewProperty.ALPHA, bad))
    }

    @Test
    fun paddingAndMarginsAreWholePixelsWithinBounds() {
        assertEquals(0, parse(ViewProperty.PADDING_TOP, 0.0))
        assertEquals(2000, parse(ViewProperty.PADDING_LEFT, 2000.0))
        assertNull(parse(ViewProperty.PADDING_LEFT, 2001.0))
        assertNull(parse(ViewProperty.PADDING_LEFT, -1.0))
        assertNull(parse(ViewProperty.PADDING_LEFT, 1.5))
        assertEquals(-2000, parse(ViewProperty.MARGIN_BOTTOM, -2000.0))
        assertNull(parse(ViewProperty.MARGIN_BOTTOM, -2001.0))
        assertNull(parse(ViewProperty.MARGIN_RIGHT, "8"))
    }

    @Test
    fun layoutSizesAreMatchWrapOrPixels() {
        assertEquals(ViewValues.MATCH_PARENT, parse(ViewProperty.LAYOUT_WIDTH, "match_parent"))
        assertEquals(ViewValues.WRAP_CONTENT, parse(ViewProperty.LAYOUT_HEIGHT, "wrap_content"))
        assertEquals(0, parse(ViewProperty.LAYOUT_WIDTH, "0px"))
        assertEquals(10_000, parse(ViewProperty.LAYOUT_WIDTH, "10000px"))
        for (bad in listOf("10001px", "-5px", "5", "5dp", "1.5px", " 5px", 5.0)) {
            assertNull("$bad", parse(ViewProperty.LAYOUT_WIDTH, bad))
        }
    }

    @Test
    fun translationElevationAndTextSize() {
        assertEquals(-10_000f, parse(ViewProperty.TRANSLATION_X, -10_000.0))
        assertEquals(12.5f, parse(ViewProperty.TRANSLATION_Y, 12.5))
        assertNull(parse(ViewProperty.TRANSLATION_X, 10_000.5))
        assertEquals(1000f, parse(ViewProperty.ELEVATION, 1000.0))
        assertNull(parse(ViewProperty.ELEVATION, -1.0))
        assertEquals(1f, parse(ViewProperty.TEXT_SIZE, 1.0))
        assertEquals(200f, parse(ViewProperty.TEXT_SIZE, 200.0))
        assertNull(parse(ViewProperty.TEXT_SIZE, 0.5))
        assertNull(parse(ViewProperty.TEXT_SIZE, 201.0))
    }

    @Test
    fun colorsAreRgbOrArgbHex() {
        assertEquals(0xFF3366CC.toInt(), parse(ViewProperty.BACKGROUND_COLOR, "#3366cc"))
        assertEquals(0x803366CC.toInt(), parse(ViewProperty.TEXT_COLOR, "#803366CC"))
        assertEquals(0, parse(ViewProperty.TEXT_COLOR, "#00000000"))
        for (bad in listOf("3366CC", "#36C", "#3366CCX", "#+366CC", "#3366CC00FF", "red", 0xFF0000.toDouble())) {
            assertNull("$bad", parse(ViewProperty.BACKGROUND_COLOR, bad))
        }
        assertEquals("#FF3366CC", ViewValues.hex(0xFF3366CC.toInt()))
        assertEquals("#00000000", ViewValues.hex(0))
        assertEquals("#0000000F", ViewValues.hex(15))
    }

    @Test
    fun textIsBoundedWithoutControlCharactersButLineBreaksAndTabs() {
        assertEquals("Pay now\nor\tlater 🛒", parse(ViewProperty.TEXT, "Pay now\nor\tlater 🛒"))
        assertEquals("", parse(ViewProperty.TEXT, ""))
        assertEquals("x".repeat(500), parse(ViewProperty.TEXT, "x".repeat(500)))
        assertNull(parse(ViewProperty.TEXT, "x".repeat(501)))
        assertNull(parse(ViewProperty.TEXT, 5.0))
        assertTrue(ViewValues.isEditableText("Zero\u200Dwidth joiners\u200C stay"))
        for (format in listOf("\u202A", "\u202E", "\u2066", "\u2069", "\u200B", "\u00AD", "\uFEFF", "\uDB40\uDC67")) {
            assertFalse(format, ViewValues.isEditableText("a${format}b"))
        }
        for (bad in listOf("a\u0000b", "a\rb", "a\u001Bb", "a\u007Fb", "a\u0085b", "lone \uD83D", "lone \uDED2 low")) {
            assertFalse(bad, ViewValues.isEditableText(bad))
        }
    }
}
