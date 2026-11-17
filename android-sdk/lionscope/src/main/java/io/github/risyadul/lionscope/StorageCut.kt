package io.github.risyadul.lionscope

/**
 * Turns the app's raw values into [StorageValue]s as sent: prefs values from `getAll()` (String, Int, Long, Float,
 * Boolean, Set<String>) and SQLite cells (Long, Double, String, ByteArray, null), cut to [MAX_STORAGE_VALUE_UNITS]
 * (a cut value is `complete = false`, read-only).
 */
internal object StorageCut {
    /** A String / TEXT, cut to [limit] code units (never between the two halves of a surrogate pair). */
    fun text(value: String, limit: Int = MAX_STORAGE_VALUE_UNITS): StorageValue.Text {
        if (value.length <= limit) return StorageValue.Text(value)
        return StorageValue.Text(prefix(value, limit), complete = false, length = value.length)
    }

    /** At most [limit] code units of [value], never ending between the two halves of a surrogate pair. */
    fun prefix(value: String, limit: Int): String {
        if (value.length <= limit) return value
        var end = limit.coerceAtLeast(0)
        if (end > 0 && Character.isHighSurrogate(value[end - 1]) && Character.isLowSurrogate(value[end])) end--
        return value.substring(0, end)
    }

    /**
     * A prefs value, or null for a type SharedPreferences does not have. A `Set<String>` is one value: its elements
     * (sorted) together stay within [MAX_STORAGE_VALUE_UNITS] code units and [MAX_STORAGE_SET_ELEMENTS] elements, so
     * one key never outgrows an answer; a set that does not fit is sent cut (`complete = false`, read-only).
     */
    fun prefs(raw: Any?): StorageValue? = when (raw) {
        is String -> text(raw)
        is Int -> StorageValue.Integer(StorageValue.INT, raw.toLong())
        is Long -> StorageValue.Integer(StorageValue.LONG, raw)
        is Float -> StorageValue.Real(StorageValue.FLOAT, java.lang.Float.floatToRawIntBits(raw).toLong() and 0xffffffffL)
        is Boolean -> StorageValue.Bool(raw)
        is Set<*> -> {
            val strings = raw.filterIsInstance<String>()
            var complete = strings.size == raw.size
            val kept = LinkedHashSet<String>()
            var units = 0
            for (element in strings.sorted()) {
                val left = MAX_STORAGE_VALUE_UNITS - units
                if (kept.size == MAX_STORAGE_SET_ELEMENTS || left <= 0) {
                    complete = false
                    break
                }
                val cut = prefix(element, left)
                if (cut.length < element.length) complete = false
                // A cut element is another string: keep it only when it adds one (the set stays a set).
                if (!kept.add(cut) && cut.length < element.length) break
                units += cut.length
                if (cut.length < element.length) break
            }
            StorageValue.StringSet(kept, complete = complete)
        }
        else -> null
    }

    /**
     * A prefs value whole (never cut), for comparing with what a write wrote; null for a type SharedPreferences does
     * not have. A set with an element that is not a String is not complete (never the same as a written one).
     */
    fun exactPrefs(raw: Any?): StorageValue? = when (raw) {
        is String -> StorageValue.Text(raw)
        is Set<*> -> {
            val strings = raw.filterIsInstance<String>()
            StorageValue.StringSet(LinkedHashSet(strings), complete = strings.size == raw.size)
        }
        else -> prefs(raw)
    }

    /**
     * [value] as it may be sent: a String / TEXT or a BLOB longer than [MAX_STORAGE_VALUE_UNITS] cut (`complete`
     * false, read-only). For values that come back whole from a write (what is stored now, a conflict's current
     * value): a trigger or another writer may have made them as large as anything the app stores.
     */
    fun forWire(value: StorageValue): StorageValue = when (value) {
        is StorageValue.Text -> if (value.value.length > MAX_STORAGE_VALUE_UNITS) squeeze(value, MAX_STORAGE_VALUE_UNITS) else value
        is StorageValue.Blob -> if (value.bytes.size > MAX_STORAGE_VALUE_UNITS) squeeze(value, MAX_STORAGE_VALUE_UNITS) else value
        is StorageValue.StringSet -> if (
            value.complete &&
            (value.values.size > MAX_STORAGE_SET_ELEMENTS || value.values.sumOf { it.length } > MAX_STORAGE_VALUE_UNITS)
        ) {
            prefs(value.values) ?: value
        } else {
            value
        }
        else -> value
    }

    /**
     * [value] cut to at most [units] code units / bytes when it is a String or a BLOB (read-only then), for a row too
     * large to be sent whole; other types are small and stay as they are.
     */
    fun squeeze(value: StorageValue, units: Int): StorageValue = when (value) {
        is StorageValue.Text -> if (value.value.length <= units) {
            value
        } else {
            StorageValue.Text(prefix(value.value, units), complete = false, length = value.length)
        }
        is StorageValue.Blob -> if (value.bytes.size <= units) {
            value
        } else {
            StorageValue.Blob(value.bytes.copyOf(units.coerceAtLeast(0)), value.size, false)
        }
        else -> value
    }

    /** A SQLite cell by its storage class. */
    fun cell(raw: Any?): StorageValue = when (raw) {
        null -> StorageValue.Null
        is Long -> StorageValue.Integer(StorageValue.INTEGER, raw)
        is Double -> StorageValue.Real(StorageValue.REAL, java.lang.Double.doubleToRawLongBits(raw))
        is String -> text(raw)
        is ByteArray -> if (raw.size <= MAX_STORAGE_VALUE_UNITS) {
            StorageValue.Blob(raw, raw.size, true)
        } else {
            StorageValue.Blob(raw.copyOf(MAX_STORAGE_VALUE_UNITS), raw.size, false)
        }
        else -> throw IllegalArgumentException("not a SQLite value")
    }

    /** A cell's value whole (never cut), for comparing with what a write expects. */
    fun exactCell(raw: Any?): StorageValue = when (raw) {
        is String -> StorageValue.Text(raw)
        is ByteArray -> StorageValue.Blob(raw, raw.size, true)
        else -> cell(raw)
    }

    /** Whether a cell is too long to be sent whole (and so to be edited). */
    fun isCut(raw: Any?): Boolean =
        (raw is String && raw.length > MAX_STORAGE_VALUE_UNITS) || (raw is ByteArray && raw.size > MAX_STORAGE_VALUE_UNITS)

    /** A typed value as the SQLite value to bind, or null for SQL NULL. */
    fun bindable(value: StorageValue): Any? = when (value) {
        is StorageValue.Text -> value.value
        is StorageValue.Integer -> value.value
        is StorageValue.Real -> java.lang.Double.longBitsToDouble(value.bits)
        is StorageValue.Blob -> value.bytes
        is StorageValue.Null -> null
        else -> throw IllegalArgumentException("not a SQLite value")
    }
}

/** UTF-8 bytes of encoded JSON text (lone surrogates never occur in it: [JsonWriter] escapes them). */
internal fun utf8Bytes(text: String): Int {
    var bytes = 0
    var i = 0
    while (i < text.length) {
        val c = text[i]
        bytes += when {
            c.code < 0x80 -> 1
            c.code < 0x800 -> 2
            Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1]) -> {
                i++
                4
            }
            else -> 3
        }
        i++
    }
    return bytes
}
