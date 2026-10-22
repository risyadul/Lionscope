package io.github.risyadul.lionscope

/** How a layout is reported: its resource entry name, or a fallback [label] when that is unknown. */
internal data class LayoutName(val layout: String?, val label: String?, val library: Boolean)

/** Layout naming and library classification for `inflate` messages. */
internal object LayoutNames {
    /**
     * Entry-name prefixes of layouts that ship in libraries (AppCompat, Material, MediaRouter, ExoPlayer, Play
     * services, debug tools, ...). Resources of libraries are merged into the app's package, so the prefix is all
     * there is; generic words apps use for their own layouts (`notification_`, `preference_`, `test_`) are left out.
     */
    private val LIBRARY_PREFIXES = listOf(
        "abc_", "design_", "mtrl_", "material_", "m3_", "select_dialog_", "support_simple_", "exo_",
        "notification_template_", "leak_canary_", "chucker_", "common_google_", "com_facebook_", "browser_actions_",
        "mr_",
    )

    private const val FRAMEWORK_PACKAGE = "android"
    private const val MAX_LABEL_CLASS_LENGTH = 120

    /** [packageName] is the resource package (`android` for framework layouts). */
    fun isLibrary(packageName: String?, entryName: String): Boolean =
        packageName == FRAMEWORK_PACKAGE || LIBRARY_PREFIXES.any { entryName.startsWith(it) }

    fun named(packageName: String?, entryName: String): LayoutName =
        LayoutName(entryName, null, isLibrary(packageName, entryName))

    /**
     * Fallback when the layout's resource is unknown: `<simple class name of the first view's tag>:<xml line>`,
     * ASCII only (anything else becomes `_`); the line is left out when unknown.
     */
    fun unnamed(firstTag: String, line: Int): LayoutName {
        val simple = capLength(firstTag.substringAfterLast('.'), MAX_LABEL_CLASS_LENGTH)
        val ascii = buildString(simple.length) {
            for (c in simple) append(if (c in '!'..'~') c else '_')
        }.ifEmpty { WireText.UNKNOWN }
        return LayoutName(null, if (line > 0) "$ascii:$line" else ascii, false)
    }
}
