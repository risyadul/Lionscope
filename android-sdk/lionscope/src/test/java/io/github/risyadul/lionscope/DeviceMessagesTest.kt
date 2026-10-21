package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals(setOf("hello", "screen", "frames", "heartbeat", "stall", "strictmode"), types)
    }

    @Test
    fun helloDefaultsToCurrentProtocolAndSdkVersion() {
        val hello = TestJson.parse(
            DeviceMessages.hello("a.b", "a.b", 1, 23, 5L, 60.0)
        ) as Map<*, *>
        assertEquals(DEVICE_PROTOCOL_VERSION.toDouble(), hello["protocolVersion"])
        assertEquals(Lionscope.VERSION, hello["sdkVersion"])
        assertEquals(builtVersion(), hello["sdkVersion"])
    }

    @Test
    fun sdkVersionIsTheGradleBuildVersion() {
        assertEquals(builtVersion(), Lionscope.VERSION)
    }

    /** `project.version` of this build (passed by lionscope/build.gradle.kts). */
    private fun builtVersion(): String = checkNotNull(System.getProperty("lionscope.version")) { "run via Gradle" }

    @Test
    fun goldenFixtureHasAFramesLineWithDroppedFrames() {
        assertTrue(goldenLines.any { (TestJson.parse(it) as Map<*, *>).containsKey("droppedFrames") })
    }

    @Test
    fun helloAnnouncesProtocolVersionTwo() {
        assertEquals(2, DEVICE_PROTOCOL_VERSION)
        assertEquals(DEVICE_PROTOCOL_V2, DEVICE_PROTOCOL_VERSION)
    }

    @Test
    fun nullableStackFieldsAreWrittenAsNull() {
        val line = DeviceMessages.stall(1, 200.0, listOf(StackFrame("a.B", "c", null, null, false)), 1, false, null, false)
        val frame = ((TestJson.parse(line) as Map<*, *>)["frames"] as List<*>).single() as Map<*, *>
        assertEquals(listOf("className", "method", "file", "line", "inApp"), frame.keys.toList())
        assertEquals(null, frame["file"])
        assertEquals(null, frame["line"])
    }

    /** The server's v2 rules (Zod schemas): any violation closes the link with `bye protocol_error`. */
    private fun assertServerAccepts(line: String) {
        val message = TestJson.parse(line) as Map<*, *>
        val badChars = Regex("[\\p{Cc}\\p{Cf}]")
        fun text(key: String, value: Any?, max: Int, nullable: Boolean) {
            if (value == null) {
                assertTrue("$key must not be null in $line", nullable)
                return
            }
            value as String
            assertTrue("$key empty in $line", value.isNotEmpty())
            assertTrue("$key too long in $line", value.length <= max)
            assertFalse("$key has control/format chars: $line", badChars.containsMatchIn(value))
            assertEquals("$key not trimmed in $line", value.trim(), value)
            assertFalse("$key has a run of spaces in $line", value.contains("  "))
        }
        val frames = message["frames"] as List<*>
        assertTrue(frames.size <= MAX_STACK_FRAMES)
        for (frame in frames.map { it as Map<*, *> }) {
            text("className", frame["className"], 256, nullable = false)
            text("method", frame["method"], 256, nullable = false)
            text("file", frame["file"], 128, nullable = true)
            val frameLine = frame["line"] as Double?
            if (frameLine != null) assertTrue(frameLine == Math.floor(frameLine) && frameLine >= -2 && frameLine <= Int.MAX_VALUE)
        }
        text("screen", message["screen"], 256, nullable = true)
        when (message["type"]) {
            "stall" -> {
                assertTrue((message["durationMs"] as Double) in 0.0..60_000.0)
                assertTrue((message["samples"] as Double) in 1.0..10_000.0)
            }
            "strictmode" -> {
                text("violation", message["violation"], 128, nullable = false)
                text("message", message["message"], 256, nullable = true)
                assertTrue((message["count"] as Double) in 1.0..1e6)
            }
            else -> error("not a v2 message: $line")
        }
    }

    private val dirtyFrames = listOf(
        StackFrame("com.example.Leaky\n", "\tclose", "", -1, true),
        StackFrame("", "\u200E", "\u200EFile.kt\n", 12, true),
        StackFrame("a".repeat(300), "m".repeat(300), "f".repeat(200), -7, false),
    ) + List(80) { StackFrame("c$it", "m", null, it, false) }

    @Test
    fun v2EncodersCleanEveryTextFieldAndClampNumbers() {
        val stall = DeviceMessages.stall(1, 75_000.0, dirtyFrames, 0, false, "\u200E\n", false)
        assertServerAccepts(stall)
        val stallJson = TestJson.parse(stall) as Map<*, *>
        assertEquals(true, stallJson["truncated"]) // More than 64 frames were passed in.
        assertEquals(null, stallJson["screen"])
        val first = (stallJson["frames"] as List<*>).map { it as Map<*, *> }
        assertEquals(listOf("com.example.Leaky", "?"), first.take(2).map { it["className"] })
        assertEquals(listOf("close", "?"), first.take(2).map { it["method"] })
        assertEquals(listOf(null, "File.kt"), first.take(2).map { it["file"] })
        assertEquals(listOf(null, 12.0, null), first.take(3).map { it["line"] }) // -1 and -7: unknown.

        val strict = DeviceMessages.strictMode(
            ts = 1,
            policy = StrictModePolicy.VM,
            violation = "\nLeakedClosableViolation\t",
            message = "A resource was acquired at attached stack trace but never released.\n\tSee java.io.Closeable",
            frames = dirtyFrames,
            count = 5_000_000,
            screen = " home\u0000tab ",
        )
        assertServerAccepts(strict)
        val strictJson = TestJson.parse(strict) as Map<*, *>
        assertEquals("LeakedClosableViolation", strictJson["violation"])
        assertEquals("home tab", strictJson["screen"])
        assertEquals(1e6, strictJson["count"])
        assertEquals(
            "A resource was acquired at attached stack trace but never released. See java.io.Closeable",
            strictJson["message"],
        )

        val empty = DeviceMessages.strictMode(1, StrictModePolicy.THREAD, "", "\n", emptyList(), 0, "")
        assertServerAccepts(empty)
        val emptyJson = TestJson.parse(empty) as Map<*, *>
        assertEquals("Violation", emptyJson["violation"])
        assertEquals(null, emptyJson["message"])
        assertEquals(1.0, emptyJson["count"])
    }

    @Test
    fun screenAliasesAndClassNamesAreCleanedWithAFallbackToTheSimpleName() {
        fun sent(name: String, className: String = "com.example.shop.ui.HomeFragment"): Map<*, *> {
            val line = DeviceMessages.screen(1, ScreenRef(name, className, ScreenKind.FRAGMENT))
            return (TestJson.parse(line) as Map<*, *>)["screen"] as Map<*, *>
        }
        assertEquals("home tab", sent("home\ntab")["name"])
        assertEquals("home", sent("\u200Ehome\u200E")["name"])
        assertEquals("HomeFragment", sent("")["name"])
        assertEquals("HomeFragment", sent(" \u200E\n ")["name"])
        assertEquals("fragment", sent("x")["kind"])
        val odd = sent("", className = "com.example.Odd\tName")
        assertEquals("com.example.Odd Name", odd["className"])
        assertEquals("Odd Name", odd["name"])
        assertEquals("?", sent("", className = "\u0007")["className"])
        assertEquals("?", sent("", className = "\u0007")["name"])
        assertEquals(256, (sent("n".repeat(400))["name"] as String).length)
    }

    @Test
    fun frameWindowNamesAreCleaned() {
        fun window(raw: String) = (TestJson.parse(DeviceMessages.frames(raw, 16.667, emptyList())) as Map<*, *>)["window"]
        assertEquals("com.example.Main Activity", window("com.example.Main\u0000Activity"))
        assertEquals("?", window("\n"))
        assertEquals(256, (window("w".repeat(300)) as String).length)
    }

    @Test
    fun goldenLinesAreReproducedByteForByte() {
        for (line in goldenLines) assertEquals(line, encode(TestJson.parse(line) as Map<*, *>))
    }

    @Test
    fun goldenV2LinesMeetTheServerRules() {
        goldenLines.filter { (TestJson.parse(it) as Map<*, *>)["type"] in setOf("stall", "strictmode") }
            .forEach(::assertServerAccepts)
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
        "stall" -> DeviceMessages.stall(
            ts = message.num("ts").toLong(),
            durationMs = message.num("durationMs"),
            frames = message.stackFrames(),
            samples = message.num("samples").toInt(),
            truncated = message["truncated"] as Boolean,
            screen = message["screen"] as String?,
            debugger = message["debugger"] as Boolean,
        )
        "strictmode" -> DeviceMessages.strictMode(
            ts = message.num("ts").toLong(),
            policy = StrictModePolicy.values().single { it.wire == message.str("policy") },
            violation = message.str("violation"),
            message = message["message"] as String?,
            frames = message.stackFrames(),
            count = message.num("count").toInt(),
            screen = message["screen"] as String?,
        )
        else -> error("Unknown type in golden line: $message")
    }

    private fun Map<*, *>.stackFrames() = (this["frames"] as List<*>).map {
        val frame = it as Map<*, *>
        StackFrame(
            className = frame.str("className"),
            method = frame.str("method"),
            file = frame["file"] as String?,
            line = (frame["line"] as Double?)?.toInt(),
            inApp = frame["inApp"] as Boolean,
        )
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
