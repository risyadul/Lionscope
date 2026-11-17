package io.github.risyadul.lionscope

import java.math.BigInteger
import java.security.MessageDigest

/**
 * One value of the storage inspector, typed (`StorageValue` in protocol/src/wire.ts): SharedPreferences types and
 * SQLite storage classes. [same] is the exact comparison compare-and-set uses: the same type and the same value per
 * type (64-bit integers, floating point by raw bits so `0.0` is not `-0.0`, strings by UTF-16 code unit, blobs by byte,
 * sets by set equality). A value that was cut for sending ([complete] false) or [Redacted] is never compared.
 */
internal sealed class StorageValue {
    abstract val wireType: String
    open val complete: Boolean get() = true

    /** prefs `String` or SQLite TEXT; [length] the full length when cut. */
    class Text(val value: String, override val complete: Boolean = true, val length: Int = value.length) : StorageValue() {
        override val wireType get() = "string"

        /** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
        val hasLoneSurrogate: Boolean get() = hasLoneSurrogate(value)
    }

    /** prefs `int` / `long`, SQLite INTEGER (`integer`). */
    class Integer(override val wireType: String, val value: Long) : StorageValue()

    /** prefs `float` (raw bits in the low 32 bits) or SQLite REAL (`real`, 64 raw bits). */
    class Real(override val wireType: String, val bits: Long) : StorageValue() {
        val isFloat get() = wireType == FLOAT
        val isNaN get() = if (isFloat) java.lang.Float.intBitsToFloat(bits.toInt()).isNaN() else java.lang.Double.longBitsToDouble(bits).isNaN()
    }

    class Bool(val value: Boolean) : StorageValue() {
        override val wireType get() = "bool"
    }

    /** prefs `Set<String>`, sent sorted by code unit. */
    class StringSet(val values: Set<String>, override val complete: Boolean = true) : StorageValue() {
        override val wireType get() = "stringSet"
    }

    /** SQLite BLOB: [bytes] as sent (all of them when [complete]), [size] the full length. */
    class Blob(val bytes: ByteArray, val size: Int, override val complete: Boolean) : StorageValue() {
        override val wireType get() = "blob"
    }

    object Null : StorageValue() {
        override val wireType get() = "null"
    }

    /** Looks like a credential: [orig] the type it has, [preview] (strings) the text with the credentials replaced. */
    class Redacted(val orig: String, val preview: String? = null) : StorageValue() {
        override val wireType get() = "redacted"
    }

    /** The exact comparison of compare-and-set (see the class comment). */
    fun same(other: StorageValue): Boolean {
        if (wireType != other.wireType || !complete || !other.complete) return false
        return when (this) {
            is Text -> value == (other as Text).value
            is Integer -> value == (other as Integer).value
            is Real -> bits == (other as Real).bits
            is Bool -> value == (other as Bool).value
            is StringSet -> values == (other as StringSet).values
            is Blob -> bytes.contentEquals((other as Blob).bytes)
            is Null -> true
            is Redacted -> false
        }
    }

    companion object {
        const val INT = "int"
        const val LONG = "long"
        const val INTEGER = "integer"
        const val FLOAT = "float"
        const val REAL = "real"
        val PREFS_TYPES = setOf("string", INT, LONG, FLOAT, "bool", "stringSet")
        val SQLITE_TYPES = setOf("string", INTEGER, REAL, "blob", "null")

        /** [text] has a high surrogate not followed by a low one, or a low one not preceded by a high one. */
        fun hasLoneSurrogate(text: String): Boolean {
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (Character.isHighSurrogate(c)) {
                    if (i + 1 >= text.length || !Character.isLowSurrogate(text[i + 1])) return true
                    i += 2
                    continue
                }
                if (Character.isLowSurrogate(c)) return true
                i++
            }
            return false
        }
    }
}

/** Reads and writes [StorageValue]s as the wire's canonical JSON. */
internal object StorageCodec {
    private val INTEGER_TEXT = Regex("0|-?[1-9][0-9]*")
    private val FLOAT_BITS = Regex("0x[0-9a-f]{8}")
    private val REAL_BITS = Regex("0x[0-9a-f]{16}")

