package io.github.risyadul.lionscope

import kotlin.math.absoluteValue

/**
 * A group's source information as the Compose compiler records it (`CompositionGroup.sourceInfo`), e.g.
 * `C(ProductCard)N(product,onClick)61@2765L246:ComposeShopScreens.kt#vgriz8`: [isCall] (`C`, `CC` for an inline
 * call), the function [name], the [lines] of the composable calls it makes (in call order, 1-based; -1 when not
 * recorded), from [repeatFrom] on repeating (a call in a loop), and the [file] and [packageHash] of the code it is in.
 */
internal class SourceInfo(
    val isCall: Boolean,
    val name: String?,
    val lines: IntArray,
    val repeatFrom: Int,
    val file: String?,
    val packageHash: String?,
) {
    /** The line of the [index]th composable call made from this group, null when none was recorded. */
    fun lineOfCall(index: Int): Int? {
        var at = index
        if (at >= lines.size && repeatFrom in lines.indices) at = (index - repeatFrom) % (lines.size - repeatFrom) + repeatFrom
        return lines.getOrNull(at)?.takeIf { it > 0 }
    }

    companion object {
        /**
         * Lenient: an unknown section is skipped, a malformed location ends the location list, and anything else that
         * does not parse gives null (the group then counts as having no source information).
         */
        fun parse(info: String): SourceInfo? {
            if (info.isEmpty()) return null
            var i = 0
            var isCall = false
            var name: String? = null
            if (info[0] == 'C') {
                isCall = true
                i = if (info.startsWith("CC")) 2 else 1
                if (i < info.length && info[i] == '(') {
                    val end = info.indexOf(')', i)
                    if (end < 0) return null
                    name = info.substring(i + 1, end).ifEmpty { null }
                    i = end + 1
                }
            }
            // Sections such as P(...) and N(...): a letter, then a parenthesized body (nested parentheses allowed).
            while (i + 1 < info.length && info[i].isLetter() && info[i + 1] == '(') {
                var depth = 0
                var j = i + 1
                while (j < info.length) {
                    if (info[j] == '(') depth++ else if (info[j] == ')' && --depth == 0) break
                    j++
                }
                if (j >= info.length) return null
                i = j + 1
            }
            val colon = info.indexOf(':', i)
            val locations = if (colon < 0) info.substring(i) else info.substring(i, colon)
            val lines = ArrayList<Int>()
            var repeatFrom = -1
            for (location in locations.split(',')) {
                if (location.isEmpty()) continue
                val repeat = location.startsWith('*')
                val at = location.indexOf('@')
                if (at < 0) break
                val line = location.substring(if (repeat) 1 else 0, at)
                if (repeat && repeatFrom < 0) repeatFrom = lines.size
                lines += if (line.isEmpty()) -1 else (line.toIntOrNull() ?: break) + 1
            }
            var file: String? = null
            var packageHash: String? = null
            if (colon >= 0) {
                val rest = info.substring(colon + 1)
                val hash = rest.indexOf('#')
                file = (if (hash < 0) rest else rest.substring(0, hash)).ifEmpty { null }
                packageHash = if (hash < 0) null else rest.substring(hash + 1).ifEmpty { null }
            }
            return SourceInfo(isCall, name, lines.toIntArray(), repeatFrom, file, packageHash)
        }

        /** The compiler's package hash: `packageName.fold(0) { h, c -> h * 31 + c }.absoluteValue` in base 36. */
        fun packageHash(packageName: String): String =
            packageName.fold(0) { hash, char -> hash * 31 + char.code }.absoluteValue.toString(36)
    }
}

/**
 * Which composable calls the Inspector shows: named calls made from the app's code, so `Button` called in
 * `HomeScreen.kt` is a node but the Surface, Row and Layout inside Button are not (their call sites are in
 * androidx.compose). Calls whose site is in library code, helpers that emit nothing ([HIDDEN], `remember*`, property
 * getters such as `<get-typography>`) and lambdas (no name) are hidden; what they emit belongs to the nearest shown
 * ancestor. Library code is [LIBRARY_PACKAGES] (by package hash, all the compiler records) plus what [learn] adds
 * during one capture: library code calls library functions by name (it reaches app code mostly through lambdas,
 * which have no name), so a named function called from library code is taken for library code, wherever its
 * package is, unless that package already made a shown call (an app's `@Composable override` called by a library
 * stays the app's). One instance per capture, main thread.
 */
