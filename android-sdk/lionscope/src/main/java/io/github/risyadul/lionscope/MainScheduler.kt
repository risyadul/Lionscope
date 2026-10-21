package io.github.risyadul.lionscope

import android.os.Handler

/** Main-thread task posting, behind an interface so trackers can be unit-tested without a Looper. */
internal interface MainScheduler {
    fun post(task: Runnable)
    fun postDelayed(task: Runnable, delayMs: Long)
}

internal class HandlerScheduler(private val handler: Handler) : MainScheduler {
    override fun post(task: Runnable) {
        handler.post(task)
    }

    override fun postDelayed(task: Runnable, delayMs: Long) {
        handler.postDelayed(task, delayMs)
    }
}

/** What the trackers need from the device link. */
internal interface LinkPort {
    /** True between the server's `welcome` and the end of that connection. */
    val isWelcomed: Boolean

    fun onScreen(ts: Long, screen: ScreenRef?)

    fun setForeground(foreground: Boolean)

    /** [listener] is called on a link thread; it must only hand off (e.g. post to the main thread). */
    fun addWelcomeListener(listener: (welcomed: Boolean) -> Unit)
}
