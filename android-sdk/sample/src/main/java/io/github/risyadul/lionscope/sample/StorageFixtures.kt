package io.github.risyadul.lionscope.sample

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.DatabaseView
import androidx.room.Entity
import androidx.room.Fts4
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

// The storage inspector demo's data (StorageActivity): every value is made up. Tables cover what the inspector must
// tell apart: an observed table, an invariant, REAL / TEXT / BLOB edge values, a composite key,
// a credential column, a trigger, a view, an FTS table and a table without an explicit primary key.

@Entity(tableName = "item")
class Item(@PrimaryKey val id: Long, val name: String, val price: Double?, val qty: Int)

@Entity(tableName = "account")
class Account(@PrimaryKey val id: Long, val balance: Long)

@Entity(tableName = "counter")
class Counter(@PrimaryKey val id: Long, val value: Long)

@Entity(tableName = "metric")
class Metric(@PrimaryKey val id: Long, val x: Double, val y: Double?)

@Entity(tableName = "blob_row")
class BlobRow(@PrimaryKey val id: Long, val text: String?, val data: ByteArray?)

@Entity(tableName = "session")
class SessionRow(@PrimaryKey val email: String, @ColumnInfo(name = "access_token") val accessToken: String, val label: String)

@Entity(tableName = "pair", primaryKeys = ["a", "b"])
class PairRow(val a: String, val b: Long, val v: String)

@Fts4
@Entity(tableName = "note_fts")
class NoteFts(val body: String)

@DatabaseView(value = "SELECT name FROM item", viewName = "item_names")
class ItemName(val name: String)

@Dao
interface ItemDao {
    @Query("SELECT * FROM item ORDER BY id")
    fun observeAll(): Flow<List<Item>>

    @Query("SELECT * FROM item ORDER BY id")
    fun all(): List<Item>

    @Query("UPDATE item SET name = :name WHERE id = :id")
    fun rename(id: Long, name: String): Int

    @Query("SELECT SUM(balance) FROM account")
    fun totalBalance(): Long

    @Query("SELECT balance FROM account WHERE id = :id")
    fun balance(id: Long): Long

    @Query("UPDATE account SET balance = balance + :delta WHERE id = :id")
    fun addBalance(id: Long, delta: Long): Int
}

@Database(
    entities = [Item::class, Account::class, Counter::class, Metric::class, BlobRow::class, SessionRow::class, PairRow::class, NoteFts::class],
    views = [ItemName::class],
    version = 1,
    exportSchema = false,
)
abstract class ShopDatabase : RoomDatabase() {
    abstract fun items(): ItemDao

    companion object {
        const val TAG = "LionscopeStorageFixture"

        fun build(context: Context): ShopDatabase = Room.databaseBuilder(context, ShopDatabase::class.java, "shop.db")
            .addCallback(object : Callback() {
                override fun onCreate(db: SupportSQLiteDatabase) = seed(db)
            })
            .build()

        private fun seed(db: SupportSQLiteDatabase) {
            // Rows the app itself writes on first open (the inspector never runs these).
            db.execSQL("INSERT INTO item VALUES (1, 'Apple', 1.5, 10), (2, 'Bread', NULL, 5), (3, 'Milk', 0.0, 7)")
            db.execSQL("INSERT INTO account VALUES (1, 1000), (2, 1000)")
            db.execSQL("INSERT INTO counter VALUES (1, 9223372036854775807), (2, -9223372036854775808), (3, 7)")
            db.execSQL("INSERT INTO metric VALUES (1, 1.5, 2.5), (2, 0.1, NULL)")
            db.execSQL("INSERT INTO session VALUES ('ana@example.com', 'tok-abc123', 'main')")
            db.execSQL("INSERT INTO pair VALUES ('x', 1, 'x1'), ('x', 2, 'x2'), ('y', 1, 'y1')")
            db.execSQL("INSERT INTO note_fts (body) VALUES ('hello storage')")
            db.execSQL("CREATE TABLE raw_log (msg TEXT)")
            db.execSQL("INSERT INTO raw_log VALUES ('a'), ('b')")
            db.execSQL("CREATE TABLE item_log (id INTEGER PRIMARY KEY AUTOINCREMENT, item INTEGER)")
            db.execSQL("CREATE TRIGGER item_qty_log AFTER UPDATE OF qty ON item BEGIN INSERT INTO item_log (item) VALUES (NEW.id); END")
            // A view renaming a credential column, and a table keyed by a credential (neither may leak one).
            db.execSQL("CREATE VIEW credential_view AS SELECT email, access_token AS value FROM session")
            db.execSQL("CREATE TABLE vault (access_token TEXT PRIMARY KEY, label TEXT)")
            db.execSQL("INSERT INTO vault VALUES ('vault-secret-alpha', 'a'), ('vault-secret-beta', 'b')")
            val blob = ByteArray(1024) { (it * 37 + 11).toByte() }
            db.execSQL("INSERT INTO blob_row VALUES (1, 'a', ?)", arrayOf<Any?>(blob))
            db.execSQL("INSERT INTO blob_row VALUES (2, ?, ?)", arrayOf<Any?>("z".repeat(20 * 1024), ByteArray(20 * 1024)))
            // A trigger of the app that makes the edited cell far larger than an answer may carry (300 000 bytes).
            db.execSQL("CREATE TABLE doc (id INTEGER PRIMARY KEY, body BLOB)")
            db.execSQL("INSERT INTO doc VALUES (1, x'00')")
            db.execSQL("CREATE TRIGGER doc_grow AFTER UPDATE OF body ON doc WHEN length(NEW.body) < 1000 BEGIN UPDATE doc SET body = zeroblob(300000) WHERE id = NEW.id; END")
            Log.i(TAG, "shop.db seeded")
        }
    }
}

