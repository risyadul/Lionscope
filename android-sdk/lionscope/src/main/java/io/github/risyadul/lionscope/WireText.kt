package io.github.risyadul.lionscope

/**
 * Text as the server accepts it: no control (Cc) or format (Cf) characters, no runs of spaces, trimmed, capped, and
 * never empty. The server rejects a whole message over one bad field (and closes the link for v1 types), and some
 * text comes from app code (screen aliases, StrictMode messages), so every SDK-produced text field goes through here.
 */
internal object WireText {
    /** Placeholder for a required field that is empty after cleaning. */
    const val UNKNOWN = "?"

    /**
     * Cc / Cf code points (`\n`, `\t`, U+200E, U+202E, ZWJ, ...) become spaces, runs of spaces collapse to one, then
     * the text is trimmed and capped to [max] UTF-16 units without splitting a surrogate pair. Null when empty.
     */
    fun clean(value: String?, max: Int): String? {
        if (value == null) return null
        val cleaned = if (isClean(value)) value else replaceAndCollapse(value)
        return capLength(cleaned.trim(), max).trim().ifEmpty { null }
    }

    /** [clean], or [fallback] when nothing is left. */
    fun required(value: String?, max: Int, fallback: String = UNKNOWN): String = clean(value, max) ?: fallback

    private fun isClean(value: String): Boolean {
        var previousSpace = false
        var i = 0
        while (i < value.length) {
            val codePoint = value.codePointAt(i)
            if (isControlOrFormat(codePoint)) return false
            val space = codePoint == ' '.code
            if (space && previousSpace) return false
            previousSpace = space
            i += Character.charCount(codePoint)
        }
        return true
    }

    private fun replaceAndCollapse(value: String): String = buildString(value.length) {
        var i = 0
        while (i < value.length) {
            val codePoint = value.codePointAt(i)
            if (isControlOrFormat(codePoint) || codePoint == ' '.code) {
                if (isEmpty() || last() != ' ') append(' ')
            } else {
                appendCodePoint(codePoint)
            }
            i += Character.charCount(codePoint)
        }
    }

    private fun isControlOrFormat(codePoint: Int): Boolean {
        val type = Character.getType(codePoint)
        return type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()
    }
}

/** [value] cut to at most [max] UTF-16 units, never splitting a surrogate pair. */
internal fun capLength(value: String, max: Int): String {
    if (value.length <= max) return value
    val end = if (Character.isHighSurrogate(value[max - 1])) max - 1 else max
    return value.substring(0, end)
}
