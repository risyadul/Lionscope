package io.github.risyadul.lionscope

/** A column as `PRAGMA table_info` reports it ([pk]: 1-based position in the primary key, 0 when not in it). */
internal class ColumnInfo(val name: String, val type: String, val notNull: Boolean, val pk: Int)

/**
 * A table, view or virtual table of a database, and why its rows can't be edited (null: non-key cells can be).
 * [columns] are all of its columns (what digests and compares use); [wireColumns] the ones sent, at most
 * [MAX_STORAGE_COLUMNS] (a wider table is read-only: `truncated`).
 */
internal class TableInfo(
    val name: String,
    val kind: String,
    val withoutRowid: Boolean,
    val columns: List<ColumnInfo>,
    val readOnly: String?,
) {
    val pk: List<String> = columns.filter { it.pk > 0 }.sortedBy { it.pk }.map { it.name }
    val wireColumns: List<ColumnInfo> get() = columns.take(MAX_STORAGE_COLUMNS)

    /** Rows are paged by `rowid` (a rowid table without an explicit primary key, a virtual table has one too). */
    val pagesByRowid: Boolean get() = pk.isEmpty() && kind != "view" && !withoutRowid
}

/**
 * One page of a read as materialized inside the transaction: whole raw rows (every column, in schema order, plus the
 * rowid when paged by it). Projection, digests, cursors, cutting and redaction happen after the transaction.
 */
internal class RawPage(
    val table: TableInfo,
    /** The asked columns, and their indexes in a raw row. */
    val columns: List<String>,
    private val indexes: List<Int>,
    private val rows: List<List<Any?>>,
    /** Where each row's paging key is: primary key cells, the rowid, or none (an offset). */
    private val keyIndexes: List<Int>,
    private val offset: Int,
    val more: Boolean,
) {
    val size: Int get() = rows.size

    fun cells(row: Int): List<Any?> = indexes.map { rows[row][it] }

    /** The row's digest over all of its columns, sent or not (null when the table is read-only). */
    fun digest(row: Int): String? =
        if (table.readOnly == null) RowDigest.of(rows[row].take(table.columns.size)) else null

    /** Where the page continues after [row] (kept on the device: [StorageCursors]). */
    fun positionAfter(row: Int): StorageCursors.Position =
        if (keyIndexes.isEmpty()) {
            StorageCursors.Position.AfterOffset(offset + row + 1)
        } else {
            StorageCursors.Position.AfterKeys(keyIndexes.map { rows[row][it] })
        }
}

/** A page request as parsed from `storageRead.pages`, its cursor already resolved to a [position]. */
internal class PageRequest(
    val table: String,
    val columns: List<String>?,
    val position: StorageCursors.Position,
    val limit: Int,
)

/**
 * The storage inspector's database side: the schema, pages of rows and compare-and-set edits of one registered
 * database, each request in ONE transaction of the app's own database ([TrackedDatabase.inTransaction]), never through
 * a connection of its own. Raw cells are only materialized inside the transaction; cutting, redacting and encoding
 * happen after it. Every identifier comes from the schema (`sqlite_master`, `PRAGMA table_info`) and is quoted;
 * anything that does not match it exactly is `invalid_identifier`. A transaction past [budgetMs] (counted from when it
 * was got) is rolled back: `timeout`.
 */
