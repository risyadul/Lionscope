package io.github.risyadul.lionscope

import android.content.Context
import androidx.navigation.NavController

/**
 * Release stand-in for the Lionscope SDK: same public API, no provider, no permissions, no threads.
 */
object Lionscope {
    /** SDK version (the Gradle build version, same as the debug artifact). */
    const val VERSION = LionscopeBuild.VERSION

    /** Always false: the no-op artifact never profiles. */
    fun isActive(): Boolean = false

    /** Does nothing; exists so manual installs compile against both artifacts. */
    @Suppress("UNUSED_PARAMETER")
    fun install(context: Context) = Unit

    /** Does nothing; exists so navigation tracking compiles against both artifacts. */
    @Suppress("UNUSED_PARAMETER")
    fun trackNavigation(navController: NavController) = Unit
}
