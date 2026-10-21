package io.github.risyadul.lionscope

import android.os.Process

/** The link threads run at background priority so they never compete with the app's UI work. */
internal fun lowerThreadPriority() {
    try {
        Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND)
    } catch (e: RuntimeException) {
        // Best effort.
    }
}
