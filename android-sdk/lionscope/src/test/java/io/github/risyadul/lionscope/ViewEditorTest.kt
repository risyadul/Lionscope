package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A view for [ViewEditor]: property values in a map; a background is an object, as a Drawable is. */
internal class FakeEditView(
    var attached: Boolean = true,
    val textView: Boolean = true,
    var password: Boolean = false,
    val margins: Boolean = true,
) {
    val values = HashMap<ViewProperty, Any?>()

    init {
        values[ViewProperty.PADDING_LEFT] = 8
        values[ViewProperty.ALPHA] = 1f
        values[ViewProperty.TEXT] = "Pay"
        values[ViewProperty.BACKGROUND_COLOR] = Background(0)
    }
}

/** A ColorDrawable stand-in: compared by identity, its color changeable in place (as setBackgroundColor does). */
internal class Background(var color: Int)

internal class FakeEditAccess : ViewEditAccess<FakeEditView> {
    val writes = ArrayList<Pair<ViewProperty, Any>>()
    val restores = ArrayList<ViewProperty>()
    val reads = HashMap<ViewProperty, Int>()
    var refreshes = 0
    var failing: ViewProperty? = null
    /** Reads of this property throw once it has been written. */
    var unreadableAfterWrite: ViewProperty? = null

    override fun isAttached(view: FakeEditView) = view.attached

    override fun supports(view: FakeEditView, property: ViewProperty): Boolean = when (property) {
        in ViewProperty.MARGIN -> view.margins
        ViewProperty.TEXT, ViewProperty.TEXT_SIZE, ViewProperty.TEXT_COLOR -> view.textView
        else -> true
    }

    override fun isPassword(view: FakeEditView) = view.password
    override fun save(view: FakeEditView, property: ViewProperty): Any? = view.values[property]
    override fun read(view: FakeEditView, property: ViewProperty): Any? {
        reads[property] = (reads[property] ?: 0) + 1
        if (property == unreadableAfterWrite && writes.any { it.first == property }) throw IllegalStateException("odd")
        val value = view.values[property]
        // As AndroidViewEdits reads a background: the object and, for a color one, its color.
        return if (property == ViewProperty.BACKGROUND_COLOR) BackgroundState(value, (value as Background?)?.color) else value
    }

    override fun write(view: FakeEditView, property: ViewProperty, value: Any) {
        writes += property to value
        view.values[property] = if (property == ViewProperty.BACKGROUND_COLOR) Background(value as Int) else value
        if (property == failing) throw IllegalStateException("setter failed")
    }

    override fun restore(view: FakeEditView, property: ViewProperty, saved: Any?) {
        restores += property
        view.values[property] = saved
    }

    override fun refresh(view: FakeEditView) {
        refreshes++
    }
}

class ViewEditorTest {
    private val access = FakeEditAccess()
    private val editor = ViewEditor(access, maxEdits = 4, firstKey = 1)

    /** Captures [views] (in order) and commits it, as a successful Inspector capture does; their keys. */
    private fun capture(vararg views: FakeEditView): List<Int> {
        val capture = editor.beginCapture()
        return views.map(capture::keyOf).also { capture.commit() }
    }

    private fun edited(view: FakeEditView): List<ViewProperty> = editor.beginCapture().edited(view)

    @Test
    fun keysStayWithTheirViewAndAreNeverGivenToAnother() {
        val (a, b) = FakeEditView() to FakeEditView()
        val first = capture(a, b)
        assertNotEquals(first[0], first[1])
        assertEquals(first, capture(a, b))
        val recreated = FakeEditView()
        val (keyA, keyNew) = capture(a, recreated)
        assertEquals(first[0], keyA)
        assertTrue(keyNew !in first)
    }

    @Test
    fun anEditOnlyReachesAViewOfTheLatestCommittedCaptureThatIsAttached() {
        val (shown, gone) = FakeEditView() to FakeEditView()
        val (shownKey, goneKey) = capture(shown, gone)
        capture(shown) // The latest capture no longer has `gone`.
        assertEquals(EditError.STALE, editor.set(goneKey, ViewProperty.ALPHA, 0.5).error)
        assertEquals(EditError.STALE, editor.set(999, ViewProperty.ALPHA, 0.5).error)
        // A capture that was not committed (it failed) changes nothing.
        editor.beginCapture().keyOf(gone)
        assertEquals(EditError.STALE, editor.set(goneKey, ViewProperty.ALPHA, 0.5).error)
        shown.attached = false
        assertEquals(EditError.STALE, editor.set(shownKey, ViewProperty.ALPHA, 0.5).error)
        assertTrue(access.writes.isEmpty())
    }

