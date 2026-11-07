package io.github.risyadul.lionscope

/**
 * A strict, dependency-free JSON reader for the storage inspector's nested values (a typed value, a primary key, the
 * pages of a read), which arrive as JSON text inside a flat gateway line ([FlatJson]). Objects come out as
 * [LinkedHashMap]s, arrays as [List]s, strings as [String] (every escape, `\uXXXX` included, so a lone surrogate comes
 * back as it was), numbers as [Number] (the literal text, nothing rounded), booleans as [Boolean] and null as [NULL].
 * Duplicate keys, raw control characters, trailing text and nesting deeper than [MAX_DEPTH] make the whole text
 * invalid (null). No regex ever runs over a value.
 */
internal object StrictJson {
    /** JSON null (a null return means invalid). */
    val NULL = Any()

    /** A number as written. */
    class Number(val literal: String)

    private const val MAX_DEPTH = 8
    private val NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")

    fun parse(text: String): Any? {
        val scanner = Scanner(text)
        val value = scanner.value(0) ?: return null
        scanner.skipWhitespace()
        return if (scanner.pos == text.length) value else null
    }

    private class Scanner(private val s: String) {
        var pos = 0

        fun value(depth: Int): Any? {
            skipWhitespace()
            if (pos >= s.length || depth > MAX_DEPTH) return null
            return when (s[pos]) {
                '{' -> obj(depth)
                '[' -> array(depth)
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", NULL)
                else -> number()
            }
        }

        private fun obj(depth: Int): Map<String, Any?>? {
            pos++
            val map = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (consume('}')) return map
            while (true) {
                skipWhitespace()
                val key = string() ?: return null
                skipWhitespace()
                if (!consume(':')) return null
                if (map.containsKey(key)) return null
                map[key] = value(depth + 1) ?: return null
                skipWhitespace()
                if (consume(',')) continue
                return if (consume('}')) map else null
            }
        }

        private fun array(depth: Int): List<Any?>? {
            pos++
            val list = ArrayList<Any?>()
            skipWhitespace()
            if (consume(']')) return list
            while (true) {
                list += value(depth + 1) ?: return null
                skipWhitespace()
                if (consume(',')) continue
                return if (consume(']')) list else null
            }
        }

        private fun literal(word: String, value: Any): Any? {
            if (!s.startsWith(word, pos)) return null
            pos += word.length
            return value
        }

        private fun number(): Number? {
            val start = pos
            while (pos < s.length && s[pos] in "+-.0123456789eE") pos++
            val literal = s.substring(start, pos)
            return if (NUMBER.matches(literal)) Number(literal) else null
        }

        fun string(): String? {
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
                                if (!hex.all { it in "0123456789abcdefABCDEF" }) return null
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

        fun skipWhitespace() {
            while (pos < s.length && s[pos] in " \t\r\n") pos++
        }

        private fun consume(c: Char): Boolean {
            if (pos < s.length && s[pos] == c) {
                pos++
                return true
            }
            return false
        }
    }
}
