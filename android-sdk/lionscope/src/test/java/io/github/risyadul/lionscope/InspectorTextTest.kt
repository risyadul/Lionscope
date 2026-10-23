package io.github.risyadul.lionscope

import android.text.InputType
import android.text.method.HideReturnsTransformationMethod
import android.text.method.PasswordTransformationMethod
import android.text.method.SingleLineTransformationMethod
import android.view.View
import io.github.risyadul.lionscope.InspectorText.Shown
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InspectorTextTest {

    private fun shown(transformation: Any?, inputType: Int = InputType.TYPE_NULL) = InspectorText.shown(transformation, inputType)

    @Test
    fun passwordFieldsAreRecognisedByInputTypeTransformationOrAutofillHint() {
        val text = InputType.TYPE_CLASS_TEXT
        for (variation in listOf(
            InputType.TYPE_TEXT_VARIATION_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
        )) {
            assertEquals(Shown.SECRET, shown(null, text or variation))
            assertEquals(Shown.SECRET, shown(null, text or variation or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS))
        }
        assertEquals(Shown.SECRET, shown(null, InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
        assertEquals(Shown.SECRET, shown(PasswordTransformationMethod()))
        assertEquals(Shown.SECRET, shown(object : PasswordTransformationMethod() {}))

        assertEquals(Shown.RAW, shown(null)) // A plain TextView.
        assertEquals(Shown.RAW, shown(null, text or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        assertEquals(Shown.RAW, shown(null, InputType.TYPE_CLASS_NUMBER))
        // Same bits as the text password variation, another class: not a password.
        assertEquals(Shown.RAW, shown(null, InputType.TYPE_CLASS_DATETIME or InputType.TYPE_TEXT_VARIATION_PASSWORD))

        assertTrue(InspectorText.hasPasswordHint(arrayOf("emailAddress", View.AUTOFILL_HINT_PASSWORD)))
        assertTrue(InspectorText.hasPasswordHint(arrayOf("newPassword")))
        assertTrue(InspectorText.hasPasswordHint(arrayOf("CURRENT-PASSWORD")))
        assertFalse(InspectorText.hasPasswordHint(arrayOf("username", "emailAddress")))
        assertFalse(InspectorText.hasPasswordHint(null))
    }

    /** As the platform's (hidden) `android.text.method.AllCapsTransformationMethod` and AppCompat's are named. */
    private class AllCapsTransformationMethod

    private class MaskTransformation

    @Test
    fun textIsSentAsSetUnderLayoutOnlyTransformationsAndAsShownUnderOthers() {
        assertEquals(Shown.RAW, shown(SingleLineTransformationMethod()))
        assertEquals(Shown.RAW, shown(HideReturnsTransformationMethod()))
        assertEquals(Shown.RAW, shown(AllCapsTransformationMethod())) // Raw text, not caps-transformed.
        assertEquals(Shown.TRANSFORMED, shown(MaskTransformation())) // E.g. a card number shown masked.
        assertEquals(Shown.SECRET, shown(MaskTransformation(), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD))
    }

    @Test
    fun rawTextIsCutBeforeItIsCopied() {
        assertNull(InspectorText.raw(null))
        assertEquals("Checkout", InspectorText.raw(StringBuilder("Checkout")))
        assertEquals(InspectorText.MAX_RAW_TEXT, InspectorText.raw("a".repeat(10_000))!!.length)
    }

    @Test
    fun belowApi29OnlyTheKnownWindowsAreWalked() {
        var globalAsked = false
        val global = { globalAsked = true; listOf("system", "activity", "dialog") }
        val known = { listOf("activity", "hidden", "dialog") }
        val shown = { window: String -> window != "hidden" }

        assertEquals(listOf("activity", "dialog"), WindowRoots.select(28, global, known, shown))
        assertFalse(globalAsked)
        assertEquals(listOf("system", "activity", "dialog"), WindowRoots.select(29, global, known, shown))
        assertTrue(globalAsked)
    }
}

class DrawingOrderTest {

    @Test
    fun childrenAreInDrawingOrderCustomOrderThenStableByZ() {
        val flat = { _: Int -> 0f }
        assertEquals(listOf(0, 1, 2, 3), DrawingOrder.order(4, null, flat))
        assertEquals(listOf(3, 2, 1, 0), DrawingOrder.order(4, { 3 - it }, flat))
        // Elevation lifts a child over its later siblings; equal Z keeps the (custom) order.
        val z = floatArrayOf(0f, 8f, 0f, 8f)
        assertEquals(listOf(0, 2, 1, 3), DrawingOrder.order(4, null) { z[it] })
        assertEquals(listOf(2, 0, 3, 1), DrawingOrder.order(4, { 3 - it }) { z[it] })
        assertEquals(listOf(1, 0), DrawingOrder.order(2, null) { if (it == 0) 2f else -1f })
        // A custom order that is not a permutation is ignored.
        assertEquals(listOf(0, 1, 2), DrawingOrder.order(3, { 0 }, flat))
        assertEquals(listOf(0, 1, 2), DrawingOrder.order(3, { it + 1 }, flat))
        assertEquals(emptyList<Int>(), DrawingOrder.order(0, null, flat))
    }
}
