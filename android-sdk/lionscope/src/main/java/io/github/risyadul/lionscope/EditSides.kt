package io.github.risyadul.lionscope

/** A value [ViewEditor] compares by equality (a data class), where it compares other objects by identity. */
internal interface EditValue

/**
 * A background as an edit compares it: the Drawable (by identity) and, for a ColorDrawable, its color, since
 * `View.setBackgroundColor` changes an existing ColorDrawable in place: an app recoloring a row it rebinds is seen.
 */
internal data class BackgroundState(val drawable: Any?, val color: Int?) : EditValue

/** A TextView's text as an edit compares it: what it says and how many spans style it (an edit drops them). */
internal data class TextState(val text: String, val spans: Int) : EditValue

/** The four sides of padding, as `getPadding*` gives them (absolute), and whether the view set them relative. */
internal data class PaddingState(val left: Int, val top: Int, val right: Int, val bottom: Int, val relative: Boolean)

/** Which side of a layout an absolute left or right is, per layout direction. */
internal enum class RelativeSide { START, END }

/**
 * Side arithmetic of live edits, free of Android types so both layout directions can be tested: an edit names an
 * absolute side (what the snapshot shows), a view or its params may keep relative ones (start / end).
 */
internal object EditSides {
    /** [padding] with the side of [property] (a padding property) set to [value]. */
    fun withSide(padding: PaddingState, property: ViewProperty, value: Int): PaddingState = when (property) {
        ViewProperty.PADDING_LEFT -> padding.copy(left = value)
        ViewProperty.PADDING_TOP -> padding.copy(top = value)
        ViewProperty.PADDING_RIGHT -> padding.copy(right = value)
        ViewProperty.PADDING_BOTTOM -> padding.copy(bottom = value)
        else -> throw IllegalArgumentException("not a padding side: $property")
    }

    /** [padding] as `setPaddingRelative(start, top, end, bottom)` takes it. */
    fun relative(padding: PaddingState, rtl: Boolean): IntArray = if (rtl) {
        intArrayOf(padding.right, padding.top, padding.left, padding.bottom)
    } else {
        intArrayOf(padding.left, padding.top, padding.right, padding.bottom)
    }

    /** The relative margin that a left or right margin is in [rtl] or not; null for top and bottom. */
    fun relativeMargin(property: ViewProperty, rtl: Boolean): RelativeSide? = when (property) {
        ViewProperty.MARGIN_LEFT -> if (rtl) RelativeSide.END else RelativeSide.START
        ViewProperty.MARGIN_RIGHT -> if (rtl) RelativeSide.START else RelativeSide.END
        else -> null
    }

    /**
     * Whether styled text can be kept for a revert as it is: only when every span is a framework one
     * (`android.*`: StyleSpan, ForegroundColorSpan, URLSpan...), which holds no reference to the app. An app's span
     * (a ClickableSpan subclass) may hold its Activity, which a kept edit would then never let go.
     */
    fun keepsSpans(spanClasses: List<String>): Boolean = spanClasses.all { it.startsWith("android.") }
}
