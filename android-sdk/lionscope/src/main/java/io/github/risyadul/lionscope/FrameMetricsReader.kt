package io.github.risyadul.lionscope

import android.os.Build
import android.view.FrameMetrics
import androidx.annotation.RequiresApi

private const val NANOS_PER_MS = 1_000_000.0
private const val MAX_DURATION_MS = 3_600_000.0

/** FrameMetrics nanoseconds → ms, clamped to [0, 1 h] (negative / garbage values from the platform). */
internal fun durationMs(nanos: Long): Double = (nanos / NANOS_PER_MS).coerceIn(0.0, MAX_DURATION_MS)

/** Maps a System.nanoTime() vsync timestamp to wall-clock ms, given a (nanoNow, wallNowMs) pair sampled together. */
internal fun vsyncToWall(nanoNow: Long, wallNowMs: Long, vsyncNs: Long): Long =
    wallNowMs - Math.round((nanoNow - vsyncNs) / NANOS_PER_MS)

/** Frame budget for a display refresh rate; non-positive or absurd rates fall back to 60 Hz. */
internal fun frameIntervalMs(refreshRateHz: Float): Double {
    val rate = if (refreshRateHz >= 1f && refreshRateHz <= 1000f) refreshRateHz.toDouble() else DEFAULT_REFRESH_RATE_HZ
    return 1000.0 / rate
}

@RequiresApi(24)
internal object FrameMetricsReader {

    fun read(metrics: FrameMetrics, wallNowMs: Long, nanoNow: Long): SdkFrame {
        val ts = if (Build.VERSION.SDK_INT >= 26) {
            vsyncToWall(nanoNow, wallNowMs, metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP))
        } else {
            wallNowMs
        }
        val api31 = Build.VERSION.SDK_INT >= 31
        return SdkFrame(
            ts = ts,
            totalMs = metrics.ms(FrameMetrics.TOTAL_DURATION),
            inputMs = metrics.ms(FrameMetrics.INPUT_HANDLING_DURATION),
            animationMs = metrics.ms(FrameMetrics.ANIMATION_DURATION),
            layoutMs = metrics.ms(FrameMetrics.LAYOUT_MEASURE_DURATION),
            drawMs = metrics.ms(FrameMetrics.DRAW_DURATION),
            syncMs = metrics.ms(FrameMetrics.SYNC_DURATION),
            commandMs = metrics.ms(FrameMetrics.COMMAND_ISSUE_DURATION),
            swapMs = metrics.ms(FrameMetrics.SWAP_BUFFERS_DURATION),
            delayMs = metrics.ms(FrameMetrics.UNKNOWN_DELAY_DURATION),
            gpuMs = if (api31) metrics.ms(FrameMetrics.GPU_DURATION) else null,
            deadlineMs = if (api31) metrics.ms(FrameMetrics.DEADLINE) else null,
            firstDraw = metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L,
        )
    }

    private fun FrameMetrics.ms(id: Int): Double = durationMs(getMetric(id))
}
