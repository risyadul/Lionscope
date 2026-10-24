package io.github.risyadul.lionscope

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The side arithmetic AndroidViewEdits uses, in both layout directions. */
class EditSidesTest {
    private val padding = PaddingState(left = 1, top = 2, right = 3, bottom = 4, relative = true)

    @Test
    fun anEditChangesOnlyItsSide() {
        assertEquals(padding.copy(left = 9), EditSides.withSide(padding, ViewProperty.PADDING_LEFT, 9))
        assertEquals(padding.copy(bottom = 0), EditSides.withSide(padding, ViewProperty.PADDING_BOTTOM, 0))
    }

    @Test
    fun relativePaddingIsStartTopEndBottomPerDirection() {
        assertArrayEquals(intArrayOf(1, 2, 3, 4), EditSides.relative(padding, rtl = false))
        // Right to left: the start is on the right.
        assertArrayEquals(intArrayOf(3, 2, 1, 4), EditSides.relative(padding, rtl = true))
    }

    @Test
    fun aLeftOrRightMarginIsTheStartOrEndPerDirection() {
        assertEquals(RelativeSide.START, EditSides.relativeMargin(ViewProperty.MARGIN_LEFT, rtl = false))
        assertEquals(RelativeSide.END, EditSides.relativeMargin(ViewProperty.MARGIN_RIGHT, rtl = false))
        assertEquals(RelativeSide.END, EditSides.relativeMargin(ViewProperty.MARGIN_LEFT, rtl = true))
        assertEquals(RelativeSide.START, EditSides.relativeMargin(ViewProperty.MARGIN_RIGHT, rtl = true))
        assertNull(EditSides.relativeMargin(ViewProperty.MARGIN_TOP, rtl = true))
    }

    @Test
    fun onlyFrameworkSpansAreKeptForARevert() {
        assertTrue(EditSides.keepsSpans(listOf("android.text.style.StyleSpan", "android.text.style.URLSpan")))
        assertTrue(EditSides.keepsSpans(emptyList()))
        assertFalse(EditSides.keepsSpans(listOf("android.text.style.StyleSpan", "com.example.shop.ui.TermsLinkSpan")))
    }

    @Test
    fun backgroundsAndTextCompareAsValues() {
        val drawable = Any()
        assertEquals(BackgroundState(drawable, 1), BackgroundState(drawable, 1))
        assertFalse(BackgroundState(drawable, 1) == BackgroundState(drawable, 2))
        assertFalse(BackgroundState(drawable, null) == BackgroundState(Any(), null))
        assertFalse(TextState("Pay", 1) == TextState("Pay", 0))
    }
}
