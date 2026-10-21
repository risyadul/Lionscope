package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameTimeTest {

    @Test
    fun vsyncInThePastMapsToAnEarlierWallTime() {
        // vsync happened 12.4 ms before the callback sampled (nanoNow, wallNow).
        assertEquals(1_000_000L - 12, vsyncToWall(nanoNow = 5_012_400_000, wallNowMs = 1_000_000, vsyncNs = 5_000_000_000))
    }

    @Test
    fun roundsToTheNearestMillisecond() {
        assertEquals(999_987L, vsyncToWall(nanoNow = 12_600_000, wallNowMs = 1_000_000, vsyncNs = 0))
        assertEquals(1_000_000L, vsyncToWall(nanoNow = 400_000, wallNowMs = 1_000_000, vsyncNs = 0))
    }

    @Test
    fun vsyncAtTheSampleInstantIsWallNow() {
        assertEquals(42L, vsyncToWall(nanoNow = 7, wallNowMs = 42, vsyncNs = 7))
    }

    @Test
    fun frameIntervalFollowsRefreshRate() {
        assertEquals(16.667, frameIntervalMs(60f), 0.001)
        assertEquals(8.333, frameIntervalMs(120f), 0.001)
        assertEquals(1000.0 / 90.0, frameIntervalMs(90f), 1e-4)
    }

    @Test
    fun invalidRefreshRateFallsBackToSixtyHertz() {
        assertEquals(16.667, frameIntervalMs(0f), 0.001)
        assertEquals(16.667, frameIntervalMs(-1f), 0.001)
        assertEquals(16.667, frameIntervalMs(Float.NaN), 0.001)
        assertEquals(16.667, frameIntervalMs(5000f), 0.001)
    }

    @Test
    fun durationsConvertToMillisecondsAndAreClampedToOneHour() {
        assertEquals(12.4, durationMs(12_400_000), 1e-9)
        assertEquals(0.0, durationMs(0), 0.0)
        assertEquals(0.0, durationMs(-5_000_000), 0.0)
        assertEquals(3_600_000.0, durationMs(3_600_000L * 1_000_000), 0.0)
        assertEquals(3_600_000.0, durationMs(Long.MAX_VALUE), 0.0)
    }
}