    @Test
    fun anEditKeepsTheFirstOriginalAndTheRevertRestoresIt() {
        val view = FakeEditView()
        val (key) = capture(view)
        val first = editor.set(key, ViewProperty.PADDING_LEFT, 24.0)
        assertNull(first.error)
        assertEquals(1, first.liveEdits)
        assertEquals(24, view.values[ViewProperty.PADDING_LEFT])
        assertEquals(1, access.refreshes)
        editor.set(key, ViewProperty.PADDING_LEFT, 40.0)
        assertEquals(listOf(ViewProperty.PADDING_LEFT), edited(view))
        val reverted = editor.revert(key, null)
        assertNull(reverted.error)
        assertEquals(0, reverted.liveEdits)
        assertEquals(8, view.values[ViewProperty.PADDING_LEFT])
    }

    @Test
    fun settingBackTheOriginalValueEndsTheEdit() {
        val view = FakeEditView()
        val (key) = capture(view)
        editor.set(key, ViewProperty.ALPHA, 0.5)
        assertEquals(1, editor.liveEdits())
        assertEquals(0, editor.set(key, ViewProperty.ALPHA, 1.0).liveEdits)
        assertEquals(emptyList<ViewProperty>(), edited(view))
    }

    @Test
    fun anEditTheAppOverwroteIsForgottenNotReverted() {
        val view = FakeEditView()
        val (key) = capture(view)
        editor.set(key, ViewProperty.TEXT, "Edited")
        editor.set(key, ViewProperty.ALPHA, 0.5)
        view.values[ViewProperty.TEXT] = "Rebound row" // The app set it itself (a RecyclerView rebind).
        assertEquals(listOf(ViewProperty.ALPHA), edited(view))
        assertEquals(1, editor.liveEdits())
        editor.revert(null, null)
        assertEquals("Rebound row", view.values[ViewProperty.TEXT])
        assertEquals(1f, view.values[ViewProperty.ALPHA])
        // A later edit of it starts from the app's value.
        editor.set(key, ViewProperty.TEXT, "Again")
        editor.revert(key, listOf(ViewProperty.TEXT))
        assertEquals("Rebound row", view.values[ViewProperty.TEXT])
    }

    @Test
    fun aBackgroundIsRestoredAsTheSameObject() {
        val view = FakeEditView()
        val original = view.values[ViewProperty.BACKGROUND_COLOR]
        val (key) = capture(view)
        editor.set(key, ViewProperty.BACKGROUND_COLOR, "#FF3366CC")
        assertEquals(0xFF3366CC.toInt(), (view.values[ViewProperty.BACKGROUND_COLOR] as Background).color)
        assertEquals(listOf(ViewProperty.BACKGROUND_COLOR), edited(view))
        editor.revert(key, listOf(ViewProperty.BACKGROUND_COLOR))
        assertSame(original, view.values[ViewProperty.BACKGROUND_COLOR])
    }

    @Test
    fun revertsOneGroupOneViewOrEverything() {
        val (a, b) = FakeEditView() to FakeEditView()
        val (keyA, keyB) = capture(a, b)
        editor.set(keyA, ViewProperty.PADDING_LEFT, 1.0)
        editor.set(keyA, ViewProperty.PADDING_TOP, 2.0)
        editor.set(keyA, ViewProperty.ALPHA, 0.5)
        editor.set(keyB, ViewProperty.ALPHA, 0.25)
        assertEquals(4, editor.liveEdits())
        assertEquals(2, editor.revert(keyA, ViewProperty.PADDING).liveEdits)
        assertEquals(listOf(ViewProperty.ALPHA), edited(a))
        assertEquals(1, editor.revert(keyA, null).liveEdits)
        capture(a) // `b` is no longer in the latest capture: Revert all still reaches it.
        assertEquals(EditError.STALE, editor.revert(keyB, null).error)
        assertEquals(0, editor.revert(null, null).liveEdits)
        assertEquals(1f, b.values[ViewProperty.ALPHA])
    }

    @Test
    fun passwordTextIsNeverSetButItsSizeMayBe() {
        val field = FakeEditView(password = true)
        val (key) = capture(field)
        assertEquals(EditError.PASSWORD, editor.set(key, ViewProperty.TEXT, "hunter2").error)
        assertNull(editor.set(key, ViewProperty.TEXT_SIZE, 18.0).error)
        assertEquals(listOf(ViewProperty.TEXT_SIZE to 18f), access.writes)
    }

