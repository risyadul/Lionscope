package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LayoutNamesTest {

    @Test
    fun frameworkAndKnownLibraryLayoutsAreLibraryLayouts() {
        assertTrue(LayoutNames.isLibrary("android", "screen_simple"))
        for (entry in listOf(
            "abc_screen_simple", "design_bottom_navigation_item", "mtrl_alert_dialog", "material_clock_display",
            "m3_alert_dialog", "notification_template_part_time", "select_dialog_item_material",
            "support_simple_spinner_dropdown_item", "exo_player_view", "leak_canary_heap_dump_toast",
            "chucker_activity_main", "common_google_signin_btn_text", "com_facebook_login_fragment",
            "browser_actions_context_menu_page", "mr_cast_dialog",
        )) {
            assertTrue(entry, LayoutNames.isLibrary("com.example.shop", entry))
        }
        // Generic words apps use for their own layouts.
        for (entry in listOf("notification_item", "preference_screen_profile", "test_results", "material_list")) {
            assertEquals(entry, entry.startsWith("material_"), LayoutNames.isLibrary("com.example.shop", entry))
        }
        assertFalse(LayoutNames.isLibrary("com.example.shop", "fragment_home"))
        assertFalse(LayoutNames.isLibrary("com.example.shop", "item_abc_row")) // A prefix, not a substring.
        assertEquals(LayoutName("fragment_home", null, false), LayoutNames.named("com.example.shop", "fragment_home"))
    }

    @Test
    fun unnamedLayoutsGetAnAsciiClassAndLineLabel() {
        assertEquals(LayoutName(null, "LinearLayout:7", false), LayoutNames.unnamed("LinearLayout", 7))
        assertEquals("ConstraintLayout:3", LayoutNames.unnamed("androidx.constraintlayout.widget.ConstraintLayout", 3).label)
        assertEquals("Caf__View:12", LayoutNames.unnamed("com.example.shop.Café‎View", 12).label)
        assertEquals("FrameLayout", LayoutNames.unnamed("FrameLayout", 0).label) // Line unknown.
        assertEquals("?", LayoutNames.unnamed("", -1).label)
    }
}

class InflateOptOutTest {

    @Test
    fun onlyAFalseMetaDataValueOptsOut() {
        assertFalse(InflateOptOut.allowsValue(false))
        assertFalse(InflateOptOut.allowsValue("false"))
        assertFalse(InflateOptOut.allowsValue(" FALSE "))
        assertTrue(InflateOptOut.allowsValue(null)) // No meta-data: on.
        assertTrue(InflateOptOut.allowsValue(true))
        assertTrue(InflateOptOut.allowsValue("true"))
        assertTrue(InflateOptOut.allowsValue("no"))
        assertTrue(InflateOptOut.allowsValue(0)) // android:value="0" is an Integer: not an opt-out.
        assertEquals("io.github.risyadul.lionscope.inflateTracking", InflateOptOut.META_DATA)
    }
}
