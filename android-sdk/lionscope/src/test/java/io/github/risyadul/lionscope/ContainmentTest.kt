package io.github.risyadul.lionscope

import android.app.Application
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Nothing the SDK does at startup may reach the host app, not even an Error. */
class ContainmentTest {

    private val brokenContext = object : ContextWrapper(null) {
        override fun getApplicationContext(): Context = throw StackOverflowError("broken context")
    }

    /** Debuggable app whose callback registration fails like a thread/pthread OOM would. */
    private val failingApp = object : Application() {
        override fun getApplicationContext(): Context = this
        override fun getApplicationInfo() = ApplicationInfo().apply { flags = ApplicationInfo.FLAG_DEBUGGABLE }
        override fun getPackageName() = "com.example.app"
        override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
            throw OutOfMemoryError("pthread_create (1040KB stack) failed: Try again")
        }
    }

    @Test
    fun initializerContainsErrors() {
        LionscopeInitializer().create(brokenContext)
        assertFalse(Lionscope.isActive())
    }

    @Test
    fun manualInstallContainsErrors() {
        Lionscope.install(brokenContext)
        assertFalse(Lionscope.isActive())
    }

    @Test
    fun installContainsOutOfMemoryDuringWiring() {
        LionscopeRuntime.installIfEligible(failingApp) { "com.example.app" }
        assertFalse(Lionscope.isActive())
    }

    @Test
    fun nonDebuggableOrSecondaryProcessIsANoOp() {
        var registrations = 0
        fun app(debuggable: Boolean) = object : Application() {
            override fun getApplicationContext(): Context = this
            override fun getApplicationInfo() =
                ApplicationInfo().apply { flags = if (debuggable) ApplicationInfo.FLAG_DEBUGGABLE else 0 }
            override fun getPackageName() = "com.example.app"
            override fun registerActivityLifecycleCallbacks(callback: ActivityLifecycleCallbacks) {
                registrations++
                throw IllegalStateException("stop before starting threads")
            }
        }
        LionscopeRuntime.installIfEligible(app(debuggable = false)) { "com.example.app" }
        LionscopeRuntime.installIfEligible(app(debuggable = true)) { "com.example.app:remote" }
        assertEquals(0, registrations)
        LionscopeRuntime.installIfEligible(app(debuggable = true)) { "com.example.app" }
        assertEquals(1, registrations)
        assertFalse(Lionscope.isActive())
    }
}
