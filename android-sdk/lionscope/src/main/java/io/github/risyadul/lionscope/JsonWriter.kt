package io.github.risyadul.lionscope

/**
 * Minimal single-line JSON writer (no org.json: it is a stub in JVM unit tests).
 * Callers are responsible for well-formed nesting; field order is the call order.
 */
internal class JsonWriter {
    private val out = StringBuilder(256)
    private var needsComma = false

    fun beginObject(): JsonWriter = open('{')
    fun endObject(): JsonWriter = close('}')
    fun beginArray(): JsonWriter = open('[')
    fun endArray(): JsonWriter = close(']')

    fun name(name: String): JsonWriter {
        separate()
        writeString(name)
        out.append(':')
        needsComma = false
        return this
    }

    fun value(value: String?): JsonWriter {
        separate()
        if (value == null) out.append("null") else writeString(value)
        needsComma = true
        return this
    }

    fun value(value: Long): JsonWriter {
        separate()
        out.append(value)
        needsComma = true
        return this
    }

    fun value(value: Int): JsonWriter = value(value.toLong())

    /** Finite numbers only (NaN / Infinity are written as 0), rounded to 3 decimals. */
    fun value(value: Double): JsonWriter {
        separate()
        writeDecimal(value)
        needsComma = true
        return this
    }

    fun value(value: Boolean): JsonWriter {
        separate()
        out.append(value)
        needsComma = true
        return this
    }

    fun nullValue(): JsonWriter = value(null as String?)

    override fun toString(): String = out.toString()

    private fun open(bracket: Char): JsonWriter {
        separate()
        out.append(bracket)
        needsComma = false
        return this
    }

    private fun close(bracket: Char): JsonWriter {
        out.append(bracket)
        needsComma = true
        return this
    }

    private fun separate() {
        if (needsComma) out.append(',')
    }

    private fun writeString(value: String) {
        out.append('"')
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c < ' ' || c == '\u2028' || c == '\u2029' -> appendUnicodeEscape(c)
                else -> out.append(c)
            }
        }
        out.append('"')
    }

    private fun appendUnicodeEscape(c: Char) {
        val hex = Integer.toHexString(c.code)
        out.append("\\u")
        repeat(4 - hex.length) { out.append('0') }
        out.append(hex)
    }

    private fun writeDecimal(value: Double) {
        if (value.isNaN() || value.isInfinite()) {
            out.append('0')
            return
        }
        if (Math.abs(value) >= MAX_SCALED_MAGNITUDE) {
            out.append(Math.round(value))
            return
        }
        val scaled = Math.round(value * 1000)
        if (scaled < 0) out.append('-')
        val magnitude = Math.abs(scaled)
        out.append(magnitude / 1000)
        var fraction = magnitude % 1000
        if (fraction == 0L) return
        out.append('.')
        var divisor = 100L
        while (fraction > 0) {
            out.append(fraction / divisor)
            fraction %= divisor
            divisor /= 10
        }
    }

    private companion object {
        /** Above this, ×1000 would lose precision; such values are written as integers. */
        const val MAX_SCALED_MAGNITUDE = 1e12
    }
}
