package io.github.risyadul.lionscope

import android.content.Context
import android.util.Log
import android.view.View

/** What the Inspector reads of a composable's semantics (its own layout nodes, not its shown children's). */
internal class ComposeSemantics(
    val text: String?,
    val contentDescription: String?,
    val testTag: String?,
    val enabled: Boolean,
    val clickable: Boolean,
    val focused: Boolean,
    val selected: Boolean,
    val checked: Boolean?,
    /** A password field (password semantics or a password content type): neither text nor description is sent. */
    val secret: Boolean,
) {
    companion object {
        val NONE = ComposeSemantics(null, null, null, true, false, false, false, null, secret = false)
    }
}

/**
 * One AndroidComposeView as read for a capture: its [status], its composables ([roots], with their semantics in
 * [semantics]) when read, the Views of AndroidViews it [claimed] (shown under their composables instead of under
 * AndroidViewsHandler), and whether the group budget ran out ([truncated]).
 */
internal class ComposeRead(
    val status: CompositionStatus,
    val roots: List<ComposeNode> = emptyList(),
    val semantics: Map<ComposeNode, ComposeSemantics> = emptyMap(),
    val claimed: Set<View> = emptySet(),
    val truncated: Boolean = false,
)

/** Reads AndroidComposeViews (main thread); implemented only by the Compose-linked [ComposeViewReader]. */
internal interface ComposeReading {
    /** A fresh capture: the group budget is shared by every view read until the next [beginCapture]. */
    fun beginCapture()
    fun read(view: View): ComposeRead
}

/**
 * Compose inspection setup. The composition is only readable if `isDebugInspectorInfoEnabled` was on when it was
 * first composed (then Compose keeps its slot table and source information for tools), so [install] turns it on when
 * the SDK is installed, before any Activity exists. Off when the app has no Compose UI or opted out in its manifest:
 * `<meta-data android:name="io.github.risyadul.lionscope.composeInspection" android:value="false" />`. Turning it
 * on costs some speed and memory in composition (Compose keeps recompose scopes and source markers, and adds a
 * graphics layer for tooling to some composables), like Android Studio's Layout Inspector does.
 */
internal object ComposeSupport {
    const val META_DATA = "io.github.risyadul.lionscope.composeInspection"
    private const val COMPOSE_VIEW = "androidx.compose.ui.platform.AndroidComposeView"
    private const val COMPOSITION_DATA = "androidx.compose.runtime.tooling.CompositionData"

    /** Null when Compose inspection is off for this process; set once by [install]. */
    @Volatile
    var reading: ComposeReading? = null
        private set

    /**
     * Turns inspection on and sets [reading] when the app has Compose UI. Opted out (or failing to turn it on), every
     * AndroidComposeView reads as [CompositionStatus.DISABLED] (or [CompositionStatus.FAILED]), so the server can say
     * why it fell back to uiautomator.
     */
    fun install(
        context: Context,
        classExists: (String) -> Boolean = ::classExists,
        metaData: (String) -> Any? = { applicationMetaData(context, it) },
    ) {
        if (reading != null || !classExists(COMPOSE_VIEW) || !classExists(COMPOSITION_DATA)) return
        if (!InflateOptOut.allowsValue(metaData(META_DATA))) {
            Log.i(LOG_TAG, "Lionscope Compose inspection off for this app ($META_DATA = false)")
            reading = Unreadable(CompositionStatus.DISABLED)
            return
        }
        reading = try {
            ComposeInspectionSwitch.enable()
            ComposeViewReader()
        } catch (e: LinkageError) {
            Log.w(LOG_TAG, "Lionscope Compose inspection unavailable: $e")
            Unreadable(CompositionStatus.FAILED)
        } catch (e: RuntimeException) {
            Log.w(LOG_TAG, "Lionscope Compose inspection unavailable: $e")
            Unreadable(CompositionStatus.FAILED)
        }
    }

    /** Tests only: forget what [install] set. */
    internal fun reset() {
        reading = null
    }

    private class Unreadable(private val status: CompositionStatus) : ComposeReading {
        override fun beginCapture() = Unit
        override fun read(view: View): ComposeRead = ComposeRead(status)
    }

    private fun classExists(name: String): Boolean = try {
        Class.forName(name, false, ComposeSupport::class.java.classLoader)
        true
    } catch (e: ClassNotFoundException) {
        false
    } catch (e: LinkageError) {
        false
    }
}
