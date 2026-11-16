package io.github.risyadul.lionscope

import java.util.Locale

internal class StorageSqlPlan(val sql: String, val readOnly: Boolean, val table: String?)

/** Mirrors protocol/storageSql.ts; expressions are validated by SQLite inside the Room transaction. */
internal object StorageSql {
    private class Token(val text: String, val word: Boolean, val depth: Int)
    private val roots = setOf("SELECT", "INSERT", "UPDATE", "DELETE")

    fun plan(source: String): StorageSqlPlan {
        if (source.isBlank() || source.length > 16 * 1024 || '\u0000' in source) throw StorageAbort("invalid_value")
        val tokens = ArrayList<Token>()
        var depth = 0
        var end = source.length
        var ended = false
        var i = 0
        while (i < source.length) {
            val c = source[i]
            if (c.isWhitespace()) { i++; continue }
            if (source.startsWith("--", i)) {
                val next = source.indexOf('\n', i + 2)
                i = if (next < 0) source.length else next + 1
                continue
            }
            if (source.startsWith("/*", i)) {
                val next = source.indexOf("*/", i + 2)
                if (next < 0) throw StorageAbort("invalid_value")
                i = next + 2
                continue
            }
            if (ended) throw StorageAbort("unsupported:multiple_statements")
            if (c == ';') { ended = true; end = i; i++; continue }
            if (c in "?:@$") throw StorageAbort("unsupported:parameters")
            if (c in "'\"`[") {
                val close = if (c == '[') ']' else c
                val value = StringBuilder()
                var closed = false
                i++
                while (i < source.length) {
                    if (source[i] == close) {
                        if (c != '[' && i + 1 < source.length && source[i + 1] == close) { value.append(close); i += 2; continue }
                        i++; closed = true; break
                    }
                    value.append(source[i++])
                }
                if (!closed) throw StorageAbort("invalid_value")
                tokens += Token(value.toString(), false, depth)
                continue
            }
            if (c == '(') { tokens += Token("(", false, depth); depth++; i++; continue }
            if (c == ')') { depth--; if (depth < 0) throw StorageAbort("invalid_value"); tokens += Token(")", false, depth); i++; continue }
            val word = c == '_' || c in 'a'..'z' || c in 'A'..'Z' || c.code >= 128
            val start = i++
            if (word) while (i < source.length && (source[i].isLetterOrDigit() || source[i] == '_' || source[i].code >= 128)) i++
            tokens += Token(source.substring(start, i), word, depth)
        }
        if (depth != 0) throw StorageAbort("invalid_value")
        val top = tokens.filter { it.depth == 0 }
        fun keyword(index: Int): String = top.getOrNull(index)?.takeIf { it.word }?.text?.uppercase(Locale.ROOT) ?: ""
        val root = if (keyword(0) == "WITH") top.indexOfFirst { it.word && it.text.uppercase(Locale.ROOT) in roots } else 0
        val op = keyword(root)
        if (op !in roots) throw StorageAbort("unsupported:sql_statement")
        if (op == "SELECT") return StorageSqlPlan(source.substring(0, end).trim(), true, null)
        if (tokens.any { it.word && it.text.uppercase(Locale.ROOT) in setOf("ROLLBACK", "RETURNING") }) throw StorageAbort("unsupported:sql_statement")
        var target = root + 1
        if (op != "DELETE" && keyword(target) == "OR") target += 2
        if (op == "INSERT") { if (keyword(target) != "INTO") throw StorageAbort("invalid_value"); target++ }
        if (op == "DELETE") { if (keyword(target) != "FROM") throw StorageAbort("invalid_value"); target++ }
        var table = top.getOrNull(target)?.text
        if (top.getOrNull(target + 1)?.text == ".") {
            if (!table.equals("main", ignoreCase = true)) throw StorageAbort("unsupported:database")
            table = top.getOrNull(target + 2)?.text
        }
        if (table.isNullOrEmpty() || table in setOf("(", ")", ".", ",", ";")) throw StorageAbort("invalid_value")
        return StorageSqlPlan(source.substring(0, end).trim(), false, table)
    }
}
