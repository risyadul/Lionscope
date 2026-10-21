package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every golden line in protocol/fixtures/device-messages.ndjson must be reproduced by the encoders. */
class DeviceMessagesTest {

    private val goldenLines: List<String> by lazy {
        val dir = System.getProperty("lionscope.fixtures") ?: "../../protocol/fixtures"
        File(dir, "device-messages.ndjson").readLines(Charsets.UTF_8).filter { it.isNotBlank() }
    }

    @Test
    fun encodesEveryGoldenLine() {
        assertTrue("golden fixture is empty", goldenLines.isNotEmpty())
        for (line in goldenLines) {
            val golden = TestJson.parse(line)
            val encoded = encode(golden as Map<*, *>)
            val actual = TestJson.parse(encoded)
            assertEquals("JSON mismatch for $line", golden, actual)
            assertEquals("field order mismatch for $line", TestJson.keyOrder(golden), TestJson.keyOrder(actual))
        }
    }

    @Test
    fun goldenFixtureCoversEveryMessageType() {
        val types = goldenLines.map { (TestJson.parse(it) as Map<*, *>)["type"] }.toSet()
        assertEquals(setOf("hello", "screen", "frames", "heartbeat"), types)
    }

    @Test
    fun helloDefaultsToCurrentProtocolAndSdkVersion() {
        val hello = TestJson.parse(
            DeviceMessages.hello("a.b", "a.b", 1, 23, 5L, 60.0)
        ) as Map<*, *>
        assertEquals(DEVICE_PROTOCOL_VERSION.toDouble(), hello["protocolVersion"])
        assertEquals(Lionscope.VERSION, hello["sdkVersion"])
    }

    @Test
    fun goldenFixtureHasAFramesLineWithDroppedFrames() {
        assertTrue(goldenLines.any { (TestJson.parse(it) as Map<*, *>).containsKey("droppedFrames") })
    }

    @Test
    fun zeroDroppedFramesIsOmitted() {
        val json = TestJson.parse(DeviceMessages.frames("w", 16.667, emptyList(), droppedFrames = 0)) as Map<*, *>
        assertEquals(listOf("type", "window", "intervalMs", "frames"), json.keys.toList())
    }

    private fun encode(message: Map<*, *>): String = when (message["type"]) {
        "hello" -> DeviceMessages.hello(
            packageName = message.str("packageName"),
            processName = message.str("processName"),
            pid = message.num("pid").toInt(),
            apiLevel = message.num("apiLevel").toInt(),
            deviceWallMs = message.num("deviceWallMs").toLong(),
            refreshRateHz = message.num("refreshRateHz"),
            protocolVersion = message.num("protocolVersion").toInt(),
            sdkVersion = message.str("sdkVersion"),
        )
        "screen" -> DeviceMessages.screen(message.num("ts").toLong(), (message["screen"] as Map<*, *>?)?.toScreenRef())
        "frames" -> DeviceMessages.frames(
            window = message.str("window"),
            intervalMs = message.num("intervalMs"),
            frames = (message["frames"] as List<*>).map { (it as Map<*, *>).toFrame() },
            droppedFrames = (message["droppedFrames"] as Double?)?.toInt() ?: 0,
        )
        "heartbeat" -> DeviceMessages.heartbeat(message.num("ts").toLong(), message.num("droppedMessages").toInt())
        else -> error("Unknown type in golden line: $message")
    }

    private fun Map<*, *>.toScreenRef() = ScreenRef(
        name = str("name"),
        className = str("className"),
        kind = ScreenKind.values().single { it.wire == str("kind") },
    )

    private fun Map<*, *>.toFrame() = SdkFrame(
        ts = num("ts").toLong(),
        totalMs = num("totalMs"),
        inputMs = num("inputMs"),
        animationMs = num("animationMs"),
        layoutMs = num("layoutMs"),
        drawMs = num("drawMs"),
        syncMs = num("syncMs"),
        commandMs = num("commandMs"),
        swapMs = num("swapMs"),
        delayMs = num("delayMs"),
        gpuMs = this["gpuMs"] as Double?,
        deadlineMs = this["deadlineMs"] as Double?,
        firstDraw = this["firstDraw"] as Boolean,
    )

    private fun Map<*, *>.str(key: String) = this[key] as String
    private fun Map<*, *>.num(key: String) = this[key] as Double
}
