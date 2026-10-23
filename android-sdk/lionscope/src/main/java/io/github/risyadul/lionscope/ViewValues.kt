package io.github.risyadul.lionscope

/**
 * The values a live edit may set, as [ViewEditor] hands them to the setters, bounded like `normalizeViewValue` in
 * protocol/src/wire.ts (the server checks first; this is the SDK's own check of what reaches the app). [parse] gives
 * a [ViewVisibility] for `visibility`, a Float for alpha, translation, elevation and text size (sp), an Int for
 * padding, margins, layout sizes (`MATCH_PARENT` / `WRAP_CONTENT` / px) and colors (ARGB), a Boolean for `enabled`
 * and a String for `text`; null when [raw] is not a valid value of [property].
 */
internal object ViewValues {
    const val MAX_PADDING_PX = 2000
    const val MAX_MARGIN_PX = 2000
    const val MAX_SIZE_PX = 10_000
    const val MAX_TRANSLATION_PX = 10_000f
    const val MAX_ELEVATION_PX = 1000f
    const val MIN_TEXT_SIZE_SP = 1f
    const val MAX_TEXT_SIZE_SP = 200f
    const val MAX_TEXT_CHARS = 500
    /** `ViewGroup.LayoutParams.MATCH_PARENT` / `WRAP_CONTENT`. */
    const val MATCH_PARENT = -1
    const val WRAP_CONTENT = -2
    private const val HEX_RGB = 6
    private const val HEX_ARGB = 8
    private const val OPAQUE = 0xFF000000.toInt()
    private val LAYOUT_PX = Regex("(\\d{1,5})px")

    fun parse(property: ViewProperty, raw: Any?): Any? = when (property) {
        ViewProperty.VISIBILITY -> ViewVisibility.values().firstOrNull { it.wire == raw }
        ViewProperty.ALPHA -> fraction(raw, 0f, 1f)
        ViewProperty.ENABLED -> raw as? Boolean
        ViewProperty.PADDING_LEFT, ViewProperty.PADDING_TOP, ViewProperty.PADDING_RIGHT, ViewProperty.PADDING_BOTTOM ->
            pixels(raw, 0, MAX_PADDING_PX)
        ViewProperty.MARGIN_LEFT, ViewProperty.MARGIN_TOP, ViewProperty.MARGIN_RIGHT, ViewProperty.MARGIN_BOTTOM ->
            pixels(raw, -MAX_MARGIN_PX, MAX_MARGIN_PX)
        ViewProperty.LAYOUT_WIDTH, ViewProperty.LAYOUT_HEIGHT -> layoutSize(raw)
        ViewProperty.TRANSLATION_X, ViewProperty.TRANSLATION_Y -> fraction(raw, -MAX_TRANSLATION_PX, MAX_TRANSLATION_PX)
        ViewProperty.ELEVATION -> fraction(raw, 0f, MAX_ELEVATION_PX)
        ViewProperty.BACKGROUND_COLOR, ViewProperty.TEXT_COLOR -> (raw as? String)?.let(::color)
        ViewProperty.TEXT -> (raw as? String)?.takeIf(::isEditableText)
        ViewProperty.TEXT_SIZE -> fraction(raw, MIN_TEXT_SIZE_SP, MAX_TEXT_SIZE_SP)
    }

    /** `#RRGGBB` (opaque) or `#AARRGGBB`, any case, as an ARGB int; null otherwise. */
    fun color(value: String): Int? {
        if (!value.startsWith("#") || (value.length != HEX_RGB + 1 && value.length != HEX_ARGB + 1)) return null
        val digits = value.substring(1)
        if (!digits.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        val parsed = digits.toLong(16).toInt()
        return if (digits.length == HEX_RGB) parsed or OPAQUE else parsed
    }

    /** An ARGB int as `#AARRGGBB` (upper case), as the wire carries colors. */
    fun hex(color: Int): String {
        val digits = Integer.toHexString(color).uppercase(java.util.Locale.ROOT)
        return "#" + "0".repeat(HEX_ARGB - digits.length) + digits
    }

    /**
     * At most [MAX_TEXT_CHARS] UTF-16 units; no control character but tab and line feed (C0, DEL and C1), no lone
     * surrogate.
     */
    fun isEditableText(value: String): Boolean {
        if (value.length > MAX_TEXT_CHARS) return false
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if ((c < ' ' && c != '\t' && c != '\n') || c in '\u007F'..'\u009F') return false
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= value.length || !Character.isLowSurrogate(value[i + 1])) return false
                i++
            } else if (Character.isLowSurrogate(c)) {
                return false
            }
            i++
        }
        return true
    }

    private fun fraction(raw: Any?, min: Float, max: Float): Float? {
        val value = raw as? Double ?: return null
        return if (!value.isNaN() && value >= min && value <= max) value.toFloat() else null
    }

    /** A whole number of pixels within [min]..[max]. */
    private fun pixels(raw: Any?, min: Int, max: Int): Int? {
        val value = raw as? Double ?: return null
        if (value != Math.floor(value) || value < min || value > max) return null
        return value.toInt()
    }

    private fun layoutSize(raw: Any?): Int? = when (raw) {
        "match_parent" -> MATCH_PARENT
        "wrap_content" -> WRAP_CONTENT
        is String -> LAYOUT_PX.matchEntire(raw)?.groupValues?.get(1)?.toInt()?.takeIf { it <= MAX_SIZE_PX }
        else -> null
    }
}
