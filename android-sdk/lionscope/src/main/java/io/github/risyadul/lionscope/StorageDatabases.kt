package io.github.risyadul.lionscope

import android.database.Cursor
import android.database.sqlite.SQLiteConstraintException
import android.util.Log
import androidx.room.RoomDatabase
import androidx.sqlite.db.SimpleSQLiteQuery
import androidx.sqlite.db.SupportSQLiteDatabase
import java.lang.ref.WeakReference
import java.util.concurrent.Callable

/**
 * The databases the app registered (`Lionscope.trackDatabase`), by name: at most [max]; registering a name again
 * replaces its database. Thread-safe.
 */
internal class DatabaseRegistry(private val max: Int = MAX_STORAGE_DATABASES) {
    private val databases = LinkedHashMap<String, TrackedDatabase>()

    /** False when [max] other names are registered already (nothing changes). */
    @Synchronized
    fun register(name: String, database: TrackedDatabase): Boolean {
        if (!databases.containsKey(name) && databases.size >= max) return false
        databases[name] = database
        return true
    }

    @Synchronized
    fun get(name: String): TrackedDatabase? = databases[name]

    @Synchronized
    fun all(): List<Pair<String, TrackedDatabase>> = databases.map { it.key to it.value }

    companion object {
        /** The process's registry ([Lionscope.trackDatabase] works before the SDK is installed, too). */
        val shared = DatabaseRegistry()

        fun track(name: String, database: RoomDatabase) {
            try {
                if (name.isEmpty() || name.length > MAX_STORAGE_NAME_CHARS) {
                    Log.w(LOG_TAG, "Lionscope.trackDatabase ignored: the name must be 1-$MAX_STORAGE_NAME_CHARS characters")
                    return
                }
                if (!shared.register(name, RoomTrackedDatabase(database))) {
                    Log.w(LOG_TAG, "Lionscope.trackDatabase ignored: $MAX_STORAGE_DATABASES databases are tracked already")
                }
            } catch (t: Throwable) {
                if (isFatal(t)) throw t
                // Never into the app.
            }
        }
    }
}

/**
 * A Room database the app registered, reached only through its own instance: every read and write runs in
 * `runInTransaction` on the connection Room hands out (`openHelper.writableDatabase` inside it), which is also what
 * makes Room's InvalidationTracker tell observers (Flow, LiveData) which tables changed. Held weakly. A Room 2.7
 * database built with `setDriver` has no SupportSQLiteOpenHelper: `unsupported:driver`. One the app closed (after it
 * was seen open) is `unsupported:closed`.
 */
internal class RoomTrackedDatabase(database: RoomDatabase) : TrackedDatabase {
    private val reference = WeakReference(database)

    @Volatile
    private var seenOpen = isOpen(database)

    override fun status(): String {
        val database = reference.get() ?: return "unsupported:closed"
        if (isOpen(database)) seenOpen = true else if (seenOpen) return "unsupported:closed"
        return try {
            database.openHelper
            "ok"
        } catch (e: RuntimeException) {
            "unsupported:driver"
        }
    }

    override fun <T> inTransaction(block: (SqlConnection) -> T): T {
        val database = reference.get() ?: throw StorageAbort("unsupported:closed")
        val status = status()
        if (status != "ok") throw StorageAbort(status)
        return try {
            database.runInTransaction(Callable {
                seenOpen = true
                block(SupportConnection(database.openHelper.writableDatabase))
            })
        } catch (e: SQLiteConstraintException) {
            // A constraint checked at COMMIT (the statements map theirs in SupportConnection).
            throw SqlConstraintException(e.javaClass.simpleName)
        } catch (e: IllegalStateException) {
            // The pool was closed under it.
            if (!isOpen(database) && seenOpen) throw StorageAbort("unsupported:closed")
            throw e
        }
    }

    private fun isOpen(database: RoomDatabase): Boolean = try {
        database.isOpen
    } catch (e: RuntimeException) {
        false
    }
}

/** The allowlisted statements on the connection of the app's own transaction. */
internal class SupportConnection(private val db: SupportSQLiteDatabase) : SqlConnection {
    override fun query(sql: String, args: List<Any?>): SqlRows {
        StorageTestHooks.touched()
        db.query(SimpleSQLiteQuery(sql, args.toTypedArray())).use { cursor ->
            val columns = cursor.columnNames.toList()
            val rows = ArrayList<List<Any?>>()
            while (cursor.moveToNext()) {
                rows += (0 until cursor.columnCount).map { index ->
                    when (cursor.getType(index)) {
                        Cursor.FIELD_TYPE_NULL -> null
                        Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(index)
                        Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
                        Cursor.FIELD_TYPE_STRING -> cursor.getString(index)
                        else -> cursor.getBlob(index)
                    }
                }
            }
            return SqlRows(columns, rows)
        }
    }

    override fun updateDelete(sql: String, args: List<Any?>): Int {
        StorageTestHooks.touched()
        val statement = db.compileStatement(sql)
        try {
            args.forEachIndexed { i, arg ->
                val index = i + 1
                when (arg) {
                    null -> statement.bindNull(index)
                    is Long -> statement.bindLong(index, arg)
                    is Double -> statement.bindDouble(index, arg)
                    is String -> statement.bindString(index, arg)
                    is ByteArray -> statement.bindBlob(index, arg)
                    else -> throw IllegalArgumentException("not a SQLite value")
                }
            }
            return statement.executeUpdateDelete()
        } catch (e: SQLiteConstraintException) {
            throw SqlConstraintException(e.javaClass.simpleName)
        } finally {
            statement.close()
        }
    }
}
