package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.jar.JarFile

class StackFramesTest {

    private val ownership = AppOwnership("com.example.shop.debug")
    private val inApp: (String) -> Boolean = { ownership.isOwned(it, "com.example.shop.ui.MainActivity") }

    @Test
    fun mapsElementsWithLineRulesAndOwnership() {
        val stack = arrayOf(
            StackTraceElement("java.lang.Thread", "sleep", null, -2),
            StackTraceElement("com.example.shop.ui.home.HomeViewModel", "mapItems", "HomeViewModel.kt", 87),
            StackTraceElement("com.example.shop.Lambda", "invoke", "Unknown Source", -1),
            StackTraceElement("android.os.Handler", "handleCallback", "Handler.java", 959),
        )
        val mapped = StackFrames.map(stack, isInApp = inApp)
        assertFalse(mapped.truncated)
        assertEquals(
            listOf(
                StackFrame("java.lang.Thread", "sleep", null, -2, inApp = false),
                StackFrame("com.example.shop.ui.home.HomeViewModel", "mapItems", "HomeViewModel.kt", 87, inApp = true),
                StackFrame("com.example.shop.Lambda", "invoke", "Unknown Source", null, inApp = true),
                StackFrame("android.os.Handler", "handleCallback", "Handler.java", 959, inApp = false),
            ),
            mapped.frames,
        )
    }

    @Test
    fun inAppFollowsTheScreenOwnershipRule() {
        // Top activity root, application id root, and neither.
        val owned = AppOwnership("org.acme.app")
        val frames = StackFrames.map(
            stackOf("com.example.feature.Work.run", "org.acme.lib.Util.go", "com.examples.Other.run", "Default.run"),
        ) { owned.isOwned(it, "com.example.ui.MainActivity") }.frames
        assertEquals(listOf(true, true, false, false), frames.map { it.inApp })
        // No activity started: only the application id counts.
        val background = StackFrames.map(stackOf("com.example.feature.Work.run", "org.acme.lib.Util.go")) {
            owned.isOwned(it, null)
        }.frames
        assertEquals(listOf(false, true), background.map { it.inApp })
    }

    @Test
    fun collapsesEachRunOfSdkFramesButKeepsAnAppBelowItsPackage() {
        val mapped = StackFrames.map(
            stackOf(
                "io.github.risyadul.lionscope.ScreenNames.nameOf",
                "io.github.risyadul.lionscope.ScreenTracker\$emitRunnable\$1.run",
                "io.github.risyadul.lionscope.sample.SlowWork.blockMainThread",
                "io.github.risyadul.lionscope.FrameTracker.onFrame",
                "android.os.Looper.loop",
            ),
        ) { it.startsWith("io.github.") }
        assertEquals(
            listOf(
                StackFrames.SDK_FRAME,
                StackFrame("io.github.risyadul.lionscope.sample.SlowWork", "blockMainThread", "F.kt", 3, inApp = true),
                StackFrames.SDK_FRAME,
                StackFrame("android.os.Looper", "loop", "F.kt", 5, inApp = false),
            ),
            mapped.frames,
        )
        assertEquals(
            StackFrame("io.github.risyadul.lionscope.Lionscope", "(sdk)", null, null, inApp = false),
            StackFrames.SDK_FRAME,
        )
    }

    /** The SDK-frame rule relies on it: every SDK class lives directly in the SDK package, none in a sub-package. */
    @Test
    fun everySdkClassIsInTheFlatPackage() {
        val codeSource = checkNotNull(checkNotNull(Lionscope::class.java.protectionDomain).codeSource)
        val root = File(codeSource.location.toURI())
        val entries = if (root.isDirectory) {
            root.walkTopDown().filter { it.isFile }.map { it.relativeTo(root).invariantSeparatorsPath }.toList()
        } else {
            JarFile(root).use { jar -> jar.entries().toList().map { it.name } }
        }
        val sdk = entries.filter { it.startsWith("io/github/risyadul/lionscope/") && it.endsWith(".class") }
        assertTrue("no SDK classes found under $root", sdk.size > 20)
        for (entry in sdk) {
            val relative = entry.removePrefix("io/github/risyadul/lionscope/")
            assertFalse("$entry is in a sub-package", relative.contains('/'))
            assertTrue(entry, StackFrames.isSdkClass(entry.removeSuffix(".class").replace('/', '.')))
        }
    }

    @Test
    fun keepsTheInnermostSixtyFourFramesAndFlagsTruncation() {
        val stack = (0 until 100).map { StackTraceElement("app.C$it", "m", "C.kt", it) }.toTypedArray()
        val mapped = StackFrames.map(stack) { false }
        assertTrue(mapped.truncated)
        assertEquals(MAX_STACK_FRAMES, mapped.frames.size)
        assertEquals("app.C0", mapped.frames.first().className)
        assertEquals("app.C63", mapped.frames.last().className)

        val sixtyFour = stack.copyOf(MAX_STACK_FRAMES).requireNoNulls()
        assertFalse(StackFrames.map(sixtyFour) { false }.truncated)
        // A run of SDK frames counts as one (its placeholder).
        val sdk = Array(5) { StackTraceElement("io.github.risyadul.lionscope.X", "m$it", null, 1) }
        val withSdk = sdk + stack.copyOf(MAX_STACK_FRAMES - 1).requireNoNulls()
        assertFalse(StackFrames.map(withSdk) { false }.truncated)
        assertTrue(StackFrames.map(sdk + sixtyFour) { false }.truncated)
        // A stack the sampler already cut stays flagged even when it maps to fewer frames.
        assertTrue(StackFrames.map(stackOf("a.B.c"), longer = true) { false }.truncated)
    }

    @Test
    fun keepsRawTextForTheEncoderToClean() {
        val frame = StackFrames.map(arrayOf(StackTraceElement("x.A\tB", "m\n", "", 1))) { false }.frames.single()
        assertEquals(StackFrame("x.A\tB", "m\n", "", 1, false), frame)
    }

    @Test
    fun fitLineHalvesTheStackUntilTheLineFits() {
        val frames = (0 until 64).map { StackFrame("c$it", "m", null, 1, false) }
        val mapped = StackFrames.Mapped(frames, truncated = false)
        val calls = ArrayList<Pair<Int, Boolean>>()
        val line = StackFrames.fitLine(mapped) { kept, truncated ->
            calls += kept.size to truncated
            "\u00e9".repeat(kept.size * 2_000) // 2 bytes per char: 4 000 bytes per frame.
        }
        assertEquals(listOf(64 to false, 32 to true, 16 to true), calls)
        assertEquals(16 * 2_000, checkNotNull(line).length)
        assertNull(StackFrames.fitLine(StackFrames.Mapped(emptyList(), false)) { _, _ -> "x".repeat(MAX_DEVICE_LINE_BYTES + 1) })
        assertEquals("ok", StackFrames.fitLine(mapped) { _, _ -> "ok" })
    }
}
