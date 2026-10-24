package io.github.risyadul.lionscope.sample

import android.app.Application

class SampleApplication : Application() {
    override fun onCreate() {
        // kotlinx.coroutines debug mode names the thread after the running coroutine: Lionscope shows that name for
        // a coroutine's stalls. Set before the first coroutine starts.
        System.setProperty("kotlinx.coroutines.debug", "on")
        super.onCreate()
    }
}
