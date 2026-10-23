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
        assertEquals(
            setOf(
                "hello", "screen", "frames", "heartbeat", "stall", "strictmode", "inflate", "viewtree",
                "inspectBegin", "inspectNodes", "inspectError", "httpRequest", "httpResponse", "mocksApplied",
            ),
            types,
        )
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
    fun helloAnnouncesProtocolVersionSeven() {
        assertEquals(7, DEVICE_PROTOCOL_VERSION)
        assertEquals(DEVICE_PROTOCOL_V7, DEVICE_PROTOCOL_VERSION)
    }

    @Test
    fun aDestinationIsAFragmentToServersBelowV6() {
        val destination = ScreenRef("product/{id}", "product/{id}?tab={tab}", ScreenKind.DESTINATION)
        fun kind(version: Int?) = ((TestJson.parse(DeviceMessages.screen(1, destination, version)) as Map<*, *>)["screen"] as Map<*, *>)["kind"]
        assertEquals("fragment", kind(4))
        assertEquals("fragment", kind(null))
        assertEquals("destination", kind(6))
        val dialog = ScreenRef("promo", "promo", ScreenKind.DIALOG)
        assertEquals("dialog", ((TestJson.parse(DeviceMessages.screen(1, dialog, 4)) as Map<*, *>)["screen"] as Map<*, *>)["kind"])
    }

    @Test
    fun aViewNodeHasNoComposeFieldsAndAComposableHasNoViewFields() {
        val view = TestJson.parse(DeviceMessages.inspectNode(InspectorFixtures.plainNode(0, null))) as Map<*, *>
        assertFalse(view.containsKey("composable") || view.containsKey("composition") || view.containsKey("destination"))
        val composable = InspectorFixtures.plainNode(1, 0, className = "Button").copy(
            alpha = null,
            padding = null,
            layoutWidth = null,
            layoutHeight = null,
            composable = ComposableSource("HomeScreen.kt\n", 0),
            destination = " \u200E ",
        )
        val node = TestJson.parse(DeviceMessages.inspectNode(composable)) as Map<*, *>
        assertServerAcceptsNode(node)
        assertEquals(null, node["alpha"])
        assertEquals(null, node["padding"])
        assertEquals(mapOf("file" to "HomeScreen.kt", "line" to null), node["composable"]) // Line 0 is unknown.
        assertFalse(node.containsKey("destination")) // Nothing left after cleaning.
        assertEquals(listOf("activity", "composable"), node.keys.toList().takeLast(2))
    }

    @Test
    fun aComposableSaysWhetherItDrawsOnlyWhenKnown() {
        val box = InspectorFixtures.plainNode(1, 0, className = "Box")
        fun composable(draws: Boolean?): Any? {
            val node = box.copy(composable = ComposableSource("ShopApp.kt", 41, draws))
            return (TestJson.parse(DeviceMessages.inspectNode(node)) as Map<*, *>)["composable"]
        }
        assertEquals(mapOf("file" to "ShopApp.kt", "line" to 41.0, "draws" to false), composable(false))
        assertEquals(mapOf("file" to "ShopApp.kt", "line" to 41.0, "draws" to true), composable(true))
        assertEquals(mapOf("file" to "ShopApp.kt", "line" to 41.0), composable(null))
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

    /** The server's v3 rules: strings ≤ 200, counts ≤ 1e6, ms ≤ 60 000, path ≤ 64 nodes, classes ≤ 10. */
    private fun assertServerAcceptsV3(line: String) {
        val message = TestJson.parse(line) as Map<*, *>
        val badChars = Regex("[\\p{Cc}\\p{Cf}]")
        fun text(value: Any?, nullable: Boolean) {
            if (value == null) {
                assertTrue("null text in $line", nullable)
                return
            }
            value as String
            assertTrue(value.isNotEmpty() && value.length <= 200 && value.trim() == value)
            assertFalse(badChars.containsMatchIn(value))
        }
        fun count(value: Any?, min: Double = 0.0) = assertTrue("$value in $line", (value as Double) in min..1e6)
        text(message["screen"], nullable = true)
        when (message["type"]) {
            "inflate" -> {
                text(message["layout"], nullable = true)
                text(message["label"], nullable = message["layout"] != null)
                if (message["layout"] != null) assertEquals(null, message["label"])
                assertTrue(message["library"] is Boolean && message["nested"] is Boolean)
                count(message["count"], min = 1.0)
                count(message["views"])
                assertTrue((message["totalMs"] as Double) in 0.0..60_000.0)
                assertTrue((message["maxMs"] as Double) in 0.0..60_000.0)
            }
            "viewtree" -> {
                text(message["window"], nullable = false)
                count(message["views"])
                count(message["viewGroups"])
                count(message["maxDepth"])
                val path = (message["deepestPath"] as List<*>).map { it as Map<*, *> }
                assertTrue(path.size <= MAX_VIEW_PATH_NODES)
                path.forEach {
                    text(it["className"], nullable = false)
                    text(it["id"], nullable = true)
                }
                val classes = (message["topClasses"] as List<*>).map { it as Map<*, *> }
                assertTrue(classes.size <= MAX_VIEW_TREE_CLASSES)
                classes.forEach {
                    text(it["className"], nullable = false)
                    count(it["count"], min = 1.0)
                }
            }
            else -> error("not a v3 message: $line")
        }
    }

    @Test
    fun goldenV3LinesMeetTheServerRules() {
        goldenLines.filter { (TestJson.parse(it) as Map<*, *>)["type"] in setOf("inflate", "viewtree") }
            .forEach(::assertServerAcceptsV3)
    }

    @Test
    fun v3EncodersCleanTextAndClampNumbers() {
        val named = DeviceMessages.inflate(1, "fragment_home", "ignored", false, false, "\u200Ehome\n", 0, 70_000.0, -1.0, -5)
        assertServerAcceptsV3(named)
        val namedJson = TestJson.parse(named) as Map<*, *>
        assertEquals(null, namedJson["label"]) // A label is only sent without a layout name.
        assertEquals("home", namedJson["screen"])
        assertEquals(listOf(1.0, 60_000.0, 0.0, 0.0), listOf("count", "totalMs", "maxMs", "views").map { namedJson[it] })

        val unnamed = TestJson.parse(DeviceMessages.inflate(1, "\n", null, false, true, null, 2, 1.0, 1.0, 1)) as Map<*, *>
        assertEquals(null, unnamed["layout"])
        assertEquals("?", unnamed["label"]) // Required when the layout is unknown.
        assertEquals(true, unnamed["nested"])
        assertEquals(listOf("library", "nested", "screen"), unnamed.keys.toList().subList(4, 7))
        assertServerAcceptsV3(DeviceMessages.inflate(1, "l".repeat(300), null, true, false, "s".repeat(300), 5_000_000, 1.0, 1.0, 9_000_000))

        val tree = DeviceMessages.viewTree(
            ts = 1,
            screen = null,
            window = "\n",
            views = 2_000_000,
            viewGroups = -1,
            maxDepth = 70,
            deepestPath = List(70) { ViewPathNode(if (it == 69) "Leaf" else "Group$it", if (it == 69) "\u200E" else null) },
            topClasses = List(12) { ClassCount("C$it", 12 - it) },
        )
        assertServerAcceptsV3(tree)
        val treeJson = TestJson.parse(tree) as Map<*, *>
        assertEquals("?", treeJson["window"])
        val path = (treeJson["deepestPath"] as List<*>).map { it as Map<*, *> }
        assertEquals(MAX_VIEW_PATH_NODES, path.size)
        assertEquals("Group6", path.first()["className"]) // Cut at the root end.
        assertEquals(mapOf("className" to "Leaf", "id" to null), path.last())
    }

    @Test
    fun viewTreePathNamesAreCappedSoLongCjkNamesStillFitOneLine() {
        val cjk = "视图".repeat(100) // 200 chars, 3 UTF-8 bytes each.
        val line = DeviceMessages.viewTree(
            ts = 1,
            screen = cjk,
            window = cjk,
            views = 1,
            viewGroups = 1,
            maxDepth = 64,
            deepestPath = List(64) { ViewPathNode(cjk + it, cjk) },
            topClasses = List(10) { ClassCount(cjk + it, 1) },
        )
        assertTrue(line.toByteArray(Charsets.UTF_8).size <= MAX_DEVICE_LINE_BYTES)
        assertServerAcceptsV3(line)
        val path = ((TestJson.parse(line) as Map<*, *>)["deepestPath"] as List<*>).map { it as Map<*, *> }
        assertEquals(64, path.size)
        assertTrue(path.all { (it["className"] as String).length <= 80 && (it["id"] as String).length <= 80 })
    }

    @Test
    fun anOversizedViewTreeDropsRootEndPathNodesUntilItFits() {
        val cjk = "视图".repeat(40)
        val path = List(64) { ViewPathNode("N$it$cjk", cjk) }
        val full = DeviceMessages.viewTree(1, null, "MainActivity", 1, 1, 64, path, emptyList())
        assertTrue(full.toByteArray(Charsets.UTF_8).size > 8 * 1024)
        val line = DeviceMessages.viewTree(1, null, "MainActivity", 1, 1, 64, path, emptyList(), maxLineBytes = 8 * 1024)
        assertTrue(line.toByteArray(Charsets.UTF_8).size <= 8 * 1024)
        val sent = ((TestJson.parse(line) as Map<*, *>)["deepestPath"] as List<*>).map { (it as Map<*, *>)["className"] as String }
        assertTrue(sent.size in 1 until 64)
        assertTrue(sent.last().startsWith("N63")) // The deepest nodes are kept.
        assertEquals((64 - sent.size until 64).map { "N$it" }, sent.map { it.takeWhile { c -> c.code < 128 } })
    }

    @Test
    fun goldenInspectorNodesAreChunkedIntoTheGoldenLine() {
        val goldens = goldenLines.filter { (TestJson.parse(it) as Map<*, *>)["type"] == "inspectNodes" }
        assertEquals(3, goldens.size) // A v4 (views) and two v6 (Compose) ones, the second with draws.
        for (golden in goldens) {
            val message = TestJson.parse(golden) as Map<*, *>
            val nodes = (message["nodes"] as List<*>).map { InspectorFixtures.node(it as Map<*, *>) }
            assertEquals(listOf(golden), DeviceMessages.inspectChunks((message["requestId"] as Double).toInt(), nodes))
        }
    }

    /** The server's v4 rules (protocol/src/index.ts): text ≤ 500 / names ≤ 200, pixels ±100 000, line ≥ 1. */
    private fun assertServerAcceptsNode(node: Map<*, *>) {
        val badChars = Regex("[\\p{Cc}\\p{Cf}]")
        fun text(key: String, max: Int, nullable: Boolean = true) {
            val value = node[key]
            if (value == null) {
                assertTrue("$key null in $node", nullable)
                return
            }
            value as String
            assertTrue("$key: $value", value.isNotEmpty() && value.length <= max && value.trim() == value)
            assertFalse("$key: $value", badChars.containsMatchIn(value))
        }
        fun rect(key: String) {
            val value = node[key] as List<*>? ?: return
            assertEquals(4, value.size)
            value.forEach { assertTrue("$key: $value", (it as Double) == Math.floor(it) && Math.abs(it) <= 100_000) }
        }
        text("className", 200, nullable = false)
        text("resourceId", 200)
        text("text", 500)
        text("contentDescription", 500)
        text("fragment", 200)
        text("activity", 200)
        listOf("bounds", "visibleBounds", "padding", "margin").forEach(::rect)
        (node["alpha"] as Double?)?.let { assertTrue(it in 0.0..1.0) }
        text("destination", 200)
        (node["composable"] as Map<*, *>?)?.let { composable ->
            assertEquals(listOf("file", "line"), composable.keys.toList().take(2))
            assertTrue(composable.keys.size == 2 || (composable.keys.size == 3 && composable["draws"] is Boolean))
            (composable["file"] as String?)?.let { assertTrue(it.isNotEmpty() && it.length <= 200) }
            (composable["line"] as Double?)?.let { assertTrue(it >= 1) }
        }
        (node["composition"] as String?)?.let { assertTrue(it in setOf("read", "disabled", "no_source", "failed")) }
        for (key in listOf("layoutWidth", "layoutHeight")) {
            val value = node[key] as String? ?: continue
            assertTrue(value, Regex("^(match_parent|wrap_content|-?\\d{1,6}px)$").matches(value))
        }
        (node["source"] as Map<*, *>?)?.let { source ->
            assertTrue((source["line"] as Double) >= 1)
            val layout = source["layout"] as String
            assertTrue(layout.isNotEmpty() && layout.length <= 200)
        }
    }

    @Test
    fun inspectorNodesAreCleanedCappedAndClamped() {
        val dirty = InspectorFixtures.plainNode(3, 1).copy(
            className = "\n",
            resourceId = "r".repeat(300),
            text = "Hello\n\tworld \u200E" + "x".repeat(800),
            contentDescription = "\u0000",
            bounds = PixelRect(-200_000, 0, 200_000, 50),
            alpha = 1.7,
            margin = PixelRect(1, 2, 3, 4),
            layoutWidth = "12345678px",
            layoutHeight = "fill",
            source = ViewSource("fragment_home", 0),
            fragment = "f".repeat(250),
        )
        val node = TestJson.parse(DeviceMessages.inspectNode(dirty)) as Map<*, *>
        assertServerAcceptsNode(node)
        assertEquals("?", node["className"])
        assertEquals(500, (node["text"] as String).length)
        assertTrue((node["text"] as String).startsWith("Hello world x"))
        assertEquals(null, node["contentDescription"])
        assertEquals(listOf(-100_000.0, 0.0, 100_000.0, 50.0), node["bounds"])
        assertEquals(1.0, node["alpha"])
        assertEquals(null, node["layoutWidth"])
        assertEquals(null, node["layoutHeight"])
        assertEquals(null, node["source"]) // Line 0 is unknown.
        assertEquals(listOf(1.0, 2.0, 3.0, 4.0), node["margin"])
        assertEquals(
            listOf("match_parent", "wrap_content", "12px", "-999999px", "999999px"),
            listOf(-1, -2, 12, -5_000_000, 5_000_000).map(DeviceMessages::layoutDimension),
        )
    }

    @Test
    fun inspectBeginKeepsTheDisplayAndWindowsWithinTheServerBounds() {
        val line = DeviceMessages.inspectBegin(
            requestId = 1,
            ts = 5,
            screen = "\u200E",
            display = InspectorDisplay(0, 40_000, 450),
            windows = List(40) { InspectorWindow(it, if (it == 0) 99_999 else 2, PixelRect(0, 0, 10, 10)) },
            nodeCount = 9_000,
            truncated = true,
            captureMs = Double.NaN,
            compose = false,
        )
        val begin = TestJson.parse(line) as Map<*, *>
        assertEquals(null, begin["screen"])
        assertEquals(mapOf("width" to 1.0, "height" to 20_000.0, "rotation" to 90.0), begin["display"])
        val windows = (begin["windows"] as List<*>).map { it as Map<*, *> }
        assertEquals(MAX_INSPECTOR_WINDOWS, windows.size)
        assertEquals(null, windows.first()["type"])
        assertEquals(5_000.0, begin["nodeCount"])
        assertEquals(0.0, begin["captureMs"])
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
        "inflate" -> DeviceMessages.inflate(
            ts = message.num("ts").toLong(),
            layout = message["layout"] as String?,
            label = message["label"] as String?,
            library = message["library"] as Boolean,
            nested = message["nested"] as Boolean,
            screen = message["screen"] as String?,
            count = message.num("count").toInt(),
            totalMs = message.num("totalMs"),
            maxMs = message.num("maxMs"),
            views = message.num("views").toInt(),
        )
        "viewtree" -> DeviceMessages.viewTree(
            ts = message.num("ts").toLong(),
            screen = message["screen"] as String?,
            window = message.str("window"),
            views = message.num("views").toInt(),
            viewGroups = message.num("viewGroups").toInt(),
            maxDepth = message.num("maxDepth").toInt(),
            deepestPath = (message["deepestPath"] as List<*>).map {
                val node = it as Map<*, *>
                ViewPathNode(node.str("className"), node["id"] as String?)
            },
            topClasses = (message["topClasses"] as List<*>).map {
                val entry = it as Map<*, *>
                ClassCount(entry.str("className"), entry.num("count").toInt())
            },
        )
        "inspectBegin" -> {
            val display = message["display"] as Map<*, *>
            DeviceMessages.inspectBegin(
                requestId = message.num("requestId").toInt(),
                ts = message.num("ts").toLong(),
                screen = message["screen"] as String?,
                display = InspectorDisplay(display.num("width").toInt(), display.num("height").toInt(), display.num("rotation").toInt()),
                windows = (message["windows"] as List<*>).map { InspectorFixtures.window(it as Map<*, *>) },
                nodeCount = message.num("nodeCount").toInt(),
                truncated = message["truncated"] as Boolean,
                captureMs = message.num("captureMs"),
                compose = message["compose"] as Boolean,
            )
        }
        "inspectNodes" -> DeviceMessages.inspectNodes(
            requestId = message.num("requestId").toInt(),
            seq = message.num("seq").toInt(),
            last = message["last"] as Boolean,
            nodes = (message["nodes"] as List<*>).map { DeviceMessages.inspectNode(InspectorFixtures.node(it as Map<*, *>)) },
        )
        "inspectError" -> DeviceMessages.inspectError(
            requestId = message.num("requestId").toInt(),
            reason = InspectError.values().single { it.wire == message.str("reason") },
        )
        "httpRequest" -> checkNotNull(
            HttpMessages.httpRequest(
                id = message.num("id").toInt(),
                ts = message.num("ts").toLong(),
                method = message.str("method"),
                url = message.str("url"),
                headers = message.httpHeaders(),
                body = (message["body"] as Map<*, *>?)?.toHttpBody(),
                mockId = message["mockId"] as String?,
                dropped = message.num("dropped").toInt(),
            ),
        )
        "httpResponse" -> HttpMessages.httpResponse(
            id = message.num("id").toInt(),
            ts = message.num("ts").toLong(),
            status = (message["status"] as Double?)?.toInt(),
            protocol = message["protocol"] as String?,
            headers = message.httpHeaders(),
            body = (message["body"] as Map<*, *>?)?.toHttpBody(),
            headersMs = message["headersMs"] as Double?,
            durationMs = message.num("durationMs"),
            error = (message["error"] as Map<*, *>?)?.let { error ->
                HttpFailure(HttpFailureKind.values().single { it.wire == error.str("kind") }, error["message"] as String?)
            },
        )
        "mocksApplied" -> HttpMessages.mocksApplied(message.num("rev").toInt(), message.num("count").toInt())
        else -> error("Unknown type in golden line: $message")
    }

    private fun Map<*, *>.httpHeaders() = (this["headers"] as List<*>).map {
        val pair = it as List<*>
        pair[0] as String to pair[1] as String
    }

    private fun Map<*, *>.toHttpBody() = HttpBody(
        size = (this["size"] as Double?)?.toLong(),
        contentType = this["contentType"] as String?,
        text = this["text"] as String?,
        truncated = this["truncated"] as Boolean,
        omitted = (this["omitted"] as String?)?.let { omitted -> HttpBodyOmission.values().single { it.wire == omitted } },
    )

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
