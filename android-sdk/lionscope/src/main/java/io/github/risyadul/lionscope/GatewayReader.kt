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

    /**
     * Runs until EOF or failure; never throws. Lines longer than [MAX_GATEWAY_LINE_BYTES] are skipped. The buffer of a
     * long line (a `mock` with a large body) is released once it was handled.
     */
    internal fun readLoop() {
        try {
            lowerThreadPriority()
            val stream = input.buffered()
            var line = ByteArrayOutputStream(INITIAL_LINE_BYTES)
            var oversized = false
            while (true) {
                val b = stream.read()
                if (b < 0) break
                if (b == '\n'.code) {
                    if (!oversized) GatewayMessage.parse(line.toString("UTF-8"))?.let(onMessage)
                    if (oversized || line.size() > RETAINED_LINE_BYTES) {
                        line = ByteArrayOutputStream(INITIAL_LINE_BYTES)
                    } else {
                        line.reset()
                    }
                    oversized = false
                } else if (line.size() < MAX_GATEWAY_LINE_BYTES) {
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
        const val INITIAL_LINE_BYTES = 128
        /** A line buffer that grew past this is dropped after its line instead of being kept for the next one. */
        const val RETAINED_LINE_BYTES = 16 * 1024
    }
}
