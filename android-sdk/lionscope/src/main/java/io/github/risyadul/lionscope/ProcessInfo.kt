package io.github.risyadul.lionscope

import android.app.Application
import android.os.Build
import java.io.File

internal object ProcessInfo {

    fun currentProcessName(): String? {
        if (Build.VERSION.SDK_INT >= 28) return Application.getProcessName()
        return try {
            File("/proc/self/cmdline").readBytes()
                .takeWhile { it != 0.toByte() }
                .toByteArray()
                .toString(Charsets.UTF_8)
                .trim()
        } catch (e: Exception) {
            null
        }
    }
}
