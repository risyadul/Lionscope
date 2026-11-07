package io.github.risyadul.lionscope

import android.content.SharedPreferences
import java.sql.Connection
import java.sql.DriverManager
import java.sql.SQLException

/** An in-memory SharedPreferences with the real one's value semantics (copies of sets, commit / apply). */
internal class FakePrefs(initial: Map<String, Any?> = emptyMap()) : SharedPreferences {
    val values = LinkedHashMap<String, Any?>(initial)
    var commits = 0
    var commitResult = true
    val listeners = ArrayList<SharedPreferences.OnSharedPreferenceChangeListener>()

    override fun getAll(): Map<String, *> = synchronized(this) { LinkedHashMap(values) }
    override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
    @Suppress("UNCHECKED_CAST")
    override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
        (values[key] as? Set<String>)?.toMutableSet() ?: defValues
    override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
    override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
    override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
    override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
    override fun contains(key: String?): Boolean = values.containsKey(key)
    override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
        listeners += listener
    }
    override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
        listeners -= listener
    }

    override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
        val puts = LinkedHashMap<String, Any?>()
        val removes = HashSet<String>()
        override fun putString(key: String, value: String?) = apply { puts[key] = value }
        override fun putStringSet(key: String, values: MutableSet<String>?) = apply { puts[key] = values?.toSet() }
        override fun putInt(key: String, value: Int) = apply { puts[key] = value }
        override fun putLong(key: String, value: Long) = apply { puts[key] = value }
        override fun putFloat(key: String, value: Float) = apply { puts[key] = value }
        override fun putBoolean(key: String, value: Boolean) = apply { puts[key] = value }
        override fun remove(key: String) = apply { removes += key }
        override fun clear() = apply { removes += values.keys }
        override fun commit(): Boolean {
            write()
            commits++
            return commitResult
        }
        override fun apply() = write()
        private fun write() = synchronized(this@FakePrefs) {
            for (key in removes) values.remove(key)
            for ((key, value) in puts) if (value == null) values.remove(key) else values[key] = value
        }
    }
}

internal class FakePrefsAccess(val files: MutableMap<String, FakePrefs> = LinkedHashMap()) : PrefsAccess {
    val opened = ArrayList<String>()
    override fun listFiles(): List<PrefsFile> = files.keys.sorted().map { PrefsFile(it, false) }
    override fun open(name: String): SharedPreferences {
        opened += name
        return files.getValue(name)
    }
}

/**
 * A [TrackedDatabase] over a real SQLite (sqlite-jdbc, in memory): one connection, each [inTransaction] one
 * transaction, rolled back when the block throws, as `runInTransaction` does.
 */
internal class JdbcDatabase(var status: String = "ok") : TrackedDatabase, AutoCloseable {
    val connection: Connection = DriverManager.getConnection("jdbc:sqlite::memory:")
    var transactions = 0

    fun exec(vararg sql: String) {
        connection.createStatement().use { statement -> sql.forEach { statement.executeUpdate(it) } }
    }

    override fun status(): String = status

    override fun <T> inTransaction(block: (SqlConnection) -> T): T {
        connection.autoCommit = false
        transactions++
        try {
            val result = block(JdbcConnection(connection))
            try {
                connection.commit()
            } catch (e: SQLException) {
                // A deferred constraint fails the COMMIT (as SQLiteConstraintException does on Android).
                if (e.message?.contains("CONSTRAINT") == true) throw SqlConstraintException(e.message)
                throw e
            }
            return result
        } catch (t: Throwable) {
            connection.rollback()
            throw t
        } finally {
            connection.autoCommit = true
        }
    }

    override fun close() = connection.close()
}

internal class JdbcConnection(private val connection: Connection) : SqlConnection {
    val statements = ArrayList<String>()

    override fun query(sql: String, args: List<Any?>): SqlRows {
        statements += sql
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeQuery().use { rs ->
                val meta = rs.metaData
                val columns = (1..meta.columnCount).map { meta.getColumnName(it) }
                val rows = ArrayList<List<Any?>>()
                while (rs.next()) {
                    rows += (1..meta.columnCount).map { index ->
                        when (val value = rs.getObject(index)) {
                            is Int -> value.toLong()
                            is Float -> value.toDouble()
                            else -> value
                        }
                    }
                }
                return SqlRows(columns, rows)
            }
        }
    }

    override fun updateDelete(sql: String, args: List<Any?>): Int {
        statements += sql
        connection.prepareStatement(sql).use { statement ->
            bind(statement, args)
            return try {
                statement.executeUpdate()
            } catch (e: SQLException) {
                if (e.message?.contains("CONSTRAINT") == true) throw SqlConstraintException(e.message)
                throw e
            }
        }
    }

    private fun bind(statement: java.sql.PreparedStatement, args: List<Any?>) {
        args.forEachIndexed { i, arg ->
            when (arg) {
                null -> statement.setNull(i + 1, java.sql.Types.NULL)
                is Long -> statement.setLong(i + 1, arg)
                is Double -> statement.setDouble(i + 1, arg)
                is String -> statement.setString(i + 1, arg)
                is ByteArray -> statement.setBytes(i + 1, arg)
                else -> error("not a SQLite value: $arg")
            }
        }
    }
}

internal fun registry(vararg databases: Pair<String, TrackedDatabase>): DatabaseRegistry =
    DatabaseRegistry().apply { databases.forEach { (name, db) -> register(name, db) } }

/** Commits on the calling thread, unless [hold]: then they wait for [release] (a slow disk). */
internal class ManualCommits(nanoTime: () -> Long = System::nanoTime) {
    var hold = false
    private val held = ArrayList<Runnable>()
    val runner = CommitRunner({ task -> if (hold) synchronized(held) { held += task } else task.run() }, nanoTime)

    fun release() {
        val tasks = synchronized(held) { held.toList().also { held.clear() } }
        tasks.forEach { it.run() }
    }
}