    /**
     * A value a write names (`expected`, `value`, a key cell), strictly: complete, not redacted, only the fields of its
     * type, integers as decimal strings within range, floats by `bits`. Null when invalid.
     */
    fun decode(json: Any?): StorageValue? {
        val obj = json as? Map<*, *> ?: return null
        val type = obj["t"] as? String ?: return null
        fun only(vararg keys: String) = obj.keys.all { it in keys }
        return when (type) {
            "string" -> {
                if (!only("t", "v")) return null
                val v = obj["v"] as? String ?: return null
                if (v.length > MAX_STORAGE_VALUE_UNITS) return null
                StorageValue.Text(v)
            }
            StorageValue.INT, StorageValue.LONG, StorageValue.INTEGER -> {
                if (!only("t", "v")) return null
                val text = obj["v"] as? String ?: return null
                if (text.length > 20 || !INTEGER_TEXT.matches(text)) return null
                val big = BigInteger(text)
                val (min, max) = if (type == StorageValue.INT) {
                    BigInteger.valueOf(Int.MIN_VALUE.toLong()) to BigInteger.valueOf(Int.MAX_VALUE.toLong())
                } else {
                    BigInteger.valueOf(Long.MIN_VALUE) to BigInteger.valueOf(Long.MAX_VALUE)
                }
                if (big < min || big > max) return null
                StorageValue.Integer(type, big.toLong())
            }
            StorageValue.FLOAT, StorageValue.REAL -> {
                if (!only("t", "v", "bits")) return null
                val bits = obj["bits"] as? String ?: return null
                if (!(if (type == StorageValue.FLOAT) FLOAT_BITS else REAL_BITS).matches(bits)) return null
                if (obj.containsKey("v") && obj["v"] !is String) return null
                StorageValue.Real(type, BigInteger(bits.substring(2), 16).toLong())
            }
            "bool" -> {
                if (!only("t", "v")) return null
                StorageValue.Bool(obj["v"] as? Boolean ?: return null)
            }
            "stringSet" -> {
                if (!only("t", "v")) return null
                val list = obj["v"] as? List<*> ?: return null
                if (list.size > MAX_STORAGE_SET_ELEMENTS) return null
                val strings = list.map { (it as? String)?.takeIf { s -> s.length <= MAX_STORAGE_VALUE_UNITS } ?: return null }
                val set = LinkedHashSet(strings)
                if (set.size != strings.size) return null
                StorageValue.StringSet(set)
            }
            "blob" -> {
                if (!only("t", "b64", "size", "complete")) return null
                if (obj["complete"] != true) return null
                val b64 = obj["b64"] as? String ?: return null
                val bytes = base64(b64) ?: return null
                val size = (obj["size"] as? StrictJson.Number)?.literal?.toIntOrNull() ?: return null
                if (bytes.size != size || size > MAX_STORAGE_VALUE_UNITS) return null
                StorageValue.Blob(bytes, size, true)
            }
            "null" -> if (only("t")) StorageValue.Null else null
            else -> null
        }
    }

    /** A JSON array of values (a primary key), or null when any is invalid. */
    fun decodeList(json: Any?, max: Int): List<StorageValue>? {
        val list = json as? List<*> ?: return null
        if (list.isEmpty() || list.size > max) return null
        return list.map { decode(it) ?: return null }
    }

    fun write(json: JsonWriter, value: StorageValue): JsonWriter {
        json.beginObject().name("t").value(value.wireType)
        when (value) {
            is StorageValue.Text -> {
                json.name("v").value(value.value)
                if (!value.complete) json.name("complete").value(false).name("length").value(value.length.toLong())
            }
            is StorageValue.Integer -> json.name("v").value(value.value.toString())
            is StorageValue.Real -> json.name("v").value(display(value)).name("bits").value(bitsText(value))
            is StorageValue.Bool -> json.name("v").value(value.value)
            is StorageValue.StringSet -> {
                json.name("v").beginArray()
                for (element in value.values.sorted()) json.value(element)
                json.endArray()
                if (!value.complete) json.name("complete").value(false)
            }
            is StorageValue.Blob -> json.name("b64").value(Base64Codec.encode(value.bytes))
                .name("size").value(value.size.toLong()).name("complete").value(value.complete)
            is StorageValue.Null -> Unit
            is StorageValue.Redacted -> {
                json.name("orig").value(value.orig)
                value.preview?.let { json.name("preview").value(it) }
            }
        }
        return json.endObject()
    }

