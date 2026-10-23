package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The interceptor tests run twice: `testDebugUnitTest` on OkHttp 4.12, `testOkHttp5` on OkHttp 5 (see
 * lionscope/build.gradle.kts). This checks each run really has the OkHttp it claims, and only one of them.
 */
class OkHttpClasspathTest {

    @Test
    fun theRunHasTheExpectedOkHttp() {
        // Read reflectively: `OkHttp.VERSION` is a constant, inlined as 4.12.0 when the tests were compiled.
        val version = Class.forName("okhttp3.OkHttp").getField("VERSION").get(null) as String
        val expectedMajor = System.getProperty("lionscope.okhttpMajor") ?: "4"
        assertTrue("OkHttp $version, expected $expectedMajor.x", version.startsWith("$expectedMajor."))
        val okhttpJars = System.getProperty("java.class.path").orEmpty().split(java.io.File.pathSeparatorChar)
            .map { java.io.File(it).name }
            .filter { it.startsWith("okhttp-") }
        assertEquals(okhttpJars.toString(), 1, okhttpJars.size)
    }
}
