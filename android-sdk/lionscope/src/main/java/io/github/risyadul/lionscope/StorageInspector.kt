package io.github.risyadul.lionscope

import android.content.SharedPreferences
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The storage inspector's work on the storage worker thread (`lionscope-storage`): answers one parsed request with the
 * line(s) to send. Prefs through [prefs] (the app's own instances of the files it lists), databases through [databases]
 * ([DbInspector]: the app's own instance and transaction). Everything sent is cut ([StorageCut]) and redacted
 * ([StorageRedaction]) and every answer stays under [maxReplyBytes]. Never throws: a failure is answered `failed`.
 */
internal class StorageInspector(
    private val prefs: PrefsAccess,
    private val databases: DatabaseRegistry,
    private val commits: CommitRunner = CommitRunner(),
    private val db: DbInspector = DbInspector(),
    private val maxReplyBytes: Int = MAX_STORAGE_REPLY_BYTES,
    private val cursors: StorageCursors = StorageCursors(),
) {
    /** Forgets every cursor (the link connection changed: tokens of the last one mean nothing now). */
    fun resetCursors() = cursors.clear()

    /** Never throws, as read: an unexpected failure is answered `failed`, not left to time out. */
    fun list(requestId: Int): String = guarded(requestId, "storageListResult") { listing(requestId) }

    private fun listing(requestId: Int): String {
        val files = try {
            StorageTestHooks.touched()
            prefs.listFiles()
        } catch (e: RuntimeException) {
            emptyList()
        }
        // Measured in bytes as sent: names that need escaping can make a listing of allowed counts larger than the cap.
        // The databases (at most MAX_STORAGE_DATABASES, names up to MAX_STORAGE_NAME_CHARS) always go whole; prefs
        // files are added while they fit, `prefsTruncated` when one did not (or there were more than the limit).
        val dbs = databases.all().map { (name, database) ->
            JsonWriter().beginObject().name("name").value(name).name("status").value(database.status()).endObject().toString()
        }
        // The shell is measured with its longer flag (`false`): what is admitted fits whichever the answer carries.
        val shell = utf8Bytes(listLine(requestId, "ok", emptyList(), false, dbs))
        if (shell > maxReplyBytes) return listLine(requestId, "invalid_value:too_large", emptyList(), true, emptyList())
        var bytes = shell
        val entries = ArrayList<String>()
        var cut = files.size > MAX_STORAGE_PREFS_FILES
        for (file in files.take(MAX_STORAGE_PREFS_FILES)) {
            val text = JsonWriter().beginObject().name("name").value(file.name).name("backupOnly").value(file.backupOnly)
                .endObject().toString()
            val size = utf8Bytes(text) + (if (entries.isEmpty()) 0 else 1)
            if (bytes + size > maxReplyBytes) {
                cut = true
                break
            }
            bytes += size
            entries += text
        }
        val line = listLine(requestId, "ok", entries, cut, dbs)
        check(utf8Bytes(line) <= maxReplyBytes) { "storage answer over its cap" }
        return line
    }

    private fun listLine(requestId: Int, code: String, prefs: List<String>, truncated: Boolean, dbs: List<String>): String {
        val json = JsonWriter().beginObject()
            .name("type").value("storageListResult")
            .name("requestId").value(requestId)
            .name("code").value(code)
            .name("prefs").beginArray()
        prefs.forEach { json.rawValue(it) }
        json.endArray().name("prefsTruncated").value(truncated).name("databases").beginArray()
        dbs.forEach { json.rawValue(it) }
        return json.endArray().endObject().toString()
    }

    fun read(message: GatewayMessage.StorageRead): String = guarded(message.requestId, "storageReadResult") {
        when (message.store) {
            "prefs" -> readPrefs(message)
            else -> readDb(message)
        }
    }

    /**
     * Runs one write and hands its answer(s) to [send]: one `final`, or for prefs whose commit outlasts
     * [STORAGE_COMMIT_BUDGET_MS] a `provisional` first and the `final` (from the commit thread) when it is done.
     */
    fun write(message: GatewayMessage.StorageWrite, send: (String) -> Unit) {
        val answer = try {
            if (message.store == "prefs") writePrefs(message, send) else writeDb(message)
        } catch (abort: StorageAbort) {
            WriteAnswer(abort.code, current = abort.current)
        } catch (t: Throwable) {
            if (isFatal(t)) throw t
            WriteAnswer("failed")
        }
        answer?.let { send(writeLine(message, "final", it)) }
    }

    // --- prefs -------------------------------------------------------------------------------------------------

    /** The app's instance of [name], only for a name in the listing (`getSharedPreferences` of another would stay cached). */
    private fun openListed(name: String): SharedPreferences {
        StorageTestHooks.touched()
        if (prefs.listFiles().none { it.name == name }) throw StorageAbort("not_found")
        return prefs.open(name)
    }

    /**
     * A page of a prefs file's keys, sorted by code unit, after the cursor's key. Every entry fits an answer on its
     * own (a key is cut at [MAX_STORAGE_KEY_UNITS], a value at [MAX_STORAGE_VALUE_UNITS], a set in total), so each
     * page that has keys left carries at least one: paging always moves on. The answer's size is measured exactly.
     */
    private fun readPrefs(message: GatewayMessage.StorageRead): String {
        val scope = StorageCursors.prefsScope(message.name)
        val after = when (val cursor = message.cursor) {
            null -> null
            else -> (cursors.get(cursor, scope) as? StorageCursors.Position.AfterKey)?.key
                ?: throw StorageAbort("invalid_identifier")
        }
        val all = openListed(message.name).all
        if (all.keys.any { it.startsWith(ENCRYPTED_KEY_PREFIX) }) throw StorageAbort("unsupported:encrypted")
        val limit = (message.limit ?: DEFAULT_STORAGE_KEYS).coerceIn(1, MAX_STORAGE_KEYS)
        val keys = all.keys.sorted().filter { after == null || it > after }
        val shell = utf8Bytes(prefsLine(message.requestId, emptyList(), TOKEN_PLACEHOLDER, truncated = false))
        val entries = ArrayList<String>()
        var bytes = shell
        var last: String? = null
        var consumed = 0
        var cut = false
        for (key in keys.take(limit)) {
            val value = StorageCut.prefs(all[key])
            if (value == null) {
                // Not a SharedPreferences type (getAll never has one): passed over, paging still moves on.
                consumed++
                last = key
                continue
            }
            val entry = JsonWriter().beginObject().name("key").value(StorageCut.prefix(key, MAX_STORAGE_KEY_UNITS))
            if (key.length > MAX_STORAGE_KEY_UNITS) entry.name("keyLength").value(key.length.toLong())
            entry.name("value")
            StorageCodec.write(entry, StorageRedaction.redact(key, value))
            val text = entry.endObject().toString()
            val size = utf8Bytes(text) + (if (entries.isEmpty()) 0 else 1)
            if (bytes + size > maxReplyBytes) {
                cut = true
                break
            }
            bytes += size
            entries += text
            consumed++
            last = key
        }
        // Unreachable with the real cap (one entry is far below it); never a page that can't move on.
        if (cut && entries.isEmpty()) throw StorageAbort("invalid_value:too_large")
        val more = keys.size > consumed
        val next = if (more && last != null) cursors.put(scope, StorageCursors.Position.AfterKey(last)) else null
        val line = prefsLine(message.requestId, entries, next, cut)
        check(utf8Bytes(line) <= maxReplyBytes) { "storage answer over its cap" }
        return line
    }

    private fun prefsLine(requestId: Int, entries: List<String>, next: String?, truncated: Boolean): String {
        val json = JsonWriter().beginObject()
            .name("type").value("storageReadResult")
            .name("requestId").value(requestId)
            .name("code").value("ok")
            .name("entries").beginArray()
        for (entry in entries) json.rawValue(entry)
        json.endArray().name("nextCursor")
        if (next != null) json.value(next) else json.nullValue()
        return json.name("truncated").value(truncated).endObject().toString()
    }

    private fun writePrefs(message: GatewayMessage.StorageWrite, send: (String) -> Unit): WriteAnswer? {
        val key = message.key ?: throw StorageAbort("invalid_identifier")
        val instance = openListed(message.name)
        val all = instance.all
        if (all.keys.any { it.startsWith(ENCRYPTED_KEY_PREFIX) }) throw StorageAbort("unsupported:encrypted")
        val expected = decodeValue(message.expected) ?: throw StorageAbort("invalid_value")
        if (expected.wireType !in StorageValue.PREFS_TYPES) throw StorageAbort("type_mismatch")
        if (StorageRedaction.isSensitiveName(key)) throw StorageAbort("read_only:redacted")
        val raw = all[key]
        val current = if (all.containsKey(key)) StorageCut.prefs(raw) ?: throw StorageAbort("failed") else null
        if (current != null && StorageRedaction.hides(key, current)) throw StorageAbort("read_only:redacted")
        if (current != null && !current.complete) throw StorageAbort("read_only:truncated")
        val editor = instance.edit()
        val written: StorageValue?
        if (message.op == "remove") {
            if (current == null) throw StorageAbort("already_applied_or_concurrent")
            if (!current.same(expected)) throw StorageAbort("conflict", current)
            editor.remove(key)
            written = null
        } else {
            val value = decodeValue(message.value) ?: throw StorageAbort("invalid_value")
            if (value.wireType !in StorageValue.PREFS_TYPES) throw StorageAbort("type_mismatch")
            // Prefs keep one NaN: Float.equals compares canonical bits (another payload would be a silent no-op).
            if (value is StorageValue.Real && value.isNaN && value.bits != CANONICAL_FLOAT_NAN_BITS) {
                throw StorageAbort("invalid_value:nan_payload")
            }
            // The app keeps a lone surrogate in memory, but Android's XML serializer writes it to the file as '?':
            // after a restart the app would read another value (API 28). Refused like a database TEXT, before any edit.
            val lone = when (value) {
                is StorageValue.Text -> value.hasLoneSurrogate
                is StorageValue.StringSet -> value.values.any { StorageValue.hasLoneSurrogate(it) }
                else -> false
            }
            if (lone) throw StorageAbort("invalid_value:lone_surrogate")
            // Adding a key is v1.1: an update names a key that exists.
            if (current == null) throw StorageAbort("not_found")
            if (value.wireType != current.wireType) throw StorageAbort("type_mismatch")
            if (!current.same(expected)) {
                throw StorageAbort(if (current.same(value)) "already_applied_or_concurrent" else "conflict", current)
            }
            put(editor, key, value)
            written = value
        }
        val outcome = commits.commit(
            commit = {
                StorageTestHooks.touched()
                val persisted = editor.commit()
                // A slow disk: commit() applies to memory first and returns when the file is written.
                val delay = StorageTestHooks.commitDelayMs
                if (delay > 0) Thread.sleep(delay)
                persisted
            },
            budgetMs = STORAGE_COMMIT_BUDGET_MS,
        )
        val answer = prefsAnswer(instance, key, written, outcome.persisted, outcome.waitedMs)
        if (outcome.persisted != null) return answer
        send(writeLine(message, "provisional", answer))
        // Only now is the final one let out (from the commit thread, or here if the commit is done already): the
        // provisional answer always goes first, and the final one is the last word.
        outcome.whenDone { persisted, waitedMs ->
            val final = try {
                prefsAnswer(instance, key, written, persisted, waitedMs)
            } catch (t: Throwable) {
                if (isFatal(t)) throw t
                WriteAnswer("failed", prefs = true)
            }
            send(writeLine(message, "final", final))
        }
        return null
    }

    /** The answer of a prefs write: what memory holds now, [persisted] (null: still running). */
    private fun prefsAnswer(
        instance: SharedPreferences,
        key: String,
        written: StorageValue?,
        persisted: Boolean?,
        waitedMs: Long,
    ): WriteAnswer {
        StorageTestHooks.touched()
        val now = instance.all
        val present = now.containsKey(key)
        // Compared whole (another writer may have put a value too large to send there); sent cut (writeLine).
        val exact = if (present) StorageCut.exactPrefs(now[key]) else null
        val stored = if (present) StorageCut.prefs(now[key]) else null
        val applied = if (written == null) !present else exact != null && exact.same(written)
        return WriteAnswer(
            code = if (applied) "ok" else "concurrent_after_write",
            stored = if (written == null) null else stored,
            memory = if (applied) "applied" else "not_applied",
            persisted = persisted,
            observers = "posted_unverified",
            txMs = waitedMs,
            prefs = true,
        )
    }

    private fun put(editor: SharedPreferences.Editor, key: String, value: StorageValue) {
        when (value) {
            is StorageValue.Text -> editor.putString(key, value.value)
            is StorageValue.Integer -> if (value.wireType == StorageValue.INT) editor.putInt(key, value.value.toInt()) else editor.putLong(key, value.value)
            is StorageValue.Real -> editor.putFloat(key, java.lang.Float.intBitsToFloat(value.bits.toInt()))
            is StorageValue.Bool -> editor.putBoolean(key, value.value)
            is StorageValue.StringSet -> editor.putStringSet(key, LinkedHashSet(value.values))
            else -> throw StorageAbort("type_mismatch")
        }
    }

    // --- databases ---------------------------------------------------------------------------------------------

    private fun database(name: String): TrackedDatabase {
        val database = databases.get(name) ?: throw StorageAbort("not_found")
        val status = database.status()
        if (status != "ok") throw StorageAbort(status)
        return database
    }

    private fun readDb(message: GatewayMessage.StorageRead): String {
        val database = database(message.name)
        val pagesText = message.pages ?: return schemaLine(message.requestId, db.schema(database))
        val requests = parsePages(message.name, pagesText)
        val timed = db.pages(database, requests)
        // Measured exactly: the envelope (its txMs is known by now), then each page's shell and rows.
        var left = maxReplyBytes - utf8Bytes(pagesLine(message.requestId, emptyList(), timed.txMs))
        val pages = ArrayList<String>()
        timed.value.forEachIndexed { index, page ->
            val separator = if (index == 0) 0 else 1
            val text = pageJson(message.name, page, requests[index].position, left - separator, fresh = index == 0)
            pages += text
            left -= utf8Bytes(text) + separator
        }
        val line = pagesLine(message.requestId, pages, timed.txMs)
        check(utf8Bytes(line) <= maxReplyBytes) { "storage answer over its cap" }
        return line
    }

    private fun pagesLine(requestId: Int, pages: List<String>, txMs: Long): String {
        val json = JsonWriter().beginObject()
            .name("type").value("storageReadResult")
            .name("requestId").value(requestId)
            .name("code").value("ok")
            .name("pages").beginArray()
        for (page in pages) json.rawValue(page)
        return json.endArray().name("txMs").value(txMs).endObject().toString()
    }

    /** The page requests of `storageRead.pages`, each cursor resolved (a token of this database's table, or none). */
    private fun parsePages(database: String, text: String): List<PageRequest> {
        val list = StrictJson.parse(text) as? List<*> ?: throw StorageAbort("invalid_value")
        if (list.isEmpty() || list.size > MAX_STORAGE_PAGES) throw StorageAbort("invalid_value")
        return list.map { item ->
            val page = item as? Map<*, *> ?: throw StorageAbort("invalid_value")
            if (!page.keys.all { it in PAGE_KEYS }) throw StorageAbort("invalid_value")
            val table = page["table"] as? String ?: throw StorageAbort("invalid_value")
            val columns = page["columns"]?.let { columns ->
                (columns as? List<*>)?.map { it as? String ?: throw StorageAbort("invalid_value") }
                    ?.takeIf { it.isNotEmpty() && it.size <= MAX_STORAGE_COLUMNS } ?: throw StorageAbort("invalid_value")
            }
            val position = when (val raw = page["cursor"]) {
                null, StrictJson.NULL -> StorageCursors.Position.Start
                is String -> cursors.get(raw, StorageCursors.tableScope(database, table))
                    ?: throw StorageAbort("invalid_identifier")
                else -> throw StorageAbort("invalid_value")
            }
            val limit = when (val raw = page["limit"]) {
                null -> DEFAULT_STORAGE_ROWS
                is StrictJson.Number -> raw.literal.toIntOrNull()?.takeIf { it in 1..MAX_STORAGE_ROWS } ?: throw StorageAbort("invalid_value")
                else -> throw StorageAbort("invalid_value")
            }
            PageRequest(table, columns, position, limit)
        }
    }

    /**
     * One page's JSON within [budget] bytes (its shell, rows, cursor token and flags, measured exactly). Rows past the
     * budget are left for the next page (`truncated`, the cursor continues after the last row sent). A row too large
     * for any answer is sent with its strings / blobs cut further (read-only), so paging always moves on; a page with
     * no room left in this answer ([fresh] false) sends no row and a cursor that reads it again from where it started.
     * Values of views and virtual tables are hidden: the table column they come from is not known, so redaction by
     * column name can't be applied to them (`AS value`, expressions).
     */
    private fun pageJson(database: String, page: RawPage, start: StorageCursors.Position, budget: Int, fresh: Boolean): String {
        // `false` is the longer of the two flags: the shell is measured with it.
        val shell = utf8Bytes(pageText(page, emptyList(), TOKEN_PLACEHOLDER, truncated = false))
        if (shell > budget) throw StorageAbort("invalid_value:too_large")
        val hidden = page.table.kind in PROVENANCE_UNKNOWN
        val rows = ArrayList<String>()
        var bytes = shell
        var cut = false
        for (row in 0 until page.size) {
            val cells = page.cells(row).mapIndexed { index, raw ->
                val value = StorageCut.cell(raw)
                when {
                    hidden && value !is StorageValue.Null -> StorageValue.Redacted(value.wireType)
                    else -> StorageRedaction.redact(page.columns[index], value)
                }
            }
            val digest = page.digest(row)
            val separator = if (rows.isEmpty()) 0 else 1
            val text = rowText(cells, digest)
            if (bytes + separator + utf8Bytes(text) <= budget) {
                bytes += separator + utf8Bytes(text)
                rows += text
                continue
            }
            cut = true
            // Only a row too large for a whole answer is cut further; a later page of this one is read again instead.
            if (rows.isEmpty() && fresh) squeezed(cells, digest, budget - bytes)?.let { rows += it }
            break
        }
        if (fresh && cut && rows.isEmpty()) throw StorageAbort("invalid_value:too_large")
        val next = when {
            rows.isNotEmpty() && (rows.size < page.size || page.more) -> page.positionAfter(rows.size - 1)
            rows.isEmpty() && cut -> start
            else -> null
        }
        val token = next?.let { cursors.put(StorageCursors.tableScope(database, page.table.name), it) }
        return pageText(page, rows, token, cut)
    }

    private fun rowText(cells: List<StorageValue>, digest: String?): String {
        val json = JsonWriter().beginObject().name("cells").beginArray()
        for (cell in cells) StorageCodec.write(json, cell)
        return json.endArray().name("digest").value(digest).endObject().toString()
    }

    /**
     * The row with its strings and blobs cut to as many units as fit [room] bytes (6 bytes per unit at worst, an
     * escaped code unit), redaction previews left out; null when not even that fits.
     */
    private fun squeezed(cells: List<StorageValue>, digest: String?, room: Int): String? {
        val plain = cells.map { if (it is StorageValue.Redacted) StorageValue.Redacted(it.orig) else it }
        val cuttable = plain.count { it is StorageValue.Text || it is StorageValue.Blob }
        if (cuttable == 0) return null
        val base = utf8Bytes(rowText(plain.map { StorageCut.squeeze(it, 0) }, digest))
        var units = (room - base - cuttable * 8) / (cuttable * 6)
        while (units >= 0) {
            val text = rowText(plain.map { StorageCut.squeeze(it, units) }, digest)
            if (utf8Bytes(text) <= room) return text
            units = if (units == 0) -1 else units / 2
        }
        return null
    }

    private fun pageText(page: RawPage, rows: List<String>, next: String?, truncated: Boolean): String {
        val json = JsonWriter().beginObject()
            .name("table").value(page.table.name)
            .name("columns").beginArray()
        for (column in page.columns) json.value(column)
        json.endArray().name("pk").beginArray()
        for (key in page.table.pk) json.value(key)
        json.endArray().name("readOnly").value(page.table.readOnly).name("rows").beginArray()
        for (row in rows) json.rawValue(row)
        json.endArray().name("nextCursor").value(next)
        return json.name("truncated").value(truncated).endObject().toString()
    }

    private fun schemaLine(requestId: Int, timed: DbInspector.Timed<Pair<List<TableInfo>, Boolean>>): String {
        val (tables, more) = timed.value
        var bytes = utf8Bytes(schemaText(requestId, emptyList(), truncated = false, timed.txMs))
        var cut = more
        val entries = ArrayList<String>()
        for (table in tables) {
            val entry = JsonWriter().beginObject()
                .name("name").value(table.name)
                .name("kind").value(table.kind)
                .name("withoutRowid").value(table.withoutRowid)
                .name("columns").beginArray()
            // At most MAX_STORAGE_COLUMNS (a wider table is read-only `truncated`).
            for (column in table.wireColumns) {
                entry.beginObject().name("name").value(column.name).name("type").value(column.type)
                    .name("notNull").value(column.notNull).name("pk").value(column.pk).endObject()
            }
            entry.endArray().name("pk").beginArray()
            for (key in table.pk) entry.value(key)
            val text = entry.endArray().name("readOnly").value(table.readOnly).endObject().toString()
            val size = utf8Bytes(text) + (if (entries.isEmpty()) 0 else 1)
            if (bytes + size > maxReplyBytes) {
                cut = true
                break
            }
            bytes += size
            entries += text
        }
        val line = schemaText(requestId, entries, cut, timed.txMs)
        check(utf8Bytes(line) <= maxReplyBytes) { "storage answer over its cap" }
        return line
    }

    private fun schemaText(requestId: Int, tables: List<String>, truncated: Boolean, txMs: Long): String {
        val json = JsonWriter().beginObject()
            .name("type").value("storageReadResult")
            .name("requestId").value(requestId)
            .name("code").value("ok")
            .name("tables").beginArray()
        for (table in tables) json.rawValue(table)
        return json.endArray().name("tablesTruncated").value(truncated).name("txMs").value(txMs).endObject().toString()
    }

    private fun writeDb(message: GatewayMessage.StorageWrite): WriteAnswer {
        val table = message.table ?: throw StorageAbort("invalid_identifier")
        val pk = message.pk?.let { StorageCodec.decodeList(StrictJson.parse(it), MAX_STORAGE_COLUMNS) }
            ?: throw StorageAbort("invalid_value")
        if (pk.any { it.wireType !in StorageValue.SQLITE_TYPES }) throw StorageAbort("type_mismatch")
        val database = database(message.name)
        // A constraint refusing the UPDATE / DELETE (NOT NULL, UNIQUE, CHECK, an immediate foreign key), at the
        // statement or at COMMIT: the transaction is rolled back, nothing changed.
        val timed = try {
            if (message.op == "delete") {
                val digest = message.rowDigest?.takeIf { DIGEST.matches(it) } ?: throw StorageAbort("invalid_value")
                db.delete(database, table, pk, digest)
            } else {
                val column = message.column ?: throw StorageAbort("invalid_identifier")
                val expected = decodeValue(message.expected) ?: throw StorageAbort("invalid_value")
                val value = decodeValue(message.value) ?: throw StorageAbort("invalid_value")
                if (expected.wireType !in StorageValue.SQLITE_TYPES || value.wireType !in StorageValue.SQLITE_TYPES) {
                    throw StorageAbort("type_mismatch")
                }
                // SQLite would store NaN as NULL (or refuse it in a NOT NULL column): refused before any SQL.
                if (value is StorageValue.Real && value.isNaN) throw StorageAbort("invalid_value:nan_not_storable")
                // Android's SQLite binding turns UTF-16 into UTF-8: a lone surrogate swallows the code unit after it
                // (API 28: U+D800 then a space is stored as the pair D800 DC20), so TEXT with one is refused before any SQL.
                if (value is StorageValue.Text && value.hasLoneSurrogate) throw StorageAbort("invalid_value:lone_surrogate")
                if (StorageRedaction.isSensitiveName(column)) throw StorageAbort("read_only:redacted")
                db.update(database, table, column, pk, expected, value)
            }
        } catch (e: SqlConstraintException) {
            throw StorageAbort("constraint_failed")
        }
        val outcome = timed.value
        return WriteAnswer(
            code = outcome.code,
            stored = outcome.stored,
            normalized = outcome.normalized,
            observers = "room_invalidation",
            changes = outcome.changes,
            totalChangesDelta = outcome.totalChangesDelta,
            txMs = timed.txMs,
            field = message.column ?: "",
        )
    }

    // --- answers -----------------------------------------------------------------------------------------------

    class WriteAnswer(
        val code: String,
        val current: StorageValue? = null,
        val stored: StorageValue? = null,
        val normalized: Boolean? = null,
        val memory: String? = null,
        /** Prefs: true / false, null = still running (`timeout`). */
        val persisted: Boolean? = null,
        val observers: String? = null,
        val changes: Int? = null,
        val totalChangesDelta: Long? = null,
        val txMs: Long? = null,
        val prefs: Boolean = false,
        val field: String = "",
    )

    /**
     * A write's answer line, under [maxReplyBytes] like every answer: `current` / `stored` come back whole from the
     * app (a trigger or another writer can have made them as large as anything it stores), so they are cut to
     * [MAX_STORAGE_VALUE_UNITS] first (`complete` false: read-only, never an undo's `expected`) and then redacted; in
     * the (only theoretical, with the real caps) case that is still too large, cut further. What happened is still
     * reported as it happened: the code, `changes` and the flags are never changed to make room.
     */
    private fun writeLine(message: GatewayMessage.StorageWrite, phase: String, answer: WriteAnswer): String {
        var units = MAX_STORAGE_VALUE_UNITS
        while (true) {
            val line = writeText(message, phase, answer) { StorageCut.squeeze(StorageCut.forWire(it), units) }
            if (utf8Bytes(line) <= maxReplyBytes || units == 0) return line
            units /= 2
        }
    }

    private fun writeText(
        message: GatewayMessage.StorageWrite,
        phase: String,
        answer: WriteAnswer,
        cut: (StorageValue) -> StorageValue,
    ): String {
        val field = message.key ?: message.column ?: answer.field
        val json = JsonWriter().beginObject()
            .name("type").value("storageWriteResult")
            .name("requestId").value(message.requestId)
            .name("opId").value(message.opId)
            .name("phase").value(phase)
            .name("code").value(answer.code)
        answer.current?.let { StorageCodec.write(json.name("current"), StorageRedaction.redact(field, cut(it))) }
        answer.stored?.let { StorageCodec.write(json.name("stored"), StorageRedaction.redact(field, cut(it))) }
        answer.normalized?.let { json.name("normalized").value(it) }
        answer.memory?.let { json.name("memory").value(it) }
        if (answer.prefs && answer.code != "failed") {
            json.name("persisted")
            when (answer.persisted) {
                null -> json.value("timeout")
                else -> json.value(answer.persisted)
            }
        }
        answer.observers?.let { if (answer.code == "ok" || answer.code == "concurrent_after_write") json.name("observers").value(it) }
        answer.changes?.let { json.name("changes").value(it) }
        answer.totalChangesDelta?.let { json.name("totalChangesDelta").value(it) }
        answer.txMs?.let { json.name("txMs").value(it) }
        return json.endObject().toString()
    }

    private fun guarded(requestId: Int, type: String, block: () -> String): String = try {
        block()
    } catch (abort: StorageAbort) {
        codeLine(requestId, type, abort.code)
    } catch (t: Throwable) {
        if (isFatal(t)) throw t
        codeLine(requestId, type, "failed")
    }

    private fun decodeValue(text: String?): StorageValue? = text?.let { StorageCodec.decode(StrictJson.parse(it)) }

    companion object {
        /** EncryptedSharedPreferences keeps its keysets under keys starting so (`unsupported:encrypted`). */
        const val ENCRYPTED_KEY_PREFIX = "__androidx_security_crypto_encrypted_prefs_"
        /** A cursor token's length, for measuring an answer before its token exists. */
        private val TOKEN_PLACEHOLDER = StorageCursors.TOKEN_PREFIX + "0".repeat(StorageCursors.TOKEN_CHARS - 3)

        /** Tables whose values can't be traced to a table column (redaction by column name doesn't hold). */
        private val PROVENANCE_UNKNOWN = setOf("view", "virtual")
        private val PAGE_KEYS = setOf("table", "columns", "cursor", "limit")
        private val DIGEST = Regex("[0-9a-f]{64}")

        /** An answer that is only a code (a refusal of the whole request), for any of the three result types. */
        fun codeLine(requestId: Int, type: String, code: String): String {
            val json = JsonWriter().beginObject().name("type").value(type).name("requestId").value(requestId).name("code").value(code)
            if (type == "storageListResult") {
                json.name("prefs").beginArray().endArray().name("prefsTruncated").value(false)
                    .name("databases").beginArray().endArray()
            }
            return json.endObject().toString()
        }

        /** A write refused before it ran (still one `final` answer, with its opId). */
        fun writeRefusal(requestId: Int, opId: String, code: String): String = JsonWriter().beginObject()
            .name("type").value("storageWriteResult")
            .name("requestId").value(requestId)
            .name("opId").value(opId)
            .name("phase").value("final")
            .name("code").value(code)
            .endObject().toString()
    }
}

/**
 * Runs prefs `commit()`s on their own thread (`lionscope-storage-commit`, never the main thread) so the storage worker
 * can stop waiting after a budget: [commit] then returns `persisted` null, and [Outcome.whenDone] hands over the
 * outcome once the commit is done, never before it is called. So the worker sends its provisional answer first and
 * only then lets the final one out: from the commit thread when it finishes later, or at once on the worker's thread
 * when it finished in between. Exactly once either way.
 */
internal class CommitRunner(
    private val start: (Runnable) -> Unit = { task -> spawn(task) },
    private val nanoTime: () -> Long = System::nanoTime,
) {
    class Outcome internal constructor(
        /** true / false, or null: still running when the budget ran out. */
        val persisted: Boolean?,
        val waitedMs: Long,
        private val late: ((persisted: Boolean, waitedMs: Long) -> Unit) -> Unit,
    ) {
        /** For a commit still running ([persisted] null): [then] runs once with its outcome (see the class comment). */
        fun whenDone(then: (persisted: Boolean, waitedMs: Long) -> Unit) = late(then)
    }

    fun commit(commit: () -> Boolean, budgetMs: Long): Outcome {
        val lock = ReentrantLock()
        val done = lock.newCondition()
        var result: Boolean? = null
        var finishedMs = 0L
        var gaveUp = false
        var then: ((Boolean, Long) -> Unit)? = null
        var registered = false
        val started = nanoTime()
        start(Runnable {
            val ok = try {
                commit()
            } catch (t: Throwable) {
                if (isFatal(t)) throw t
                false
            }
            val ms = (nanoTime() - started) / 1_000_000
            // Handed over here only if the worker gave up and is already waiting for it; else whenDone runs it.
            val waiting = lock.withLock {
                result = ok
                finishedMs = ms
                done.signalAll()
                if (gaveUp) then.also { then = null } else null
            }
            waiting?.invoke(ok, ms)
        })
        return lock.withLock {
            var left = TimeUnit.MILLISECONDS.toNanos(budgetMs)
            while (result == null && left > 0) left = done.awaitNanos(left)
            val outcome = result
            if (outcome == null) gaveUp = true
            Outcome(outcome, (nanoTime() - started) / 1_000_000) { callback ->
                val finished = lock.withLock {
                    check(gaveUp && !registered) { "whenDone is for a commit still running, once" }
                    registered = true
                    val now = result
                    if (now == null) {
                        then = callback
                        null
                    } else {
                        now to finishedMs
                    }
                }
                finished?.let { (persisted, ms) -> callback(persisted, ms) }
            }
        }
    }

    private companion object {
        fun spawn(task: Runnable) {
            val thread = Thread({
                try {
                    task.run()
                } catch (t: Throwable) {
                    // Never into the app's uncaught-exception handler.
                }
            }, "lionscope-storage-commit")
            thread.isDaemon = true
            thread.start()
        }
    }
}