    fun encode(value: StorageValue): String = write(JsonWriter(), value).toString()

    fun bitsText(value: StorageValue.Real): String =
        if (value.isFloat) "0x%08x".format(value.bits.toInt()) else "0x%016x".format(value.bits)

    private fun display(value: StorageValue.Real): String =
        if (value.isFloat) java.lang.Float.intBitsToFloat(value.bits.toInt()).toString()
        else java.lang.Double.longBitsToDouble(value.bits).toString()

    private fun base64(text: String): ByteArray? = Base64Codec.decode(text)
}

/** Standard base64 with padding, without android.util.Base64 (a stub in JVM tests). */
internal object Base64Codec {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i + 2 < bytes.size) {
            val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8) or (bytes[i + 2].toInt() and 0xff)
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63]).append(ALPHABET[n shr 6 and 63]).append(ALPHABET[n and 63])
            i += 3
        }
        val left = bytes.size - i
        if (left == 1) {
            val n = bytes[i].toInt() and 0xff shl 16
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63]).append("==")
        } else if (left == 2) {
            val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8)
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63]).append(ALPHABET[n shr 6 and 63]).append('=')
        }
        return out.toString()
    }

    /** Null unless canonical padded base64. */
    fun decode(text: String): ByteArray? {
        if (text.length % 4 != 0) return null
        val padding = when {
            text.endsWith("==") -> 2
            text.endsWith("=") -> 1
            else -> 0
        }
        val out = ByteArray(text.length / 4 * 3 - padding)
        var o = 0
        var i = 0
        while (i < text.length) {
            var n = 0
            for (j in 0 until 4) {
                val c = text[i + j]
                val v = if (c == '=' && i + 4 == text.length && j >= 4 - padding) 0 else ALPHABET.indexOf(c)
                if (v < 0) return null
                n = n shl 6 or v
            }
            for (j in 0 until 3) if (o < out.size) out[o++] = (n shr (16 - 8 * j) and 0xff).toByte()
            i += 4
        }
        // Canonical only: the unused bits of the last group must be zero (re-encoding gives the same text).
        return if (encode(out) == text) out else null
    }
}

/**
 * A row's digest (`StorageRow.digest`): SHA-256 over every cell in column order, exact (type, then 64 bits, raw IEEE
 * bits, UTF-16 code units or bytes, with lengths), cut cells included in full. A delete runs only while the row's
 * digest is still the one read.
 */
internal object RowDigest {
    fun of(cells: List<Any?>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = java.nio.ByteBuffer.allocate(9)
        for (cell in cells) {
            buffer.clear()
            when (cell) {
                null -> digest.update(0)
                is Long -> {
                    buffer.put(1).putLong(cell)
                    digest.update(buffer.array(), 0, 9)
                }
                is Double -> {
                    buffer.put(2).putLong(java.lang.Double.doubleToRawLongBits(cell))
                    digest.update(buffer.array(), 0, 9)
                }
                is String -> {
                    buffer.put(3).putInt(cell.length)
                    digest.update(buffer.array(), 0, 5)
                    val units = ByteArray(cell.length * 2)
                    for ((index, char) in cell.withIndex()) {
                        units[index * 2] = (char.code shr 8).toByte()
                        units[index * 2 + 1] = char.code.toByte()
                    }
                    digest.update(units)
                }
                is ByteArray -> {
                    buffer.put(4).putInt(cell.size)
                    digest.update(buffer.array(), 0, 5)
                    digest.update(cell)
                }
                else -> throw IllegalArgumentException("not a SQLite value")
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}
