package io.github.risyadul.lionscope

import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** [ComposeSemanticsReader] over real semantics configurations (Compose UI on the unit-test classpath). */
class ComposeSemanticsTest {

    private fun config(block: SemanticsConfiguration.() -> Unit) = SemanticsConfiguration().apply(block)

    private fun read(vararg configs: SemanticsConfiguration): ComposeSemantics {
        val layouts = configs.map { Any() }
        return ComposeSemanticsReader.of(layouts, layouts.zip(configs).toMap())
    }

    @Test
    fun textDescriptionTagAndFlagsComeFromTheComposablesOwnNodes() {
        val semantics = read(
            config {
                set(SemanticsProperties.TestTag, "checkout")
                set(SemanticsActions.OnClick, AccessibilityAction(null) { true })
                set(SemanticsProperties.Selected, true)
            },
            config {
                set(SemanticsProperties.Text, listOf(AnnotatedString("Pay"), AnnotatedString("now")))
                set(SemanticsProperties.ContentDescription, listOf("Pay now"))
                set(SemanticsProperties.ToggleableState, ToggleableState.Off)
            },
        )
        assertEquals("Pay now", semantics.text)
        assertEquals("Pay now", semantics.contentDescription)
        assertEquals("checkout", semantics.testTag)
        assertTrue(semantics.clickable)
        assertTrue(semantics.selected)
        assertTrue(semantics.enabled)
        assertFalse(semantics.focused)
        assertEquals(false, semantics.checked)
        assertFalse(semantics.secret)
    }

    @Test
    fun aTextFieldSendsItsShownTextAndADisabledOneIsNotEnabled() {
        val semantics = read(
            config {
                set(SemanticsProperties.EditableText, AnnotatedString("shopper@example.com"))
                set(SemanticsProperties.Text, listOf(AnnotatedString("Email")))
                set(SemanticsProperties.Disabled, Unit)
                set(SemanticsProperties.ToggleableState, ToggleableState.Indeterminate)
            },
        )
        assertEquals("shopper@example.com", semantics.text)
        assertFalse(semantics.enabled)
        assertNull(semantics.checked)
    }

    @Test
    fun aPasswordFieldSendsNeitherTextNorDescription() {
        val semantics = read(
            config {
                set(SemanticsProperties.EditableText, AnnotatedString("hunter2"))
                set(SemanticsProperties.ContentDescription, listOf("hunter2"))
                set(SemanticsProperties.Password, Unit)
            },
        )
        assertTrue(semantics.secret)
        assertNull(semantics.text)
        assertNull(semantics.contentDescription)
    }

    /** Compose 1.8+'s ContentType (not in the API compiled against): matched by key name, hints by reflection. */
    private class FakeContentType(@Suppress("unused") val androidAutofillHints: Set<String>)

    @Test
    fun aPasswordContentTypeIsSecretToo() {
        val contentType = SemanticsPropertyKey<FakeContentType>("ContentType")
        val password = read(
            config {
                set(SemanticsProperties.EditableText, AnnotatedString("hunter2"))
                set(contentType, FakeContentType(setOf("username", "newPassword")))
            },
        )
        assertTrue(password.secret)
        assertNull(password.text)
        val email = read(config {
            set(SemanticsProperties.EditableText, AnnotatedString("shopper@example.com"))
            set(contentType, FakeContentType(setOf("emailAddress")))
        })
        assertFalse(email.secret)
        assertEquals("shopper@example.com", email.text)
    }

    @Test
    fun longTextIsCappedBeforeTheWire() {
        val semantics = read(config { set(SemanticsProperties.Text, listOf(AnnotatedString("x".repeat(10_000)))) })
        assertEquals(InspectorText.MAX_RAW_TEXT, semantics.text!!.length)
    }

    @Test
    fun aComposableWithoutSemanticsHasNone() {
        assertSame(ComposeSemantics.NONE, ComposeSemanticsReader.of(listOf(Any()), emptyMap()))
    }
}
