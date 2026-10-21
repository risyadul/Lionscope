package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Test

class JsonWriterTest {

    private fun string(value: String) = JsonWriter().value(value).toString()
    private fun number(value: Double) = JsonWriter().value(value).toString()

    @Test
    fun escapesQuotesBackslashesAndShortControlCharacters() {
        assertEquals("\"a\\\"b\\\\c\"", string("a\"b\\c"))
        assertEquals("\"\\n\\r\\t\\b\\f\"", string("\n\r\t\b\u000C"))
    }

    @Test
    fun escapesOtherControlCharactersAndLineSeparatorsAsUnicode() {
        assertEquals("\"\\u0000\\u0001\\u001f\"", string("\u0000\u0001\u001F"))
        assertEquals("\"\\u2028\\u2029\"", string("\u2028\u2029"))
    }

    @Test
    fun keepsOtherUnicodeAndForwardSlashLiteral() {
        assertEquals("\"é/漢字😀\u007f\"", string("é/漢字😀\u007f"))
    }

    @Test
    fun escapedStringsRoundTripThroughAParser() {
        val nasty = "q\"b\\s/\n\u0007\u2028 end"
        assertEquals(nasty, TestJson.parse(string(nasty)))
    }

    @Test
    fun formatsDecimalsWithAtMostThreeFractionDigits() {
        assertEquals("7.9", number(7.9))
        assertEquals("8.333", number(1000.0 / 120))
        assertEquals("16.667", number(1000.0 / 60))
        assertEquals("120", number(120.0))
        assertEquals("0.005", number(0.005))
        assertEquals("0.001", number(0.0006))
        assertEquals("0", number(0.0004))
        assertEquals("-1.25", number(-1.25))
        assertEquals("0", number(-0.0))
    }

    @Test
    fun writesNonFiniteNumbersAsZero() {
        assertEquals("0", number(Double.NaN))
        assertEquals("0", number(Double.POSITIVE_INFINITY))
        assertEquals("0", number(Double.NEGATIVE_INFINITY))
    }

    @Test
    fun writesHugeDecimalsAsIntegersWithoutExponent() {
        assertEquals("1792516375000", number(1.792516375e12))
    }

    @Test
    fun writesIntegersBooleansAndNullsAndSeparatesFields() {
        val json = JsonWriter().beginObject()
            .name("a").value(1)
            .name("b").value(Long.MAX_VALUE)
            .name("c").value(true)
            .name("d").nullValue()
            .name("e").beginArray().value(1).beginObject().endObject().beginArray().endArray().endArray()
            .name("f").beginObject().name("g").value("h").endObject()
            .endObject()
            .toString()
        assertEquals("{\"a\":1,\"b\":9223372036854775807,\"c\":true,\"d\":null,\"e\":[1,{},[]],\"f\":{\"g\":\"h\"}}", json)
    }
}
