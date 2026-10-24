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

    private val cutStack = (0 until 100).map { StackTraceElement("com.example.shop.C$it", "m", "C.kt", it + 1) }.toTypedArray()
    private val outer = arrayOf(
        StackTraceElement("io.github.risyadul.lionscope.RxJava2Hooks\$TrackedTask", "run", "RxJava2Hooks.kt", 9),
        StackTraceElement("android.os.Handler", "handleCallback", "Handler.java", 995),
        StackTraceElement("android.os.Looper", "loop", "Looper.java", 338),
    )

    private fun originStall() = StallDetector.Stall(
        1, 300.0, cutStack.copyOf(StackFrames.MAX_SAMPLED_ELEMENTS).requireNoNulls(), stackCut = true, samples = 4,
        screen = null, debugger = false, outer = outer, rxTask = Any(), threadName = "main @refresh#4",
    )

    @Test
    fun aV9LinkGetsTheOuterFramesTheRxChainAndTheCoroutine() {
        val rx = FakeRxTracking()
        val sink = DiagnosticsSink(link, AppOwnership("com.example.shop"), rx) { topActivity }
        link.welcome(true, DEVICE_PROTOCOL_V9)
        sink.stall(originStall())

        val message = sent()
        assertEquals(true, message["truncated"])
        val outerFrames = (message["outerFrames"] as List<*>).map { (it as Map<*, *>)["className"] }
        // The kept elements `frames` had no room for, then the outermost ones; the SDK's own wrapper collapses into its
        // stand-in frame, as in `frames`.
        assertEquals((64 until 72).map { "com.example.shop.C$it" }, outerFrames.take(8))
        assertEquals(listOf("io.github.risyadul.lionscope.Lionscope", "android.os.Handler", "android.os.Looper"), outerFrames.drop(8))
        assertEquals("java.lang.Object", (message["rx"] as Map<*, *>)["task"])
        assertEquals("refresh#4", message["coroutine"])
        assertTrue(link.v2Lines.single().toByteArray(Charsets.UTF_8).size <= MAX_DEVICE_LINE_BYTES)
    }

    @Test
    fun aV8LinkGetsTheStallAsBefore() {
        val sink = DiagnosticsSink(link, AppOwnership("com.example.shop"), FakeRxTracking()) { topActivity }
        link.welcome(true, DEVICE_PROTOCOL_V8)
        sink.stall(originStall())
        val message = sent()
        assertTrue(listOf("outerFrames", "rx", "coroutine").none { message.containsKey(it) })
        assertEquals(true, message["truncated"])
    }

    @Test
    fun aThreadNameWithoutACoroutineAndNoRxTaskSendNoOrigin() {
        val sink = DiagnosticsSink(link, AppOwnership("com.example.shop"), FakeRxTracking()) { topActivity }
        link.welcome(true, DEVICE_PROTOCOL_V9)
        val stack = stackOf("app.Work.block", "android.os.Looper.loop")
        sink.stall(StallDetector.Stall(1, 200.0, stack, false, 3, null, false, threadName = "main"))
        assertTrue(listOf("outerFrames", "rx", "coroutine").none { sent().containsKey(it) })
    }

    /** A Stall as StallDetector builds it from one sample of [stack]. */
    private fun detected(stack: Array<StackTraceElement>): StallDetector.Stall {
        val kept = StackFrames.MAX_SAMPLED_ELEMENTS
        val cut = stack.size > kept
        return StallDetector.Stall(
            1, 300.0, if (cut) stack.copyOf(kept).requireNoNulls() else stack, cut, 3, null, false,
            outer = if (cut) stack.copyOfRange(maxOf(kept, stack.size - MAX_OUTER_FRAMES), stack.size) else emptyArray(),
        )
    }

    @Test
    fun theLooperDispatchReachesTheServerWhateverTheStackDepth() {
        val sink = DiagnosticsSink(link, AppOwnership("com.example.shop")) { topActivity }
        link.welcome(true, DEVICE_PROTOCOL_V9)
        for (size in 60..120) {
            link.v2Lines.clear()
            val dispatch = listOf(
                StackTraceElement("com.example.shop.Refresh", "run", "Refresh.kt", 9),
                StackTraceElement("android.os.Handler", "handleCallback", "Handler.java", 995),
                StackTraceElement("android.os.Handler", "dispatchMessage", "Handler.java", 103),
                StackTraceElement("android.os.Looper", "loop", "Looper.java", 338),
            )
            val inner = (0 until size - dispatch.size).map { StackTraceElement("com.example.shop.C$it", "m", "C.kt", it + 1) }
            sink.stall(detected((inner + dispatch).toTypedArray()))
            val message = sent()
            val frames = framesOf(message).map { it["className"] as String }
            val outer = (message["outerFrames"] as List<*>?)?.map { (it as Map<*, *>)["className"] as String } ?: emptyList()
            val all = frames + outer
            val callback = all.indexOf("android.os.Handler")
            assertEquals("size $size", "com.example.shop.Refresh", all.getOrNull(callback - 1))
            // Up to the kept elements plus the outer ones, `frames` and `outerFrames` join without a gap.
            if (size <= MAX_STACK_FRAMES + MAX_OUTER_FRAMES) {
                assertEquals("size $size", (inner.map { it.className } + dispatch.map { it.className }), all)
            }
            assertEquals("size $size", size > MAX_STACK_FRAMES, message["truncated"])
        }
    }
}
