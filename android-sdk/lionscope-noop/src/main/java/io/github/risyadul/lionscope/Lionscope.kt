package io.github.risyadul.lionscope

import android.content.Context

/**
 * Release stand-in for the Lionscope SDK: same public API, no provider, no permissions, no threads.
 */
object Lionscope {
    /** SDK version, kept in sync with the debug artifact. */
    const val VERSION = "0.1.0"

    /** Always false: the no-op artifact never profiles. */
    fun isActive(): Boolean = false

    /** Does nothing; exists so manual installs compile against both artifacts. */
    @Suppress("UNUSED_PARAMETER")
    fun install(context: Context) = Unit
}
