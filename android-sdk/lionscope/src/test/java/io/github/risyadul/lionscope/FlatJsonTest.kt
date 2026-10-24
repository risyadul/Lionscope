package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FlatJsonTest {

    @Test
    fun readsStringsNumbersBooleansAndNull() {
        val json = checkNotNull(FlatJson.parse(" {\"a\" : \"x\", \"n\":-12,\"f\":1.5,\"e\":2e3,\"t\":true,\"no\":false,\"z\":null} "))
        assertEquals("x", json.string("a"))
        assertEquals(-12, json.int("n"))
        assertNull(json.int("f")) // Not an integer.
        assertNull(json.int("e"))
        assertEquals(true, json.boolean("t"))
        assertEquals(false, json.boolean("no"))
        assertTrue(json.has("z"))
        assertNull(json.string("z"))
        assertFalse(json.has("missing"))
        assertNull(json.int("a"))
        assertFalse(checkNotNull(FlatJson.parse("{}")).has("a"))
    }

    @Test
    fun integersThatDoNotFitAnIntAreNotInts() {
        val json = checkNotNull(FlatJson.parse("{\"max\":2147483647,\"over\":2147483648,\"min\":-2147483648}"))
        assertEquals(Int.MAX_VALUE, json.int("max"))
        assertNull(json.int("over"))
        assertEquals(Int.MIN_VALUE, json.int("min"))
    }

    @Test
    fun decodesEveryEscapeIncludingSurrogatePairs() {
        val line = "{\"s\":\"q\\\" b\\\\ s\\/ \\b\\f\\n\\r\\t \\u00e9 \\ud83d\\ude00 \\u2713 raw ✓ \uD83D\uDE00\"}"
        assertEquals("q\" b\\ s/ \b\u000C\n\r\t é \uD83D\uDE00 ✓ raw ✓ \uD83D\uDE00", FlatJson.parse(line)?.string("s"))
    }

    @Test
    fun rejectsAnythingButOneFlatObject() {
        for (line in listOf(
            "",
            "[]",
            "{\"a\":{\"b\":1}}",
            "{\"a\":[1]}",
            "{\"a\":1,}",
            "{\"a\":1}x",
            "{\"a\":1}{}",
            "{\"a\" 1}",
            "{a:1}",
            "{\"a\":\"\\x\"}",
            "{\"a\":\"\\u12\"}",
            "{\"a\":\"\\u+123\"}",
            "{\"a\":\"open}",
            "{\"a\":\"raw\nnewline\"}",
            "{\"a\":01}",
            "{\"a\":1.}",
            "{\"a\":tru}",
            "{\"a\":1,\"a\":2}",
        )) {
            assertNull(line, FlatJson.parse(line))
        }
    }
}
