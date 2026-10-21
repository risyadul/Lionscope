package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private class DiskReadViolation(message: String?) : Throwable(message)

class DiagnosticsSinkTest {

    private val link = FakeLink()
    private var topActivity: String? = "com.example.shop.ui.MainActivity"
    private val sink = DiagnosticsSink(link, AppOwnership("com.example.shop")) { topActivity }

    private fun sent(): Map<*, *> = TestJson.parse(link.v2Lines.single()) as Map<*, *>

    private fun framesOf(message: Map<*, *>) = (message["frames"] as List<*>).map { it as Map<*, *> }

    @Test
    fun encodesAStallWithAppFramesFlaggedAndSdkFramesDropped() {
        val stack = arrayOf(
            StackTraceElement("java.lang.Thread", "sleep", null, -2),
            StackTraceElement("io.github.risyadul.lionscope.StallDetector", "step", "MainThreadWatchdog.kt", 1),
            StackTraceElement("com.example.shop.ui.home.HomeViewModel", "mapItems", "HomeViewModel.kt", 87),
            StackTraceElement("android.os.Looper", "loop", "Looper.java", 317),
        )
        sink.stall(StallDetector.Stall(1_000, 342.5, stack, stackCut = false, samples = 6, screen = "homepage", debugger = true))

        val message = sent()
        assertEquals("stall", message["type"])
        assertEquals(342.5, message["durationMs"])
        assertEquals(6.0, message["samples"])
        assertEquals(false, message["truncated"])
        assertEquals("homepage", message["screen"])
        assertEquals(true, message["debugger"])
        val frames = framesOf(message)
        assertEquals(
            listOf(
                "java.lang.Thread",
                "io.github.risyadul.lionscope.Lionscope",
                "com.example.shop.ui.home.HomeViewModel",
                "android.os.Looper",
            ),
            frames.map { it["className"] },
        )
        assertEquals("(sdk)", frames[1]["method"])
        assertEquals(listOf(false, false, true, false), frames.map { it["inApp"] })
        assertEquals(-2.0, frames[0]["line"])
    }

    @Test
    fun aDeepStallStackIsTruncatedAndTheLineStaysWithinTheLimit() {
        val stack = (0 until 200).map { StackTraceElement("com.example.shop.C$it", "m", "C.kt", it) }.toTypedArray()
        sink.stall(StallDetector.Stall(1, 200.0, stack, stackCut = false, samples = 4, screen = null, debugger = false))
        val message = sent()
        assertEquals(true, message["truncated"])
        assertEquals(MAX_STACK_FRAMES, framesOf(message).size)
        assertTrue(link.v2Lines.single().toByteArray(Charsets.UTF_8).size <= MAX_DEVICE_LINE_BYTES)
    }

    @Test
    fun aStackTheSamplerCutIsSentTruncated() {
        val stack = stackOf("com.example.shop.A.a", "com.example.shop.B.b")
        sink.stall(StallDetector.Stall(1, 200.0, stack, stackCut = true, samples = 4, screen = null, debugger = false))
        assertEquals(true, sent()["truncated"])
    }

    @Test
    fun encodingIsDeferredToTheLinkThread() {
        val deferred = ArrayList<() -> String?>()
        val lazyLink = object : LinkPort by link {
            override fun sendV2(sizeHint: Int, encode: () -> String?) {
                assertTrue(sizeHint > 0)
                deferred += encode
            }
        }
        topActivity = null // As seen when queued...
        val lazySink = DiagnosticsSink(lazyLink, AppOwnership("org.acme")) { topActivity }
        lazySink.stall(StallDetector.Stall(1, 200.0, stackOf("com.example.shop.A.a"), false, 4, null, false))
        topActivity = "com.example.shop.ui.MainActivity" // ...and when encoded: this one counts.
        val frames = framesOf(TestJson.parse(checkNotNull(deferred.single()())) as Map<*, *>)
        assertEquals(true, frames.single()["inApp"])
    }

    @Test
    fun encodesAStrictModeViolationWithItsSimpleNameCappedMessageAndCount() {
        val violation = DiskReadViolation("x".repeat(300))
        violation.stackTrace = arrayOf(
            StackTraceElement("android.os.StrictMode\$AndroidBlockGuardPolicy", "onReadFromDisk", "StrictMode.java", 1680),
            StackTraceElement("com.example.shop.data.PrefsCache", "load", "PrefsCache.kt", 23),
        )
        topActivity = null // Backgrounded by the time it is encoded: only the application id counts.
        sink.strictMode(ViolationEvent(StrictModePolicy.THREAD, violation, 5_000, "homepage"), count = 3)

        val message = sent()
        assertEquals(
            listOf("type", "ts", "policy", "violation", "message", "frames", "count", "screen"),
            message.keys.toList(),
        )
        assertEquals("thread", message["policy"])
        assertEquals("DiskReadViolation", message["violation"])
        assertEquals(256, (message["message"] as String).length)
        assertEquals(3.0, message["count"])
        assertEquals(5_000.0, message["ts"])
        assertEquals(listOf(false, true), framesOf(message).map { it["inApp"] })
    }

    @Test
    fun anAnonymousViolationClassIsSentAsViolation() {
        val anonymous = object : Throwable("custom slow call\n\tin app") {}
        assertEquals("", anonymous.javaClass.simpleName)
        sink.strictMode(ViolationEvent(StrictModePolicy.THREAD, anonymous, 1, "home\u200E"), count = 1)
        val message = sent()
        assertEquals("Violation", message["violation"])
        assertEquals("custom slow call in app", message["message"])
        assertEquals("home", message["screen"])
    }

    @Test
    fun aViolationWithoutMessageSendsNull() {
        val violation = DiskReadViolation(null)
        sink.strictMode(ViolationEvent(StrictModePolicy.VM, violation, 1, null), count = 1)
        val message = sent()
        assertEquals("vm", message["policy"])
        assertEquals(null, message["message"])
        assertEquals(null, message["screen"])
    }
}
