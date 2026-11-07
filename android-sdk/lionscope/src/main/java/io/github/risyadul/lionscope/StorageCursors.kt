package io.github.risyadul.lionscope

import java.security.SecureRandom

/**
 * Where a page of keys or rows continues, kept on the device: what leaves it is an opaque token ([TOKEN_PATTERN]), so
 * a primary key or a prefs key never travels as a cursor (a credential in a key column would otherwise leave the
 * device unredacted, and a long or escaped key would make the cursor as large as the key). Tokens are bound to the
 * prefs file or the database table they page ([scope]: one of another target is unknown there) and to the link
 * connection: [clear] runs when the connection changes. At most [max] are kept, least recently used dropped first; an
 * unknown or dropped token is `invalid_identifier` (read again from the start).
 */
internal class StorageCursors(
    private val max: Int = MAX_STORAGE_CURSORS,
    /** Fills a token's bytes (random; a test makes them predictable). */
    private val fill: (ByteArray) -> Unit = SecureRandom()::nextBytes,
) {
    sealed class Position {
        /** From the first row / key. */
        object Start : Position()

        /** After the row whose paging key cells (primary key, or the rowid) are these raw SQLite values. */
        class AfterKeys(val values: List<Any?>) : Position()

        /** After this many rows of a table that has no key to page by. */
        class AfterOffset(val offset: Int) : Position()

        /** After this prefs key. */
        class AfterKey(val key: String) : Position()
    }

    private class Entry(val scope: String, val position: Position)

    private val entries = object : LinkedHashMap<String, Entry>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Entry>?): Boolean = size > max
    }

    /** A new token for [position] within [scope]. */
    @Synchronized
    fun put(scope: String, position: Position): String {
        val bytes = ByteArray(TOKEN_BYTES)
        fill(bytes)
        val token = TOKEN_PREFIX + bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        entries[token] = Entry(scope, position)
        return token
    }

    /** The position of [token] in [scope], or null when it is unknown there. */
    @Synchronized
    fun get(token: String, scope: String): Position? = entries[token]?.takeIf { it.scope == scope }?.position

    @Synchronized
    fun clear() = entries.clear()

    @get:Synchronized
    val size: Int get() = entries.size

    companion object {
        const val TOKEN_PREFIX = "c1."
        const val TOKEN_BYTES = 16

        /** Every token has exactly this many characters (what answer sizes are measured with). */
        const val TOKEN_CHARS = 3 + TOKEN_BYTES * 2
        val TOKEN_PATTERN = Regex("c1\\.[0-9a-f]{32}")

        fun prefsScope(name: String): String = "p\u0000$name"

        fun tableScope(database: String, table: String): String = "d\u0000$database\u0000$table"
    }
}