internal class ComposableFilter {
    private val learned = HashSet<String>()
    private val app = HashSet<String>()

    /** [packageHash] is that of the code making a call; null (unknown) counts as the app's. */
    fun isLibrary(packageHash: String?): Boolean =
        packageHash != null && packageHash !in app && (packageHash in LIBRARY_HASHES || packageHash in learned)

    /** [callSitePackageHash] is that of the code making the call; a shown call marks it as app code. */
    fun isShown(name: String?, callSitePackageHash: String?): Boolean {
        if (name.isNullOrEmpty() || name[0] == '<' || name.startsWith("remember") || name in HIDDEN) return false
        if (isLibrary(callSitePackageHash)) return false
        if (callSitePackageHash != null) app += callSitePackageHash
        return true
    }

    /** A named function [called] from library code: its own package (its [SourceInfo.packageHash]) is library code. */
    fun learn(called: SourceInfo, callSitePackageHash: String?) {
        val hash = called.packageHash ?: return
        if (called.name == null || called.file == null || hash in app || !isLibrary(callSitePackageHash)) return
        if (learned.size < MAX_LEARNED) learned += hash
    }

    private companion object {
        const val MAX_LEARNED = 1_024

        val HIDDEN = setOf(
            "CompositionLocalProvider",
            "key",
            "ReusableContent",
            "ReusableContentHost",
            "Providers",
            "ProvideTextStyle",
            "ProvideContentColorTextStyle",
            "LocalOwnersProvider",
            "SaveableStateProvider",
        )

        /** The androidx packages whose composables call other composables internally (Compose UI, Material, Navigation). */
        val LIBRARY_PACKAGES = listOf(
            "androidx.activity.compose",
            "androidx.compose.animation",
            "androidx.compose.animation.core",
            "androidx.compose.foundation",
            "androidx.compose.foundation.contextmenu",
            "androidx.compose.foundation.gestures",
            "androidx.compose.foundation.internal",
            "androidx.compose.foundation.layout",
            "androidx.compose.foundation.lazy",
            "androidx.compose.foundation.lazy.grid",
            "androidx.compose.foundation.lazy.layout",
            "androidx.compose.foundation.lazy.staggeredgrid",
            "androidx.compose.foundation.pager",
            "androidx.compose.foundation.selection",
            "androidx.compose.foundation.text",
            "androidx.compose.foundation.text.contextmenu",
            "androidx.compose.foundation.text.contextmenu.internal",
            "androidx.compose.foundation.text.contextmenu.provider",
            "androidx.compose.foundation.text.input",
            "androidx.compose.foundation.text.input.internal",
            "androidx.compose.foundation.text.modifiers",
            "androidx.compose.foundation.text.selection",
            "androidx.compose.foundation.window",
            "androidx.compose.material",
            "androidx.compose.material.internal",
            "androidx.compose.material.navigation",
            "androidx.compose.material.pullrefresh",
            "androidx.compose.material.ripple",
            "androidx.compose.material3",
            "androidx.compose.material3.adaptive",
            "androidx.compose.material3.adaptive.layout",
            "androidx.compose.material3.adaptive.navigation",
            "androidx.compose.material3.adaptive.navigationsuite",
            "androidx.compose.material3.carousel",
            "androidx.compose.material3.internal",
            "androidx.compose.material3.pulltorefresh",
            "androidx.compose.runtime",
            "androidx.compose.runtime.internal",
            "androidx.compose.runtime.livedata",
            "androidx.compose.runtime.saveable",
            "androidx.compose.ui",
            "androidx.compose.ui.graphics.vector",
            "androidx.compose.ui.layout",
            "androidx.compose.ui.node",
            "androidx.compose.ui.platform",
            "androidx.compose.ui.res",
            "androidx.compose.ui.text",
            "androidx.compose.ui.tooling",
            "androidx.compose.ui.viewinterop",
            "androidx.compose.ui.window",
            "androidx.lifecycle.compose",
            "androidx.lifecycle.viewmodel.compose",
            "androidx.navigation.compose",
            "androidx.navigation.compose.internal",
            "org.jetbrains.compose.resources",
        )

        val LIBRARY_HASHES: Set<String> by lazy { LIBRARY_PACKAGES.mapTo(HashSet()) { SourceInfo.packageHash(it) } }
    }
}
