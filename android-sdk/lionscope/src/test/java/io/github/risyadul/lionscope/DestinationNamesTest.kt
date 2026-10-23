package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DestinationNamesTest {

    @Test
    fun aStringRouteIsNamedByItsPathPatternNeverByArguments() {
        assertEquals(ScreenRef("product/{id}", "product/{id}?tab={tab}", ScreenKind.DESTINATION), DestinationNames.screen("product/{id}?tab={tab}", null, dialog = false))
        assertEquals("catalog", DestinationNames.nameOf("catalog"))
        assertEquals("settings/notifications", DestinationNames.nameOf("settings/notifications"))
        assertEquals("settings.general", DestinationNames.nameOf("settings.general")) // Dotted, but no class.
    }

    @Test
    fun aTypeSafeRouteIsNamedByItsClass() {
        assertEquals("ProductDetail", DestinationNames.nameOf("com.example.shop.ProductDetail/{id}?tab={tab}"))
        assertEquals("Home", DestinationNames.nameOf("com.example.shop.Home"))
        assertEquals("Detail", DestinationNames.nameOf("com.example.shop.Screen.Detail/{id}"))
    }

    @Test
    fun dialogsLabelsAndNothing() {
        assertEquals(ScreenKind.DIALOG, DestinationNames.screen("promo", null, dialog = true)?.kind)
        assertEquals(ScreenRef("Settings", "Settings", ScreenKind.DESTINATION), DestinationNames.screen(null, "Settings", dialog = false))
        assertNull(DestinationNames.screen(null, null, dialog = false))
        assertNull(DestinationNames.screen(" ", "", dialog = false))
        assertEquals("?x={x}", DestinationNames.nameOf("?x={x}"))
    }
}