/** A Room database opened through a SQLiteDriver (Room 2.7 `setDriver`): the inspector reports it unsupported. */
@Database(entities = [Counter::class], version = 1, exportSchema = false)
abstract class DriverDatabase : RoomDatabase() {
    companion object {
        fun build(context: Context): DriverDatabase = Room.databaseBuilder(context, DriverDatabase::class.java, "driver.db")
            .setDriver(androidx.sqlite.driver.AndroidSQLiteDriver())
            .build()
    }
}

/**
 * A database with a deferred foreign key (`track.artist`, checked at COMMIT): the inspector shows `artist` and `track`
 * read-only (`unsupported:deferred_fk`), `counter`, `plain`, `owner` and `pet` (an immediate key) stay editable.
 */
@Database(entities = [Counter::class], version = 1, exportSchema = false)
abstract class EdgeDatabase : RoomDatabase() {
    companion object {
        fun build(context: Context): EdgeDatabase = Room.databaseBuilder(context, EdgeDatabase::class.java, "edge.db")
            .addCallback(object : Callback() {
                override fun onCreate(db: SupportSQLiteDatabase) {
                    db.execSQL("CREATE TABLE artist (id INTEGER PRIMARY KEY, name TEXT)")
                    db.execSQL("CREATE TABLE track (id INTEGER PRIMARY KEY, artist INTEGER REFERENCES artist(id) DEFERRABLE INITIALLY DEFERRED, title TEXT)")
                    db.execSQL("CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)")
                    db.execSQL("INSERT INTO artist VALUES (1, 'a')")
                    db.execSQL("INSERT INTO track VALUES (1, 1, 't')")
                    db.execSQL("INSERT INTO plain VALUES (1, 'x')")
                    db.execSQL("INSERT INTO counter VALUES (1, 1)")
                    db.execSQL("CREATE TABLE owner (id INTEGER PRIMARY KEY)")
                    db.execSQL("CREATE TABLE pet (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owner(id), name TEXT)")
                    db.execSQL("INSERT INTO owner VALUES (1)")
                    db.execSQL("INSERT INTO pet VALUES (1, 1, 'rex')")
                }
            })
            .build()
    }
}

object StoragePrefsFixture {
    const val NAME = "app_settings"
    const val SECURE = "secure_prefs"
    const val LONG_KEYS = "long_keys"

    /** A key of exactly the 1024 characters sent, and a longer one starting with it (shown cut: read-only). */
    fun seedLongKeys(context: Context) {
        val prefs = context.getSharedPreferences(LONG_KEYS, Context.MODE_PRIVATE)
        if (prefs.all.isEmpty()) {
            val prefix = "k".repeat(1024)
            prefs.edit().putInt(prefix, 3).putInt(prefix + "suffix", 3).commit()
        }
    }

    /** Writes the demo prefs once (commit: they are on disk before the inspector lists them). */
    fun seed(context: Context): SharedPreferences {
        val prefs = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)
        if (!prefs.contains("seeded")) {
            val jwt = listOf("eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJkZW1vIn0", "ZGVtby1zaWduYXR1cmU").joinToString(".")
            prefs.edit()
                .putBoolean("seeded", true)
                .putInt("count", 3)
                .putLong("big", Long.MAX_VALUE)
                .putLong("small", Long.MIN_VALUE)
                .putFloat("ratio", 0.5f)
                .putFloat("zero", 0.0f)
                .putFloat("nan", Float.NaN)
                .putFloat("tenth", 0.1f)
                .putBoolean("dark", true)
                .putString("name", "Ana")
                .putString("emoji", "hi \uD83D\uDE00")
                .putStringSet("tags", setOf("beta", "alpha"))
                .putString("access_token", "tok-abc123")
                .putString("user_json", """{"token":"t0k-demo","name":"x"}""")
                .putString("note", "token: $jwt")
                .putString("callback", "https://example.com/cb?sig=deadbeef&id=7")
                .commit()
        }
        val secure = context.getSharedPreferences(SECURE, Context.MODE_PRIVATE)
        if (secure.all.isEmpty()) {
            // What EncryptedSharedPreferences keeps (made-up values): the inspector must not read it.
            secure.edit().putString("__androidx_security_crypto_encrypted_prefs_key_keyset__", "demo").commit()
        }
        return prefs
    }
}
