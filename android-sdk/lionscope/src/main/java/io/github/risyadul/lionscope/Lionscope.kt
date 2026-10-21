package io.github.risyadul.lionscope

import android.content.Context

/**
 * Lionscope in-app SDK (debug artifact).
 *
 * Installed automatically through androidx.startup in debuggable builds; there is nothing to call. Hosts that
 * remove `androidx.startup.InitializationProvider` from their merged manifest can call [install] from
 * `Application.onCreate` instead. Release builds should depend on `lionscope-noop`, which has the same API.
 *
 * Data flow: the SDK connects to `127.0.0.1:8700` on the device, which `adb reverse` forwards to the Lionscope
 * server on the laptop. Without that reverse mapping, any other app on the device listening on
 * 127.0.0.1:8700 would receive the stream (screen class names and frame timings only; debug builds only).
 */
object Lionscope {
    /** SDK version, reported to the Lionscope server in `hello`. */
    const val VERSION = "0.1.0"

    @Volatile
    internal var installed = false

    /** True once the SDK has been installed in this process (debuggable app, main process). */
    fun isActive(): Boolean = installed

    /**
     * Installs the SDK manually. Idempotent; does nothing unless the app is debuggable and this is its main
     * process. Never throws.
     */
    fun install(context: Context) {
        LionscopeRuntime.installIfEligible(context)
    }
}
