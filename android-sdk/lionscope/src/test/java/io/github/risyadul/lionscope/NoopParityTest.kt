package io.github.risyadul.lionscope

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.Modifier
import java.net.InetAddress
import java.net.URLClassLoader

/**
 * `lionscope-noop` must keep the debug artifact's public API, so release builds compile against it unchanged. Its
 * compiled classes (same package and names) are loaded in their own class loader; everything else (Android, Kotlin,
 * OkHttp) comes from this test's classpath, so the no-op interceptor runs in a real OkHttp client.
 */
class NoopParityTest {

    private val noopLoader: ClassLoader by lazy {
        val dir = File(checkNotNull(System.getProperty("lionscope.noopClasses")) { "run via Gradle" })
        assertTrue("no-op classes missing: $dir", File(dir, "io/github/risyadul/lionscope/Lionscope.class").isFile)
        val parent = javaClass.classLoader
        object : URLClassLoader(arrayOf(dir.toURI().toURL()), parent) {
            override fun loadClass(name: String, resolve: Boolean): Class<*> = synchronized(this) {
                if (!name.startsWith(PACKAGE)) return super.loadClass(name, resolve)
                findLoadedClass(name) ?: findClass(name)
            }
        }
    }

    /** Public members as Kotlin callers see them (`internal` ones compile to public methods with a `$module` suffix). */
    private fun publicApi(type: Class<*>): Set<String> {
        val methods = type.declaredMethods.filter { Modifier.isPublic(it.modifiers) && !it.isSynthetic && '$' !in it.name }
            .map { method -> "fun ${method.name}(${method.parameterTypes.joinToString { it.name }}): ${method.returnType.name}" }
        val fields = type.declaredFields.filter { Modifier.isPublic(it.modifiers) && !it.isSynthetic }
            .map { "val ${it.name}: ${it.type.name}" }
        return (methods + fields).toSet()
    }

    @Test
    fun theNoopArtifactHasTheSamePublicApi() {
        val noop = noopLoader.loadClass("$PACKAGE.Lionscope")
        assertTrue(noop.classLoader === noopLoader)
        val api = publicApi(Lionscope::class.java)
        assertTrue(api.contains("fun okHttpInterceptor(): okhttp3.Interceptor"))
        assertEquals(api, publicApi(noop))
    }

    @Test
    fun theNoopInterceptorPassesRequestsThroughUnchanged() {
        val noop = noopLoader.loadClass("$PACKAGE.Lionscope")
        val instance = noop.getField("INSTANCE").get(null)
        val interceptor = noop.getMethod("okHttpInterceptor").invoke(instance) as Interceptor
        assertTrue(interceptor === noop.getMethod("okHttpInterceptor").invoke(instance)) // One per process.

        val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
        try {
            server.enqueue(MockResponse().setResponseCode(418).setBody("teapot").setHeader("X-Real", "1"))
            val client = OkHttpClient.Builder().addInterceptor(interceptor).build()
            val request = Request.Builder().url(server.url("/v1/items?token=abc")).header("Authorization", "Bearer abc").build()
            client.newCall(request).execute().use { response ->
                assertEquals(418, response.code)
                assertEquals("1", response.header("X-Real"))
                assertEquals("teapot", response.body!!.string())
            }
            val received = server.takeRequest()
            assertEquals("/v1/items?token=abc", received.path)
            assertEquals("Bearer abc", received.getHeader("Authorization"))
        } finally {
            server.shutdown()
        }
    }

    private companion object {
        const val PACKAGE = "io.github.risyadul.lionscope"
    }
}
