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

    /** Protocol version agreed in the current connection's `welcome`; null while not welcomed. */
    val negotiatedVersion: Int?

    fun onScreen(ts: Long, screen: ScreenRef?)

    fun setForeground(foreground: Boolean)

    /** [listener] is called on a link thread; it must only hand off (e.g. post to the main thread). */
    fun addWelcomeListener(listener: (welcomed: Boolean) -> Unit)

    /** v2 options from each `config` on a v2 link; called on a link thread, it must only hand off. */
    fun addConfigListener(listener: (SdkOptions) -> Unit)

    /** Each `inspect` request id on a v4 link; called on a link thread, it must only hand off. */
    fun addInspectListener(listener: (requestId: Int) -> Unit)

    /**
     * Queues a v2 message, encoded later on the link thread by [encode] (null = nothing to send). Dropped unless the
     * current connection negotiated v2, checked again when it is written. [sizeHint] ≈ its encoded length.
     */
    fun sendV2(sizeHint: Int, encode: () -> String?)

    /** [sendV2] for v3 messages: dropped unless the connection negotiated v3. */
    fun sendV3(sizeHint: Int, encode: () -> String?)

    /** [sendV2] for v4 messages: dropped unless the connection negotiated v4. */
    fun sendV4(sizeHint: Int, encode: () -> String?)
}