internal class DbInspector(
    private val nanoTime: () -> Long = System::nanoTime,
    private val budgetMs: Long = STORAGE_TX_BUDGET_MS,
) {
    /** Measures one transaction from when it was got. */
    private inner class Budget {
        private val start = nanoTime()

        val elapsedMs: Long get() = (nanoTime() - start) / 1_000_000

        fun check() {
            if (elapsedMs > budgetMs) throw StorageAbort("timeout")
        }
    }

    class Timed<T>(val value: T, val txMs: Long)

    /** Every table (at most [MAX_STORAGE_TABLES], `more` when there were more). */
    fun schema(db: TrackedDatabase): Timed<Pair<List<TableInfo>, Boolean>> = transaction(db) { conn, budget ->
        val master = conn.query(MASTER_SQL + " ORDER BY name LIMIT ${MAX_STORAGE_TABLES + 1}")
        budget.check()
        val virtuals = virtualNames(master)
        val deferred = deferredFkTables(conn)
        budget.check()
        val tables = master.rows.take(MAX_STORAGE_TABLES).map { row ->
            tableInfo(conn, row[0] as String, row[1] as String, row[2] as? String, virtuals, deferred).also { budget.check() }
        }
        tables to (master.rows.size > MAX_STORAGE_TABLES)
    }

    /** Up to [MAX_STORAGE_PAGES] pages, all in one transaction (one consistent snapshot). */
    fun pages(db: TrackedDatabase, requests: List<PageRequest>): Timed<List<RawPage>> = transaction(db) { conn, budget ->
        val virtuals = virtualNames(conn.query("$MASTER_SQL AND sql LIKE 'CREATE VIRTUAL TABLE%'"))
        val deferred = deferredFkTables(conn)
        requests.mapIndexed { index, request ->
            if (index > 0) StorageTestHooks.betweenPages?.run()
            budget.check()
            page(conn, budget, request, virtuals, deferred)
        }
    }

    /**
     * Update one cell, compare-and-set, all in one transaction: read the row by primary key, compare in Kotlin (exact
     * per type), UPDATE by primary key (exactly one row), read the cell back and commit.
     */
    fun update(
        db: TrackedDatabase,
        table: String,
        column: String,
        pk: List<StorageValue>,
        expected: StorageValue,
        value: StorageValue,
    ): Timed<WriteOutcome> = transaction(db) { conn, budget ->
        val info = editableTable(conn, table)
        val target = info.columns.firstOrNull { it.name == column } ?: throw StorageAbort("invalid_identifier")
        if (target.pk > 0) throw StorageAbort("read_only:pk_column")
        val row = rowByPk(conn, info, pk) ?: throw StorageAbort("not_found")
        budget.check()
        val raw = row[info.columns.indexOf(target)]
        if (StorageCut.isCut(raw)) throw StorageAbort("read_only:truncated")
        val current = StorageCut.exactCell(raw)
        if (StorageRedaction.hides(column, current)) throw StorageAbort("read_only:redacted")
        if (!current.same(expected)) {
            throw StorageAbort(if (current.same(value)) "already_applied_or_concurrent" else "conflict", current)
        }
        if (!fits(value, current, target.type)) throw StorageAbort("type_mismatch")
        val before = totalChanges(conn)
        val changes = conn.updateDelete(
            "UPDATE ${quote(info.name)} SET ${quote(column)} = ? WHERE ${pkWhere(info)}",
            listOf(StorageCut.bindable(value)) + pk.map(StorageCut::bindable),
        )
        if (changes != 1) throw StorageAbort("failed")
        val stored = StorageCut.exactCell(
            conn.query("SELECT ${quote(column)} FROM ${quote(info.name)} WHERE ${pkWhere(info)}", pk.map(StorageCut::bindable))
                .rows.singleOrNull()?.get(0).also { budget.check() },
        )
        val delta = totalChanges(conn) - before
        budget.check()
        WriteOutcome(
            code = "ok",
            stored = stored,
            normalized = !stored.same(value),
            changes = changes,
            totalChangesDelta = delta,
        )
    }

    /** Delete one row, compare-and-set on its digest; a row already gone is `already_applied_or_concurrent`. */
    fun delete(db: TrackedDatabase, table: String, pk: List<StorageValue>, rowDigest: String): Timed<WriteOutcome> =
        transaction(db) { conn, budget ->
            val info = editableTable(conn, table)
            val row = rowByPk(conn, info, pk) ?: throw StorageAbort("already_applied_or_concurrent")
            budget.check()
            if (RowDigest.of(row) != rowDigest) throw StorageAbort("conflict")
            val before = totalChanges(conn)
            val changes = conn.updateDelete("DELETE FROM ${quote(info.name)} WHERE ${pkWhere(info)}", pk.map(StorageCut::bindable))
            if (changes != 1) throw StorageAbort("failed")
            val delta = totalChanges(conn) - before
            budget.check()
            WriteOutcome(code = "ok", changes = changes, totalChangesDelta = delta)
        }

    class WriteOutcome(
        val code: String,
        val current: StorageValue? = null,
        val stored: StorageValue? = null,
        val normalized: Boolean? = null,
        val changes: Int? = null,
        val totalChangesDelta: Long? = null,
    )

    private fun <T> transaction(db: TrackedDatabase, block: (SqlConnection, Budget) -> T): Timed<T> {
        var budget: Budget? = null
        val value = db.inTransaction { conn ->
            StorageTestHooks.touched()
            val started = Budget()
            budget = started
            block(conn, started)
        }
        return Timed(value, budget?.elapsedMs ?: 0)
    }

    private fun page(
        conn: SqlConnection,
        budget: Budget,
        request: PageRequest,
        virtuals: Set<String>,
        deferred: Set<String>,
    ): RawPage {
        val master = conn.query("$MASTER_SQL AND name = ?", listOf(request.table))
        val row = master.rows.firstOrNull { it[1] == request.table } ?: throw StorageAbort("not_found")
        val info = tableInfo(conn, row[0] as String, row[1] as String, row[2] as? String, virtuals, deferred)
        // Every column is read (a row's digest covers all of them); the ones sent are those asked, or the first
        // MAX_STORAGE_COLUMNS.
        val names = info.columns.map { it.name }
        val asked = request.columns ?: info.wireColumns.map { it.name }
        if (asked.any { it !in names }) throw StorageAbort("invalid_identifier")
        // A rowid table's primary key may hold NULL, more than once (SQLite allows it outside INTEGER PRIMARY KEY and
        // WITHOUT ROWID): paging by the key alone would skip rows, so the rowid follows it as the last key. Paging
        // only: an edit still finds its row by primary key (a NULL key matches none).
        val nullableKey = info.pk.isNotEmpty() && !info.withoutRowid && info.columns.any { it.pk > 0 && !it.notNull }
        val alias = if (info.pagesByRowid || nullableKey) ROWID_ALIASES.firstOrNull { it !in names.map(String::lowercase) } else null
        val select = names.joinToString(", ") { quote(it) } + (alias?.let { ", $it" } ?: "")
        val keys = when {
            // No free rowid alias: by offset (the key alone could skip rows).
            nullableKey && alias == null -> emptyList()
            info.pk.isNotEmpty() -> info.pk.map(::quote) + listOfNotNull(alias)
            alias != null -> listOf(alias)
            else -> emptyList()
        }
        val args = ArrayList<Any?>()
        // A position of another paging kind (or key size) than the table has now (its schema changed): stale.
        val where = when (val position = request.position) {
            is StorageCursors.Position.AfterKeys -> {
                if (keys.isEmpty() || position.values.size != keys.size) throw StorageAbort("invalid_identifier")
                " WHERE " + keysetAfter(keys, position.values, args)
            }
            is StorageCursors.Position.AfterOffset -> {
                if (keys.isNotEmpty()) throw StorageAbort("invalid_identifier")
                ""
            }
            is StorageCursors.Position.Start -> ""
            is StorageCursors.Position.AfterKey -> throw StorageAbort("invalid_identifier")
        }
        val order = if (keys.isEmpty()) "" else " ORDER BY " + keys.joinToString(", ")
        val offset = (request.position as? StorageCursors.Position.AfterOffset)?.offset ?: 0
        val sql = "SELECT $select FROM ${quote(info.name)}$where$order LIMIT ${request.limit + 1}" +
            (if (keys.isEmpty() && offset > 0) " OFFSET $offset" else "")
        val result = conn.query(sql, args)
        budget.check()
        val pkIndexes = info.pk.map { names.indexOf(it) }
        return RawPage(
            table = info,
            columns = asked,
            indexes = asked.map { names.indexOf(it) },
            rows = result.rows.take(request.limit),
            keyIndexes = when {
                nullableKey && alias == null -> emptyList()
                info.pk.isNotEmpty() -> pkIndexes + listOfNotNull(alias?.let { names.size })
                alias != null -> listOf(names.size)
                else -> emptyList()
            },
            offset = offset,
            more = result.rows.size > request.limit,
        )
    }

    /** `k1 > ? OR (k1 = ? AND k2 > ?) OR …` (NULL sorts first: `> NULL` is `IS NOT NULL`, `= NULL` is `IS NULL`). */
    private fun keysetAfter(keys: List<String>, values: List<Any?>, args: MutableList<Any?>): String =
        keys.indices.joinToString(" OR ") { last ->
            (0..last).joinToString(" AND ", "(", ")") { i ->
                val value = values[i]
                when {
                    i < last && value == null -> "${keys[i]} IS NULL"
                    i < last -> {
                        args += value
                        "${keys[i]} = ?"
                    }
                    value == null -> "${keys[i]} IS NOT NULL"
                    else -> {
                        args += value
                        "${keys[i]} > ?"
                    }
                }
            }
        }

    /** The table [name] if its rows may be edited, else the matching `read_only:` / `not_found` abort. */
    private fun editableTable(conn: SqlConnection, name: String): TableInfo {
        requireImmediateKeys(conn)
        val master = conn.query("$MASTER_SQL AND name = ?", listOf(name))
        val row = master.rows.firstOrNull { it[1] == name } ?: throw StorageAbort("not_found")
        val virtuals = virtualNames(conn.query("$MASTER_SQL AND sql LIKE 'CREATE VIRTUAL TABLE%'"))
        val info = tableInfo(conn, row[0] as String, row[1] as String, row[2] as? String, virtuals, deferredFkTables(conn))
        info.readOnly?.let { throw StorageAbort(if (it.startsWith("unsupported:")) it else "read_only:$it") }
        return info
    }

    /**
     * The tables (lower-cased names) an edit of which could make the COMMIT fail on a `DEFERRABLE INITIALLY DEFERRED`
     * foreign key; empty when the schema declares none (one query). Such a key is checked at COMMIT only, and Android's
     * SQLiteSession takes its transaction off the stack before it runs COMMIT: a COMMIT that fails leaves the app's
     * connection inside the open transaction, back in the pool. So these tables are read-only
     * (`unsupported:deferred_fk`, in the schema before anyone tries): a table declaring a deferred key and every table
     * it references; every table with a trigger (its body may write to one of them); and, until nothing is added, a
     * parent whose ON DELETE / ON UPDATE action (CASCADE, SET NULL, SET DEFAULT) changes rows of one of them.
     * Immediate keys fail at their statement, rolled back as `constraint_failed`.
     */
    private fun deferredFkTables(conn: SqlConnection): Set<String> {
        val declaring = conn.query(DEFERRED_SQL).rows
            .filter { row -> (row[1] as? String)?.let(::declaresDeferredKey) == true }
            .mapNotNull { it[0] as? String }
        if (declaring.isEmpty()) return emptySet()
        class Edge(val child: String, val parent: String, val acting: Boolean)
        val edges = ArrayList<Edge>()
        for (row in conn.query(TABLE_NAMES_SQL).rows) {
            val table = row[0] as? String ?: continue
            for (key in conn.query("PRAGMA foreign_key_list(${quote(table)})").rows) {
                val parent = key[2] as? String ?: continue
                val acting = listOf(key.getOrNull(5), key.getOrNull(6)).any { (it as? String)?.uppercase() in ACTING_FK }
                edges += Edge(table.lowercase(), parent.lowercase(), acting)
            }
        }
        val unsafe = HashSet<String>()
        for (table in declaring.map(String::lowercase)) {
            unsafe += table
            edges.filter { it.child == table }.forEach { unsafe += it.parent }
        }
        conn.query(TRIGGER_TABLES_SQL).rows.mapNotNullTo(unsafe) { (it[0] as? String)?.lowercase() }
        do {
            val before = unsafe.size
            edges.filter { it.acting && it.child in unsafe }.forEach { unsafe += it.parent }
        } while (unsafe.size != before)
        return unsafe
    }

    /**
     * Refuses the edit (`unsupported:defer_foreign_keys`, nothing changed) unless `PRAGMA defer_foreign_keys` reads
     * exactly 0 in this transaction. An app that turns it on outside a transaction and leaves it on makes every key of
     * the next transaction on that connection (ours) deferred: invisible in the schema, and a COMMIT failing on one
     * leaves the app's connection inside the transaction, as a deferred key does. Anything else than 0 (on,
     * no row, not a number) is refused. The pragma is switched off by SQLite at the end of any transaction, ours too.
     */
    private fun requireImmediateKeys(conn: SqlConnection) {
        val value = conn.query(DEFER_FK_PRAGMA).rows.singleOrNull()?.singleOrNull()
        if (value !is Number || value.toLong() != 0L) throw StorageAbort(DEFER_FK_REFUSAL)
    }

    /** The row whose primary key cells are exactly [pk] (type and value), or null. */
    private fun rowByPk(conn: SqlConnection, info: TableInfo, pk: List<StorageValue>): List<Any?>? {
        if (pk.size != info.pk.size) throw StorageAbort("invalid_identifier")
        if (pk.any { it is StorageValue.Null }) return null
        val names = info.columns.map { it.name }
        val rows = conn.query(
            "SELECT ${names.joinToString(", ") { quote(it) }} FROM ${quote(info.name)} WHERE ${pkWhere(info)}",
            pk.map(StorageCut::bindable),
        ).rows
        val pkIndexes = info.pk.map { names.indexOf(it) }
        // SQL `=` converts by affinity ('3' finds 3): the key must match exactly.
        return rows.firstOrNull { row -> pkIndexes.withIndex().all { (i, column) -> StorageCut.exactCell(row[column]).same(pk[i]) } }
    }

    private fun pkWhere(info: TableInfo): String = info.pk.joinToString(" AND ") { "${quote(it)} = ?" }

    private fun totalChanges(conn: SqlConnection): Long =
        conn.query("SELECT total_changes()").rows.firstOrNull()?.get(0) as? Long ?: 0

    private fun tableInfo(
        conn: SqlConnection,
        type: String,
        name: String,
        sql: String?,
        virtuals: Set<String>,
        deferred: Set<String>,
    ): TableInfo {
        // All columns: a row's digest and compares cover each of them, sent or not (wireColumns).
        val columns = conn.query("PRAGMA table_info(${quote(name)})").rows.map { row ->
            ColumnInfo(
                name = row[1] as String,
                type = row[2] as? String ?: "",
                notNull = (row[3] as? Long ?: 0L) != 0L,
                pk = (row[5] as? Long ?: 0L).toInt(),
            )
        }
        val virtual = sql?.trimStart()?.startsWith("CREATE VIRTUAL TABLE", ignoreCase = true) == true ||
            virtuals.any { name.startsWith(it + "_") }
        val internal = name.startsWith("sqlite_", ignoreCase = true) || name in INTERNAL_TABLES
        // Read from the tokens (comments and separators don't hide it); the table options follow the last `)`.
        val withoutRowid = sql != null &&
            (sqlTokens(sql)?.substringAfterLast(')')?.contains("WITHOUT ROWID") ?: WITHOUT_ROWID.containsMatchIn(sql))
        val kind = when {
            type == "view" -> "view"
            internal -> "internal"
            virtual -> "virtual"
            else -> "table"
        }
        val readOnly = when {
            kind == "view" -> "view"
            kind == "internal" -> "internal"
            kind == "virtual" -> "virtual"
            columns.none { it.pk > 0 } -> "no_explicit_pk"
            // Wider than what is sent: a client can't see (nor name) every cell of a row.
            columns.size > MAX_STORAGE_COLUMNS -> "truncated"
            name.lowercase() in deferred -> "unsupported:deferred_fk"
            else -> null
        }
        return TableInfo(name, kind, withoutRowid, columns, readOnly)
    }

    private fun virtualNames(master: SqlRows): Set<String> = master.rows
        .filter { (it[2] as? String)?.trimStart()?.startsWith("CREATE VIRTUAL TABLE", ignoreCase = true) == true }
        .mapTo(HashSet()) { it[1] as String }

    /** Whether [value] may replace [current] in a column of declared [type]. */
    private fun fits(value: StorageValue, current: StorageValue, type: String): Boolean = when {
        value is StorageValue.Null -> true
        current !is StorageValue.Null -> value.wireType == current.wireType
        else -> value.wireType in affinityTypes(type)
    }

    /** The storage classes a NULL cell may take in a column of declared [type] (SQLite's affinity rules). */
    private fun affinityTypes(type: String): Set<String> {
        val upper = type.uppercase()
        return when {
            "INT" in upper -> setOf(StorageValue.INTEGER)
            "CHAR" in upper || "CLOB" in upper || "TEXT" in upper -> setOf("string")
            "BLOB" in upper || upper.isEmpty() -> setOf("blob", "string", StorageValue.INTEGER, StorageValue.REAL)
            "REAL" in upper || "FLOA" in upper || "DOUB" in upper -> setOf(StorageValue.REAL)
            else -> setOf(StorageValue.INTEGER, StorageValue.REAL)
        }
    }

    companion object {
        const val MASTER_SQL = "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view')"
        private val INTERNAL_TABLES = setOf("android_metadata", "room_master_table", "room_table_modification_log")
        private val WITHOUT_ROWID = Regex("\\)\\s*WITHOUT\\s+ROWID\\s*;?\\s*$", RegexOption.IGNORE_CASE)
        private val ROWID_ALIASES = listOf("rowid", "_rowid_", "oid")

        /**
         * A deferred foreign key clause (`NOT DEFERRABLE INITIALLY DEFERRED` is immediate), matched on DDL that
         * [sqlTokens] has stripped of comments and whitespace runs.
         */
        private val DEFERRED_FK = Regex("(?<!NOT )DEFERRABLE INITIALLY DEFERRED")

        private const val DEFER_FK_PRAGMA = "PRAGMA defer_foreign_keys"
        const val DEFER_FK_REFUSAL = "unsupported:defer_foreign_keys"

        /**
         * Whether [sql] (a `CREATE TABLE` from sqlite_master, kept there as written, comments included) declares a
         * deferred key. Fail-closed: DDL that can't be read token by token counts as declaring one, and so does DDL
         * with any character outside printable ASCII left outside quotes (only quoted text is emptied): no unusual
         * separator or look-alike can then hide the clause.
         */
        internal fun declaresDeferredKey(sql: String): Boolean {
            // A byte order mark is a separator only where a token starts (glued to a word it is part of that word):
            // left as is here, so it too counts as unusual.
            val tokens = sqlTokens(sql, bomIsSeparator = false) ?: return true
            if (tokens.any { it < ' ' || it > '~' }) return true
            return DEFERRED_FK.containsMatchIn(tokens)
        }

        /**
         * [sql] upper-cased with every comment (`-- …` to the end of the line, `/* … */`, unterminated running to the
         * end, as SQLite reads them) and every whitespace run turned into one space; a quoted string or identifier
         * ('…', "…", `…`, […]) becomes its empty quotes, so neither a comment marker nor a keyword inside one counts.
         * Null when a quote is not closed.
         */
        internal fun sqlTokens(sql: String, bomIsSeparator: Boolean = true): String? {
            val out = StringBuilder(sql.length)
            var space = false
            fun gap() { space = true }
            fun put(c: Char) {
                if (space && out.isNotEmpty()) out.append(' ')
                space = false
                out.append(c.uppercaseChar())
            }
            var i = 0
            while (i < sql.length) {
                val c = sql[i]
                when {
                    // SQLite's separators: these five, and a UTF-8 byte order mark where a token starts (CC_BOM);
                    // taken as one everywhere when [bomIsSeparator], which can only split words, never join them.
                    c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u000c' || (bomIsSeparator && c == '\uFEFF') -> { gap(); i++ }
                    c == '-' && sql.startsWith("--", i) -> {
                        val end = sql.indexOf('\n', i)
                        i = if (end < 0) sql.length else end + 1
                        gap()
                    }
                    c == '/' && sql.startsWith("/*", i) -> {
                        val end = sql.indexOf("*/", i + 2)
                        i = if (end < 0) sql.length else end + 2
                        gap()
                    }
                    c == '\'' || c == '"' || c == '`' || c == '[' -> {
                        val close = if (c == '[') ']' else c
                        var j = i + 1
                        while (true) {
                            if (j >= sql.length) return null
                            if (sql[j] == close) {
                                // '' "" `` escape their quote; ] has no escape.
                                if (close != ']' && j + 1 < sql.length && sql[j + 1] == close) { j += 2; continue }
                                break
                            }
                            j++
                        }
                        // Only the quotes stay: what a string or name holds is never a keyword.
                        put(c)
                        put(close)
                        i = j + 1
                    }
                    else -> { put(c); i++ }
                }
            }
            return out.toString()
        }
        // instr(upper(..)) and not LIKE: the app's connection may run with PRAGMA case_sensitive_like = ON, and a
        // hand-written lower-case `deferrable initially deferred` must not slip past the guard (fail-closed).
        private const val DEFERRED_SQL =
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND instr(upper(sql), 'DEFERRED') > 0"
        private const val TABLE_NAMES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table'"
        private const val TRIGGER_TABLES_SQL = "SELECT tbl_name FROM sqlite_master WHERE type = 'trigger'"

        /** Foreign key actions that change the child's rows when the parent's change. */
        private val ACTING_FK = setOf("CASCADE", "SET NULL", "SET DEFAULT")

        /** An identifier from the schema, double-quoted (inner quotes doubled). */
        fun quote(identifier: String): String = "\"" + identifier.replace("\"", "\"\"") + "\""
    }
}