    @Test
    fun unsupportedAndInvalidEditsWriteNothing() {
        val plain = FakeEditView(textView = false, margins = false)
        val (key) = capture(plain)
        assertEquals(EditError.UNSUPPORTED, editor.set(key, ViewProperty.TEXT, "x").error)
        assertEquals(EditError.UNSUPPORTED, editor.set(key, ViewProperty.MARGIN_TOP, 4.0).error)
        assertEquals(EditError.INVALID, editor.set(key, ViewProperty.ALPHA, 2.0).error)
        assertEquals(EditError.INVALID, editor.set(key, ViewProperty.PADDING_LEFT, "8").error)
        assertTrue(access.writes.isEmpty())
    }

    @Test
    fun noNewEditBeyondTheLimitButAnExistingOneMayChange() {
        val view = FakeEditView()
        val (key) = capture(view)
        for (property in ViewProperty.PADDING) assertNull(editor.set(key, property, 3.0).error)
        val refused = editor.set(key, ViewProperty.ALPHA, 0.5)
        assertEquals(EditError.LIMIT, refused.error)
        assertEquals(4, refused.liveEdits)
        assertNull(editor.set(key, ViewProperty.PADDING_LEFT, 5.0).error)
        editor.revert(key, listOf(ViewProperty.PADDING_TOP))
        assertNull(editor.set(key, ViewProperty.ALPHA, 0.5).error)
    }

    @Test
    fun aBackgroundTheAppRecoloredInPlaceIsTheAppsNow() {
        val view = FakeEditView()
        val (key) = capture(view)
        editor.set(key, ViewProperty.BACKGROUND_COLOR, "#FF3366CC")
        // A rebind calls setBackgroundColor: it changes the ColorDrawable the edit put there, in place.
        (view.values[ViewProperty.BACKGROUND_COLOR] as Background).color = 0xFFFFEB3B.toInt()
        assertEquals(emptyList<ViewProperty>(), edited(view))
        editor.revert(null, null)
        assertEquals(0xFFFFEB3B.toInt(), (view.values[ViewProperty.BACKGROUND_COLOR] as Background).color)
    }

    @Test
    fun aTextEditInWhatBecameAPasswordFieldIsForgottenUnread() {
        val view = FakeEditView()
        val (key) = capture(view)
        editor.set(key, ViewProperty.TEXT, "Edited")
        editor.set(key, ViewProperty.ALPHA, 0.5)
        view.password = true
        view.values[ViewProperty.TEXT] = "hunter2"
        val readsBefore = access.reads[ViewProperty.TEXT]
        assertEquals(listOf(ViewProperty.ALPHA), edited(view))
        editor.revert(key, null)
        assertEquals(readsBefore, access.reads[ViewProperty.TEXT])
        assertTrue(ViewProperty.TEXT !in access.restores)
        assertEquals("hunter2", view.values[ViewProperty.TEXT])
    }

    @Test
    fun theBackgroundIsRevertedBeforeThePaddingItWouldReset() {
        val view = FakeEditView()
        val (key) = capture(view)
        editor.set(key, ViewProperty.PADDING_LEFT, 40.0)
        editor.set(key, ViewProperty.BACKGROUND_COLOR, "#FF000000")
        editor.set(key, ViewProperty.ALPHA, 0.5)
        editor.revert(key, null)
        assertEquals(listOf(ViewProperty.BACKGROUND_COLOR, ViewProperty.ALPHA, ViewProperty.PADDING_LEFT), access.restores)
    }

    @Test
    fun aValueThatCannotBeReadBackIsPutBackAndFails() {
        val view = FakeEditView()
        val (key) = capture(view)
        access.unreadableAfterWrite = ViewProperty.ALPHA
        val failed = editor.set(key, ViewProperty.ALPHA, 0.5)
        assertEquals(EditError.FAILED, failed.error)
        assertEquals(1f, view.values[ViewProperty.ALPHA])
        assertEquals(0, failed.liveEdits)
    }

    @Test
    fun aSetterThatThrowsRestoresTheOriginalAndKeepsNoEdit() {
        val view = FakeEditView()
        val (key) = capture(view)
        access.failing = ViewProperty.ALPHA
        val failed = editor.set(key, ViewProperty.ALPHA, 0.5)
        assertEquals(EditError.FAILED, failed.error)
        assertEquals(0, failed.liveEdits)
        assertEquals(1f, view.values[ViewProperty.ALPHA])
    }
}
