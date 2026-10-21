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

/** For threads that must keep running while the app is busy (the main-thread watchdog). */
internal fun defaultThreadPriority() {
    try {
        Process.setThreadPriority(Process.THREAD_PRIORITY_DEFAULT)
    } catch (e: RuntimeException) {
        // Best effort.
    }
}
