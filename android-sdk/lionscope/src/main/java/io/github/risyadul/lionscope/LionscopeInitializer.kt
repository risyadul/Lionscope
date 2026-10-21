package io.github.risyadul.lionscope

import android.content.Context
import androidx.startup.Initializer

/** androidx.startup entry point; installs Lionscope in the main process of debuggable apps only. */
class LionscopeInitializer : Initializer<Unit> {

    override fun create(context: Context) {
        LionscopeRuntime.installIfEligible(context)
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
