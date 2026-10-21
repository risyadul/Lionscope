package io.github.risyadul.lionscope.sample

import android.content.Context
import java.io.File
import java.io.IOException

/** Deliberately bad main-thread work, so Lionscope's stall and StrictMode reports point at a line in app code. */
object SlowWork {
    private const val BLOCK_MS = 400L
    private const val FILE_NAME = "slow-work.txt"

    @Volatile
    private var file: File? = null

    fun blockMainThread() {
        Thread.sleep(BLOCK_MS)
    }

    /** Resolves and writes the file off the main thread, so that only the read below is a StrictMode violation. */
    fun prepareFile(context: Context) {
        val app = context.applicationContext
        Thread {
            val target = File(app.filesDir, FILE_NAME)
            try {
                if (!target.exists()) target.writeText("Lionscope sample: read on the main thread.\n")
                file = target
            } catch (e: IOException) {
                // The read button then reports 0 bytes.
            }
        }.start()
    }

    /** A synchronous disk read on the calling (main) thread; returns the number of bytes read. */
    fun readFileOnMainThread(): Int {
        val target = file ?: return 0
        return try {
            target.readBytes().size
        } catch (e: IOException) {
            0
        }
    }
}
