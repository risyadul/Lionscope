package io.github.risyadul.lionscope

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** Reads server lines on its own daemon thread; calls [onClosed] on EOF or any failure. */
internal class GatewayReader(
    private val input: InputStream,
    private val onMessage: (GatewayMessage) -> Unit,
    private val onClosed: () -> Unit,
) {
    fun start() {
        val thread = Thread(::readLoop, "lionscope-link-reader")
        thread.isDaemon = true
        thread.start()
    }

    /** Runs until EOF or failure; never throws. Lines longer than [MAX_LINE_BYTES] are skipped. */
    internal fun readLoop() {
        try {
            lowerThreadPriority()
            val stream = input.buffered()
            val line = ByteArrayOutputStream(128)
            var oversized = false
            while (true) {
                val b = stream.read()
                if (b < 0) break
                if (b == '\n'.code) {
                    if (!oversized) GatewayMessage.parse(line.toString("UTF-8"))?.let(onMessage)
                    line.reset()
                    oversized = false
                } else if (line.size() < MAX_LINE_BYTES) {
                    line.write(b)
                } else {
                    oversized = true
                }
            }
        } catch (t: Throwable) {
            // Socket closed by either side, or anything else: the reader just ends.
        } finally {
            try {
                onClosed()
            } catch (t: Throwable) {
                // Nothing left to do on this thread.
            }
        }
    }

    internal companion object {
        const val MAX_LINE_BYTES = 8 * 1024
    }
}
