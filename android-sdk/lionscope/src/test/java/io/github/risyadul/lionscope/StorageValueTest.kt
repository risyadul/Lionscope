package io.github.risyadul.lionscope

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageValueTest {
    private fun decode(json: String): StorageValue? = StorageCodec.decode(StrictJson.parse(json))

    @Test
    fun integersAreDecimalStringsWithinTheirTypesRange() {
        assertEquals(2147483647L, (decode("""{"t":"int","v":"2147483647"}""") as StorageValue.Integer).value)
        assertNull(decode("""{"t":"int","v":"2147483648"}"""))
        assertEquals(Long.MAX_VALUE, (decode("""{"t":"long","v":"9223372036854775807"}""") as StorageValue.Integer).value)
        assertNull(decode("""{"t":"long","v":"9223372036854775808"}"""))
        assertEquals(Long.MIN_VALUE, (decode("""{"t":"integer","v":"-9223372036854775808"}""") as StorageValue.Integer).value)
        // Numbers, leading zeros, "-0", spaces: never.
        assertNull(decode("""{"t":"int","v":3}"""))
        assertNull(decode("""{"t":"int","v":"03"}"""))
        assertNull(decode("""{"t":"int","v":"-0"}"""))
        assertNull(decode("""{"t":"int","v":" 3"}"""))
    }

    @Test
    fun floatingPointGoesByBitsSoZeroAndMinusZeroDiffer() {
        val zero = decode("""{"t":"real","v":"0.0","bits":"0x0000000000000000"}""")!!
        val minusZero = decode("""{"t":"real","bits":"0x8000000000000000"}""")!!
        assertFalse(zero.same(minusZero))
        assertTrue(zero.same(StorageCut.cell(0.0)))
        assertTrue(minusZero.same(StorageCut.cell(-0.0)))
        val float = decode("""{"t":"float","v":"1.5","bits":"0x3fc00000"}""") as StorageValue.Real
        assertEquals(1.5f, java.lang.Float.intBitsToFloat(float.bits.toInt()))
        assertTrue(float.same(StorageCut.prefs(1.5f)!!))
        // Wrong width, upper case, a number for bits, no bits.
        assertNull(decode("""{"t":"float","bits":"0x0000000000000000"}"""))
        assertNull(decode("""{"t":"real","bits":"0x3FF0000000000000"}"""))
        assertNull(decode("""{"t":"real","v":"1.0"}"""))
        val nan = decode("""{"t":"real","bits":"0x7ff8000000000000"}""") as StorageValue.Real
        assertTrue(nan.isNaN)
        assertEquals("""{"t":"real","v":"1.0","bits":"0x3ff0000000000000"}""", StorageCodec.encode(StorageCut.cell(1.0)))
    }

    @Test
    fun aValueNamesOnlyItsOwnFieldsAndIsNeverRedactedOrCut() {
        assertNull(decode("""{"t":"string","v":"a","x":1}"""))
        assertNull(decode("""{"t":"redacted","orig":"string"}"""))
        assertNull(decode("""{"t":"blob","b64":"AA==","size":1,"complete":false}"""))
        assertNull(decode("""{"t":"string","v":"a","t":"string"}""")) // Duplicate key: the whole text is invalid.
        assertNull(decode("""{"t":"null","v":null}"""))
        assertTrue(decode("""{"t":"null"}""") is StorageValue.Null)
        assertNull(decode("""{"t":"stringSet","v":["a","a"]}"""))
        assertTrue(decode("""{"t":"stringSet","v":["b","a"]}""")!!.same(StorageValue.StringSet(setOf("a", "b"))))
    }

    @Test
    fun cutValuesAreNeverEqualToAnything() {
        val long = "x".repeat(MAX_STORAGE_VALUE_UNITS + 5)
        val cut = StorageCut.text(long)
        assertFalse(cut.complete)
        assertEquals(MAX_STORAGE_VALUE_UNITS + 5, cut.length)
        assertFalse(cut.same(cut))
        assertTrue(StorageCodec.encode(cut).endsWith(""","complete":false,"length":${MAX_STORAGE_VALUE_UNITS + 5}}"""))
        // A cut never splits a surrogate pair.
        val emoji = "a".repeat(MAX_STORAGE_VALUE_UNITS - 1) + "\uD83D\uDE00"
        assertEquals(MAX_STORAGE_VALUE_UNITS - 1, StorageCut.text(emoji).value.length)
    }

    @Test
    fun stringsKeepEveryCodeUnitLoneSurrogatesIncluded() {
        val text = "a\uD800b\u2028\u0000\"\\"
        val encoded = StorageCodec.encode(StorageValue.Text(text))
        assertTrue(encoded.contains("\\ud800"))
        val back = decode(encoded) as StorageValue.Text
        assertEquals(text, back.value)
        assertTrue(back.same(StorageValue.Text(text)))
    }

    @Test
    fun loneSurrogatesAreFoundAndPairsAreNot() {
        for (text in listOf("a\uD800b", "\uDC00", "end \uD800", "\uDC00\uD800", "\uD800\uD800\uDC00")) {
            assertTrue(text, StorageValue.Text(text).hasLoneSurrogate)
        }
        for (text in listOf("", "plain", "emoji \uD83D\uDE00", "\uD83D\uDE00\uD83D\uDE00", "nul \u0000")) {
            assertFalse(text, StorageValue.Text(text).hasLoneSurrogate)
        }
    }

    @Test
    fun blobsAreCanonicalBase64() {
        val bytes = byteArrayOf(0, -1, 16, 32, 64)
        val encoded = Base64Codec.encode(bytes)
        assertEquals(java.util.Base64.getEncoder().encodeToString(bytes), encoded)
        assertArrayEquals(bytes, Base64Codec.decode(encoded))
        assertNull(Base64Codec.decode("AB==")) // Unused bits set: not canonical.
        assertNull(Base64Codec.decode("AAA")) // No padding.
        assertNull(Base64Codec.decode("A-A="))
        assertTrue(decode("""{"t":"blob","b64":"AA==","size":1,"complete":true}""")!!.same(StorageCut.cell(byteArrayOf(0))))
        assertNull(decode("""{"t":"blob","b64":"AA==","size":2,"complete":true}"""))
    }

    @Test
    fun theRowDigestTellsTypesAndCellsApart() {
        val digest = RowDigest.of(listOf(1L, "a", null, 1.5, byteArrayOf(1)))
        assertEquals(64, digest.length)
        assertEquals(digest, RowDigest.of(listOf(1L, "a", null, 1.5, byteArrayOf(1))))
        assertNotEquals(digest, RowDigest.of(listOf("1", "a", null, 1.5, byteArrayOf(1))))
        assertNotEquals(RowDigest.of(listOf("ab", "c")), RowDigest.of(listOf("a", "bc")))
        assertNotEquals(RowDigest.of(listOf(0.0)), RowDigest.of(listOf(-0.0)))
    }

    @Test
    fun prefsValuesKeepTheirType() {
        assertEquals("int", StorageCut.prefs(3)!!.wireType)
        assertEquals("long", StorageCut.prefs(3L)!!.wireType)
        assertFalse(StorageCut.prefs(3)!!.same(StorageCut.prefs(3L)!!))
        assertEquals("""{"t":"stringSet","v":["a","b"]}""", StorageCodec.encode(StorageCut.prefs(linkedSetOf("b", "a"))!!))
        assertNull(StorageCut.prefs(1.0)) // No Double in SharedPreferences.
    }

    @Test
    fun strictJsonRejectsWhatIsNotExactlyOneValue() {
        assertNull(StrictJson.parse("""{"a":1} x"""))
        assertNull(StrictJson.parse("""{"a":1,}"""))
        assertNull(StrictJson.parse("\"a\u0001\""))
        assertNull(StrictJson.parse("[[[[[[[[[[1]]]]]]]]]]"))
        assertNull(StrictJson.parse("01"))
        assertEquals("1e5", (StrictJson.parse("1e5") as StrictJson.Number).literal)
    }
}
