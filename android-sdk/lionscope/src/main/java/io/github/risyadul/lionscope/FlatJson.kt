package io.github.risyadul.lionscope

/**
 * A dependency-free reader for one flat JSON object (org.json is a stub in JVM unit tests): string, number, boolean
 * and null values only. Strings take every JSON escape (`\uXXXX` included, so surrogate pairs come out as they were
 * written); numbers are kept as their literal text. Nested objects or arrays, duplicate keys, raw control characters
 * in strings and trailing text make the whole line invalid (null). The v7 `mocks` / `mock` lines are read with it:
 * their url, headers and body may hold any text, so no regex runs over them.
 */
internal class FlatJson private constructor(private val values: Map<String, Any?>) {

    /** The string value of [key], null when missing or not a string. */
    fun string(key: String): String? = values[key] as? String

    /** The value of [key] if it is a JSON integer that fits an Int (no fraction, no exponent), else null. */
    fun int(key: String): Int? {
        val number = values[key] as? JsonNumber ?: return null
        if (!INTEGER.matches(number.literal)) return null
        return number.literal.toIntOrNull()
    }

    fun boolean(key: String): Boolean? = values[key] as? Boolean

    fun has(key: String): Boolean = values.containsKey(key)

    /** A number as written, so integers of any size are told apart from fractions without rounding. */
    private class JsonNumber(val literal: String)

    private class Scanner(private val s: String) {
        var pos = 0

        fun parseObject(): Map<String, Any?>? {
            val map = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (!consume('{')) return null
            skipWhitespace()
            if (consume('}')) return finish(map)
            while (true) {
                skipWhitespace()
                val key = string() ?: return null
                skipWhitespace()
                if (!consume(':')) return null
                skipWhitespace()
                if (map.containsKey(key)) return null
                map[key] = value() ?: return null
                skipWhitespace()
                if (consume(',')) continue
                if (consume('}')) return finish(map)
                return null
            }
        }

        private fun finish(map: Map<String, Any?>): Map<String, Any?>? {
            skipWhitespace()
            return if (pos == s.length) map else null
        }

        /** Null when invalid; JSON null is [NULL]. */
        private fun value(): Any? {
            if (pos >= s.length) return null
            return when (s[pos]) {
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", NULL)
                else -> number()
            }
        }

        private fun literal(word: String, value: Any): Any? {
            if (!s.startsWith(word, pos)) return null
            pos += word.length
            return value
        }

        private fun number(): JsonNumber? {
            val start = pos
            while (pos < s.length && s[pos] in NUMBER_CHARS) pos++
            val literal = s.substring(start, pos)
            return if (NUMBER.matches(literal)) JsonNumber(literal) else null
        }

        private fun string(): String? {
            if (!consume('"')) return null
            val out = StringBuilder()
            while (pos < s.length) {
                val c = s[pos++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        if (pos >= s.length) return null
                        when (val escape = s[pos++]) {
                            '"', '\\', '/' -> out.append(escape)
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'u' -> {
                                if (pos + 4 > s.length) return null
                                val hex = s.substring(pos, pos + 4)
                                if (!hex.all { it in HEX_DIGITS }) return null
                                out.append(hex.toInt(16).toChar())
                                pos += 4
                            }
                            else -> return null
                        }
                    }
                    c < ' ' -> return null
                    else -> out.append(c)
                }
            }
            return null
        }

        private fun skipWhitespace() {
            while (pos < s.length && s[pos] in WHITESPACE) pos++
        }

        private fun consume(c: Char): Boolean {
            if (pos < s.length && s[pos] == c) {
                pos++
                return true
            }
            return false
        }
    }

    companion object {
        /** Stands for JSON null while scanning (a null return means invalid). */
        private val NULL = Any()
        private const val WHITESPACE = " \t\r\n"
        private const val NUMBER_CHARS = "+-.0123456789eE"
        private const val HEX_DIGITS = "0123456789abcdefABCDEF"
        private val NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")
        private val INTEGER = Regex("-?(0|[1-9][0-9]*)")

        /** The object on [line], or null when it is not exactly one flat JSON object. */
        fun parse(line: String): FlatJson? {
            val map = Scanner(line).parseObject() ?: return null
            return FlatJson(map.mapValues { (_, value) -> if (value === NULL) null else value })
        }
    }
}
