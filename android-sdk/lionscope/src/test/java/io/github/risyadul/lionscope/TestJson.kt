package io.github.risyadul.lionscope

/** Tiny strict JSON parser for tests: objects → LinkedHashMap (order kept), numbers → Double. */
object TestJson {

    fun parse(text: String): Any? {
        val parser = Parser(text)
        val value = parser.value()
        parser.skipWhitespace()
        require(parser.atEnd()) { "Trailing characters at ${parser.pos} in $text" }
        return value
    }

    /** Recursively lists object keys in order, so field order can be asserted alongside value equality. */
    fun keyOrder(value: Any?): List<Any> = when (value) {
        is Map<*, *> -> value.entries.map { (key, child) -> listOf(key!!, keyOrder(child)) }
        is List<*> -> value.map { keyOrder(it) }
        else -> emptyList()
    }

    private class Parser(private val s: String) {
        var pos = 0

        fun atEnd() = pos >= s.length

        fun skipWhitespace() {
            while (!atEnd() && s[pos] in " \t\r\n") pos++
        }

        fun value(): Any? {
            skipWhitespace()
            require(!atEnd()) { "Unexpected end" }
            return when (val c = s[pos]) {
                '{' -> obj()
                '[' -> array()
                '"' -> string()
                't' -> literal("true", true)
                'f' -> literal("false", false)
                'n' -> literal("null", null)
                else -> if (c == '-' || c.isDigit()) number() else error("Unexpected '$c' at $pos")
            }
        }

        private fun obj(): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()
            expect('{')
            skipWhitespace()
            if (peek() == '}') {
                pos++
                return map
            }
            while (true) {
                skipWhitespace()
                val key = string()
                skipWhitespace()
                expect(':')
                require(!map.containsKey(key)) { "Duplicate key $key" }
                map[key] = value()
                skipWhitespace()
                if (peek() == ',') pos++ else break
            }
            expect('}')
            return map
        }

        private fun array(): List<Any?> {
            val list = ArrayList<Any?>()
            expect('[')
            skipWhitespace()
            if (peek() == ']') {
                pos++
                return list
            }
            while (true) {
                list.add(value())
                skipWhitespace()
                if (peek() == ',') pos++ else break
            }
            expect(']')
            return list
        }

        private fun string(): String {
            expect('"')
            val out = StringBuilder()
            while (true) {
                val c = s[pos++]
                when {
                    c == '"' -> return out.toString()
                    c == '\\' -> {
                        when (val e = s[pos++]) {
                            '"', '\\', '/' -> out.append(e)
                            'n' -> out.append('\n')
                            'r' -> out.append('\r')
                            't' -> out.append('\t')
                            'b' -> out.append('\b')
                            'f' -> out.append('\u000C')
                            'u' -> {
                                out.append(s.substring(pos, pos + 4).toInt(16).toChar())
                                pos += 4
                            }
                            else -> error("Bad escape \\$e")
                        }
                    }
                    c < ' ' -> error("Raw control character in string at ${pos - 1}")
                    else -> out.append(c)
                }
            }
        }

        private fun number(): Double {
            val start = pos
            if (peek() == '-') pos++
            while (!atEnd() && (s[pos].isDigit() || s[pos] in ".eE+-")) pos++
            val token = s.substring(start, pos)
            require(Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?").matches(token)) { "Bad number $token" }
            return token.toDouble()
        }

        private fun literal(word: String, value: Any?): Any? {
            require(s.startsWith(word, pos)) { "Expected $word at $pos" }
            pos += word.length
            return value
        }

        private fun peek(): Char = if (atEnd()) '\u0000' else s[pos]

        private fun expect(c: Char) {
            require(peek() == c) { "Expected '$c' at $pos in $s" }
            pos++
        }
    }
}
