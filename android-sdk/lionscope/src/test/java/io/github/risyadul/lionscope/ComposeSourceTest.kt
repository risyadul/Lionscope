package io.github.risyadul.lionscope

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposeSourceTest {

    @Test
    fun aFunctionGroupHasItsNameTheLinesOfItsCallsAndItsFile() {
        val info = SourceInfo.parse("C(ProductCard)N(product,onClick)61@2765L246,62@2830L9:ComposeShopScreens.kt#vgriz8")!!
        assertTrue(info.isCall)
        assertEquals("ProductCard", info.name)
        assertArrayEquals(intArrayOf(62, 63), info.lines) // Recorded 0-based.
        assertEquals("ComposeShopScreens.kt", info.file)
        assertEquals("vgriz8", info.packageHash)
        assertEquals(62, info.lineOfCall(0))
        assertEquals(63, info.lineOfCall(1))
        assertNull(info.lineOfCall(2))
    }

    @Test
    fun inlineCallsLambdasAndMarkersParse() {
        val column = SourceInfo.parse("CC(Column)P(2,3,1)87@4250L61,88@4316L42:Column.kt#2w3rfo")!!
        assertEquals("Column", column.name)
        assertArrayEquals(intArrayOf(88, 89), column.lines)
        val lambda = SourceInfo.parse("C101@3940L244,101@3918L266:LazyLayoutItemContentFactory.kt#wow0x6")!!
        assertTrue(lambda.isCall)
        assertNull(lambda.name)
        assertEquals("LazyLayoutItemContentFactory.kt", lambda.file)
        val remember = SourceInfo.parse("CC(remember):Effects.kt#9igjgp")!!
        assertEquals(0, remember.lines.size)
        assertEquals("Effects.kt", remember.file)
        val group = SourceInfo.parse("12@300L4")!!
        assertFalse(group.isCall)
        assertNull(group.file)
        assertArrayEquals(intArrayOf(13), group.lines)
    }

    @Test
    fun repeatedCallsCycleThroughTheRepeatableLocations() {
        val loop = SourceInfo.parse("C10@100L5,*12@200L5,13@300L5:Loop.kt#abc")!!
        assertEquals(1, loop.repeatFrom)
        assertEquals(listOf(11, 13, 14, 13, 14), (0 until 5).map { loop.lineOfCall(it) })
    }

    @Test
    fun unknownLinesNestedSectionsAndMalformedInfo() {
        assertNull(SourceInfo.parse("C(Box)@100L5:Box.kt")!!.lineOfCall(0)) // No line recorded.
        assertNull(SourceInfo.parse("C(Box)@100L5:Box.kt")!!.packageHash)
        val sections = SourceInfo.parse("C(Card)X(a(b)c)N(x)5@1L1:Card.kt#h")!!
        assertEquals("Card", sections.name)
        assertArrayEquals(intArrayOf(6), sections.lines)
        assertNull(SourceInfo.parse(""))
        assertNull(SourceInfo.parse("C(Unclosed"))
        assertNull(SourceInfo.parse("C(Box)P(1"))
        assertArrayEquals(intArrayOf(3), SourceInfo.parse("C2@1L1,x@y:F.kt")!!.lines) // A bad location ends the list.
    }

    @Test
    fun packageHashesAreTheCompilers() {
        assertEquals("9igjgp", SourceInfo.packageHash("androidx.compose.runtime"))
        assertEquals("2w3rfo", SourceInfo.packageHash("androidx.compose.foundation.layout"))
        assertEquals("wow0x6", SourceInfo.packageHash("androidx.compose.foundation.lazy.layout"))
    }

    @Test
    fun onlyNamedCallsFromAppCodeAreShown() {
        val app = SourceInfo.packageHash("com.example.shop")
        val material3 = SourceInfo.packageHash("androidx.compose.material3")
        assertTrue(ComposableFilter.isShown("Button", app))
        assertTrue(ComposableFilter.isShown("Button", null)) // Unknown package: the app's.
        assertFalse(ComposableFilter.isShown("Surface", material3))
        assertFalse(ComposableFilter.isShown(null, app))
        assertFalse(ComposableFilter.isShown("rememberSaveable", app))
        assertFalse(ComposableFilter.isShown("<get-typography>", app))
        assertFalse(ComposableFilter.isShown("CompositionLocalProvider", app))
    }

    @Test
    fun aFunctionCalledFromLibraryCodeIsLibraryCode() {
        val material3 = SourceInfo.packageHash("androidx.compose.material3")
        val internal = SourceInfo.packageHash("androidx.compose.material3.newinternals")
        assertTrue(ComposableFilter.isShown("Box", internal))
        ComposableFilter.learn(SourceInfo.parse("C(Decoration)5@1L1:Decoration.kt#$internal")!!, material3)
        assertFalse(ComposableFilter.isShown("Box", internal))
        // App code calling into some package never makes it library code.
        val other = SourceInfo.packageHash("com.example.widgets")
        ComposableFilter.learn(SourceInfo.parse("C(Chip)5@1L1:Chip.kt#$other")!!, SourceInfo.packageHash("com.example.shop"))
        assertTrue(ComposableFilter.isShown("Box", other))
    }
}
