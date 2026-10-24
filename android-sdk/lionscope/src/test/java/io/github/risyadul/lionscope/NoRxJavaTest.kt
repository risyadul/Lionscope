package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * An app without RxJava: the SDK's classes, loaded where `io.reactivex` and `org.reactivestreams` do not exist, find
 * no RxJava and never load [RxJava2Hooks].
 */
class NoRxJavaTest {

    private class WithoutRxJava(parent: ClassLoader) : ClassLoader(parent) {
        val loaded = ArrayList<String>()

        override fun loadClass(name: String, resolve: Boolean): Class<*> = synchronized(this) {
            if (name.startsWith("io.reactivex.") || name.startsWith("org.reactivestreams.")) throw ClassNotFoundException(name)
            if (!name.startsWith(PACKAGE)) return super.loadClass(name, resolve)
            findLoadedClass(name) ?: define(name)
        }

        private fun define(name: String): Class<*> {
            val bytes = parent.getResourceAsStream(name.replace('.', '/') + ".class")?.use { it.readBytes() }
                ?: throw ClassNotFoundException(name)
            loaded += name
            return defineClass(name, bytes, 0, bytes.size)
        }
    }

    @Test
    fun anAppWithoutRxJavaGetsNoRxTracking() {
        val loader = WithoutRxJava(javaClass.classLoader!!)
        val tracking = loader.loadClass("${PACKAGE}RxTracking")
        assertTrue(tracking.classLoader === loader)
        val companion = tracking.getField("Companion").get(null)
        val create = companion.javaClass.getMethod("createIfPresent", Thread::class.java)
        assertNull(create.invoke(companion, Thread.currentThread()))
        assertTrue(loader.loaded.none { it.startsWith("${PACKAGE}RxJava2Hooks") })
    }

    @Test
    fun withoutRxJavaTheControllerRunsAsBefore() {
        val link = FakeLink()
        val main = FakeScheduler()
        val watchdog = FakeWatchdog()
        val controller = DiagnosticsController(link, main, watchdog, strictMode = null, rx = null)
        controller.onActivityStarted(PlainTestActivity())
        link.welcome(true)
        main.runPosted()
        assertTrue(watchdog.isRunning)
        assertEquals(SdkOptions.DEFAULT, controller.options)
    }

    private companion object {
        const val PACKAGE = "io.github.risyadul.lionscope."
    }
}
