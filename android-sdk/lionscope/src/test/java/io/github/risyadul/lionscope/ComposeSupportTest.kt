package io.github.risyadul.lionscope

import android.content.Context
import android.view.View
import androidx.compose.ui.platform.isDebugInspectorInfoEnabled
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposeSupportTest {

    @After
    fun reset() {
        ComposeSupport.reset()
        isDebugInspectorInfoEnabled = false
    }

    @Test
    fun anAppWithoutComposeIsLeftAlone() {
        ComposeSupport.install(stubContext(), classExists = { false }, metaData = { error("not read") })
        assertNull(ComposeSupport.reading)
        assertFalse(isDebugInspectorInfoEnabled)
    }

    @Test
    fun composeInspectionIsTurnedOnAtInstall() {
        ComposeSupport.install(stubContext(), classExists = { true }, metaData = { null })
        assertTrue(ComposeSupport.reading is ComposeViewReader)
        assertTrue(isDebugInspectorInfoEnabled)
    }

    @Test
    fun anOptedOutAppReadsAsDisabled() {
        ComposeSupport.install(stubContext(), classExists = { true }, metaData = { "false" })
        assertFalse(isDebugInspectorInfoEnabled)
        assertEquals(CompositionStatus.DISABLED, ComposeSupport.reading!!.read(View(null as Context?)).status)
    }

    /** A Context stub (android.jar returns defaults); only passed through. */
    private fun stubContext(): Context = object : android.content.ContextWrapper(null) {}
}
