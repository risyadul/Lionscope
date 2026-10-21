package io.github.risyadul.lionscope

import java.util.ArrayDeque

/** Main-thread stand-in: tasks run only when the test says so. */
internal class FakeScheduler : MainScheduler {
    private val posted = ArrayDeque<Runnable>()
    val delayed = ArrayList<Pair<Runnable, Long>>()

    override fun post(task: Runnable) {
        posted.addLast(task)
    }

    override fun postDelayed(task: Runnable, delayMs: Long) {
        delayed += task to delayMs
    }

    val pendingCount: Int
        get() = posted.size

    fun runPosted() {
        while (posted.isNotEmpty()) posted.pollFirst()!!.run()
    }

    fun runDelayed() {
        val due = delayed.toList()
        delayed.clear()
        due.forEach { it.first.run() }
        runPosted()
    }
}

internal class FakeLink : LinkPort {
    private val listeners = ArrayList<(Boolean) -> Unit>()
    val screens = ArrayList<ScreenRef?>()
    val foreground = ArrayList<Boolean>()
    var failure: Throwable? = null

    override var isWelcomed = false
        private set

    override fun onScreen(ts: Long, screen: ScreenRef?) {
        failure?.let { throw it }
        screens += screen
    }

    override fun setForeground(foreground: Boolean) {
        this.foreground += foreground
    }

    override fun addWelcomeListener(listener: (welcomed: Boolean) -> Unit) {
        listeners += listener
    }

    fun welcome(welcomed: Boolean) {
        isWelcomed = welcomed
        listeners.forEach { it(welcomed) }
    }
}
