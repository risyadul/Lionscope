package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies that `testDebugUnitTest` runs against Compose runtime 1.6.x (proving 1.6 safety) and `testCompose19` runs
 * against Compose runtime 1.9.x (mirroring [OkHttpClasspathTest]).
 */
class ComposeClasspathTest {

    @Test
    fun theRunHasTheExpectedComposeRuntime() {
        val expectedMinor = System.getProperty("lionscope.composeRuntimeMinor") ?: "6"
        val hasObservableComposition = try {
            Class.forName("androidx.compose.runtime.tooling.ObservableComposition", false, javaClass.classLoader)
            true
        } catch (_: ClassNotFoundException) {
            false
        }
        if (expectedMinor == "9") {
            assertTrue("Expected Compose 1.9+ ObservableComposition on testCompose19 classpath", hasObservableComposition)
            assertTrue(
                "Expected probe() to succeed on Compose 1.9+",
                ComposeRecompositionSupport.probe() is ComposeRecompositionSupport.ProbeResult.Supported,
            )
        } else {
            assertEquals("6", expectedMinor)
            assertFalse("Compose 1.6.8 testDebugUnitTest must not have 1.9 ObservableComposition", hasObservableComposition)
            assertTrue(
                "Expected probe() to fail closed on Compose 1.6.8",
                ComposeRecompositionSupport.probe() is ComposeRecompositionSupport.ProbeResult.Unsupported,
            )
        }
    }
}
