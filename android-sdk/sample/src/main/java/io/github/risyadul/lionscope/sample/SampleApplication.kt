package io.github.risyadul.lionscope.sample

import android.app.Application
import android.content.pm.ApplicationInfo

class SampleApplication : Application() {
    override fun onCreate() {
        // kotlinx.coroutines debug mode names the thread after the running coroutine: Lionscope shows that name for
        // a coroutine's stalls. Debug builds only, set before the first coroutine starts.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            System.setProperty("kotlinx.coroutines.debug", "on")
        }
        super.onCreate()
    }
}
