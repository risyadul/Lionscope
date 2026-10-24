package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The v8 edit lines, and every golden server → SDK line in protocol/fixtures/gateway-messages.ndjson. */
class GatewayEditMessageTest {

    private val goldenLines: List<String> by lazy {
        val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
        File(dir, "gateway-messages.ndjson").readLines(Charsets.UTF_8).filter { it.isNotBlank() }
    }

    private fun set(line: String) = GatewayMessage.parse(line) as GatewayMessage.SetViewProperty
    private fun revert(line: String) = GatewayMessage.parse(line) as GatewayMessage.RevertViewProperties

    @Test
    fun everyGoldenLineParsesAsItsType() {
        assertTrue(goldenLines.size >= 10)
        for (line in goldenLines) {
            val message = GatewayMessage.parse(line)
            val type = (TestJson.parse(line) as Map<*, *>)["type"]
            val expected = when (type) {
                "welcome" -> GatewayMessage.Welcome::class
                "bye" -> GatewayMessage.Bye::class
                "config" -> GatewayMessage.Config::class
                "inspect" -> GatewayMessage.Inspect::class
                "mocks" -> GatewayMessage.Mocks::class
                "mock" -> GatewayMessage.Mock::class
                "setViewProperty" -> GatewayMessage.SetViewProperty::class
                "revertViewProperties" -> GatewayMessage.RevertViewProperties::class
                else -> error("no parser for $type")
            }
            assertEquals(line, expected, message?.let { it::class })
        }
    }

    @Test
    fun goldenSetLinesKeepTheirValuesExactly() {
        val sets = goldenLines.filter { it.startsWith("{\"type\":\"setViewProperty\"") }.map(::set)
        val values = sets.associate { it.property to it.value }
        assertEquals(24.0, values[ViewProperty.PADDING_LEFT])
        assertEquals("gone", values[ViewProperty.VISIBILITY])
        assertEquals(false, values[ViewProperty.ENABLED])
        assertEquals(0.35, values[ViewProperty.ALPHA])
        assertEquals(-8.5, values[ViewProperty.TRANSLATION_Y])
        assertEquals("wrap_content", values[ViewProperty.LAYOUT_WIDTH])
        assertEquals("#FF3366CC", values[ViewProperty.BACKGROUND_COLOR])
        assertEquals(18.5, values[ViewProperty.TEXT_SIZE])
        // Quotes, backslashes, a line break, an emoji, a line separator, a would-be field and a tab survive as text.
        assertEquals("Pay \"now\"\n\\ 🛒 {\"type\":\"bye\",\"requestId\":1}é\t", values[ViewProperty.TEXT])
        assertTrue(sets.all { it.viewKey == 42 })
        assertEquals((11..19).toList(), sets.map { it.requestId })
        // Every golden value is one the SDK itself accepts.
        for (message in sets) assertTrue(message.property.wire, ViewValues.parse(message.property, message.value) != null)
    }

    @Test
    fun goldenRevertLinesNameAGroupAViewOrEverything() {
        val reverts = goldenLines.filter { it.startsWith("{\"type\":\"revertViewProperties\"") }.map(::revert)
        assertEquals(3, reverts.size)
        assertEquals(42, reverts[0].viewKey)
        assertEquals(ViewProperty.PADDING, reverts[0].properties)
        assertEquals(42, reverts[1].viewKey)
        assertNull(reverts[1].properties)
        assertNull(reverts[2].viewKey)
        assertNull(reverts[2].properties)
    }

    @Test
    fun aRevertTakesOneProperty() {
        val one = revert("{\"type\":\"revertViewProperties\",\"requestId\":1,\"viewKey\":3,\"property\":\"textColor\"}")
        assertEquals(listOf(ViewProperty.TEXT_COLOR), one.properties)
        assertEquals(
            ViewProperty.MARGIN,
            revert("{\"type\":\"revertViewProperties\",\"requestId\":1,\"viewKey\":3,\"property\":\"margin\"}").properties,
        )
        val explicitNulls = revert("{\"type\":\"revertViewProperties\",\"requestId\":2,\"viewKey\":null,\"property\":null}")
        assertNull(explicitNulls.viewKey)
        assertNull(explicitNulls.properties)
    }

    @Test
    fun anEditLineWithABadFieldIsDropped() {
        val base = "\"type\":\"setViewProperty\",\"requestId\":1,\"viewKey\":2"
        for (line in listOf(
            "{$base,\"property\":\"paddingStart\",\"value\":1}",
            "{$base,\"property\":\"padding\",\"value\":1}",
            "{$base,\"property\":\"alpha\"}",
            "{$base,\"property\":\"alpha\",\"value\":null}",
            "{$base,\"property\":\"alpha\",\"value\":{\"a\":1}}",
            "{$base,\"property\":\"alpha\",\"value\":[1]}",
            "{$base,\"property\":7,\"value\":1}",
            "{$base,\"property\":\"alpha\",\"value\":1,\"value\":0}",
            "{\"type\":\"setViewProperty\",\"requestId\":-1,\"viewKey\":2,\"property\":\"alpha\",\"value\":1}",
            "{\"type\":\"setViewProperty\",\"requestId\":1.5,\"viewKey\":2,\"property\":\"alpha\",\"value\":1}",
            "{\"type\":\"setViewProperty\",\"requestId\":1,\"viewKey\":0,\"property\":\"alpha\",\"value\":1}",
            "{\"type\":\"setViewProperty\",\"requestId\":1,\"viewKey\":2147483648,\"property\":\"alpha\",\"value\":1}",
            "{\"type\":\"setViewProperty\",\"requestId\":1,\"property\":\"alpha\",\"value\":1}",
            // A different type in the full parse than the first-key scan saw.
            "{\"type\":\"setViewProperty\",\"requestId\":1,\"viewKey\":2,\"property\":\"alpha\",\"value\":1,\"type\":\"bye\"}",
            "{\"type\":\"revertViewProperties\",\"requestId\":1,\"property\":\"alpha\"}",
            "{\"type\":\"revertViewProperties\",\"requestId\":1,\"viewKey\":2,\"property\":\"everything\"}",
            "{\"type\":\"revertViewProperties\",\"requestId\":1,\"viewKey\":\"2\"}",
            "{\"type\":\"revertViewProperties\"}",
        )) {
            assertNull(line, GatewayMessage.parse(line))
        }
    }
}
