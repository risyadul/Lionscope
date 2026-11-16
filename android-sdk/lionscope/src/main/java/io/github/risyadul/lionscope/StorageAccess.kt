package io.github.risyadul.lionscope

import android.content.SharedPreferences

/** One file of `shared_prefs/`: its name without `.xml`, and whether only `<name>.xml.bak` is there. */
internal class PrefsFile(val name: String, val backupOnly: Boolean)

/**
 * How the storage inspector reaches the app's SharedPreferences: the file listing (discovery) and the app's own
 * instance of a listed name (`Context.getSharedPreferences`, the one every Activity of the process gets).
 */
internal interface PrefsAccess {
    /** Names in `shared_prefs/`, sorted; empty without the directory. */
    fun listFiles(): List<PrefsFile>

    /** The app's instance of [name]; only called for a name [listFiles] returned. */
    fun open(name: String): SharedPreferences
}

/** Rows of a query: raw cells by storage class (Long, Double, String, ByteArray or null), in column order. */
internal class SqlRows(val columns: List<String>, val rows: List<List<Any?>>)

/** A constraint (NOT NULL, UNIQUE, CHECK, foreign key) refused a statement. */
internal class SqlConstraintException(message: String?) : RuntimeException(message)

/**
 * The app's own database connection while the storage inspector holds a transaction of it ([TrackedDatabase.inTransaction]).
 * Row-editor statements use schema-checked identifiers and bound values. The v13 console additionally executes
 * one validated SELECT or DML statement, with target-table restrictions and bounded result collection.
 * Arguments are Long, Double, String, ByteArray or null.
 */
internal interface SqlConnection {
    fun query(sql: String, args: List<Any?> = emptyList()): SqlRows

    fun queryConsole(sql: String, limit: Int): ConsoleRows {
        val result = query(sql)
        val rows = result.rows.iterator()
        return consoleRows(result.columns, limit) { if (rows.hasNext()) rows.next() else null }
    }

    /** Rows changed; throws [SqlConstraintException] when a constraint refuses it. */
    fun updateDelete(sql: String, args: List<Any?>): Int
}

internal class ConsoleRows(val columns: List<String>, val rows: List<List<StorageValue>>, val hasMore: Boolean, val truncated: Boolean)

/** Bounds retained cells while the cursor is consumed, rather than materializing the entire result first. */
internal fun consoleRows(columns: List<String>, limit: Int, next: () -> List<Any?>?): ConsoleRows {
    val names = columns.take(MAX_STORAGE_COLUMNS).map { it.take(128) }
    val namesJson = JsonWriter().beginArray()
    names.forEach { namesJson.value(it) }
    val rowBudget = minOf(160 * 1024, MAX_STORAGE_REPLY_BYTES - utf8Bytes(namesJson.endArray().toString()) - 4096)
    val rows = ArrayList<List<StorageValue>>()
    var bytes = 0
    var truncated = columns.size > names.size || columns.any { it.length > 128 }
    while (true) {
        val raw = next() ?: return ConsoleRows(names, rows, false, truncated)
        if (rows.size == limit) return ConsoleRows(names, rows, true, truncated)
        var units = 1024
        var cells: List<StorageValue>
        var size: Int
        do {
            cells = raw.take(names.size).map { StorageCut.squeeze(StorageCut.cell(it), units) }
            val json = JsonWriter().beginArray()
            cells.forEach { StorageCodec.write(json, it) }
            size = utf8Bytes(json.endArray().toString())
            units /= 2
        } while (size > minOf(64 * 1024, rowBudget) && units > 0)
        if (bytes + size > rowBudget) return ConsoleRows(names, rows, true, true)
        truncated = truncated || cells.any { when (it) { is StorageValue.Text -> !it.complete; is StorageValue.Blob -> !it.complete; else -> false } }
        rows += cells
        bytes += size
    }
}

/**
 * A database the app registered: only ever reached through its own instance, inside its own transaction
 * (`RoomDatabase.runInTransaction`), never through a connection of the inspector's own.
 */
internal interface TrackedDatabase {
    /** `ok`, or `unsupported:closed` / `unsupported:driver`. */
    fun status(): String

    /** Runs [block] in one transaction of the app's database; an exception thrown by it rolls everything back. */
    fun <T> inTransaction(block: (SqlConnection) -> T): T
}

/** Ends a database transaction early with an answer: thrown inside [TrackedDatabase.inTransaction], it rolls back. */
internal class StorageAbort(val code: String, val current: StorageValue? = null) : RuntimeException(code) {
    override fun fillInStackTrace(): Throwable = this
}

/**
 * Test hooks for runtime proofs: set only from inside the app's own process (a debug
 * sample's test screen, by reflection), never over the link. Each defaults to doing nothing.
 */
internal object StorageTestHooks {
    /** Sleeps this long on the commit thread after a prefs `commit()` returned, before it counts as done (a slow disk). */
    @JvmField
    @Volatile
    var commitDelayMs: Long = 0

    /** The next write's answers are dropped after it ran (its answer lost on the way, as when the link breaks). */
    @JvmField
    @Volatile
    var dropNextWriteResult: Boolean = false

    /**
     * The next write's link connection is closed right after it ran (committed), before its answer goes out: the link
     * really breaks and connects again, as when the network drops at that moment.
     */
    @JvmField
    @Volatile
    var disconnectAfterNextCommit: Boolean = false

    /** Runs inside a database read's transaction between two of its pages (another writer's chance, or a delay). */
    @JvmField
    @Volatile
    var betweenPages: Runnable? = null

    /** The storage threads that ran a prefs or database access, when [recordThreads] is on. */
    @JvmField
    @Volatile
    var recordThreads: Boolean = false

    @JvmField
    val threads: MutableSet<String> = java.util.Collections.synchronizedSet(LinkedHashSet())

    fun touched() {
        if (recordThreads) threads += Thread.currentThread().name
    }
}
