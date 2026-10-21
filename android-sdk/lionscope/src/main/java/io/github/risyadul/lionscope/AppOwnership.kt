package io.github.risyadul.lionscope

/**
 * Decides which classes belong to the app, for screens and stack frames alike: a class is app-owned when it shares
 * the package root of the top activity's class or of [applicationId] (see [appPackagePrefix], [packagePrefix]): the
 * first two segments, or three when two are a generic root shared by unrelated code (`io.github.<user>`,
 * `com.google.<product>`, `androidx.<library>`, ...). Safe to share across threads.
 */
internal class AppOwnership(applicationId: String = "") {
    private class Prefix(val activityClass: String, val prefix: String)

    /** Covers modules named after the app id (white-label builds, acquired code); empty when unknown. */
    private val applicationPrefix = packagePrefix(applicationId)

    /** Single-entry cache: the top activity rarely changes between calls. */
    @Volatile
    private var cached: Prefix? = null

    /** [topActivityClass] is null when no activity is started: then only the application id counts. */
    fun isOwned(className: String, topActivityClass: String?): Boolean =
        (topActivityClass != null && isAppOwned(className, activityPrefix(topActivityClass))) ||
            (applicationPrefix.isNotEmpty() && isAppOwned(className, applicationPrefix))

    private fun activityPrefix(className: String): String {
        cached?.let { if (it.activityClass == className) return it.prefix }
        return appPackagePrefix(className).also { cached = Prefix(className, it) }
    }

    internal companion object {
        /** First two package segments of [activityClassName] (the whole package when it has fewer). */
        fun appPackagePrefix(activityClassName: String): String =
            packagePrefix(activityClassName.substringBeforeLast('.', ""))

        /** Two-segment roots that many unrelated owners share. */
        private val GENERIC_ROOTS = setOf(
            "io.github", "com.github", "com.google", "com.android", "org.jetbrains", "io.reactivex",
        )

        /** First segments under which every two-segment root is still shared (`androidx.core`, `kotlin.io`, ...). */
        private val GENERIC_FIRST_SEGMENTS = setOf("androidx", "android", "kotlin", "kotlinx", "java", "javax")

        /** First two segments of [packageName], three for a generic root (all of it when it has fewer). */
        fun packagePrefix(packageName: String): String {
            val first = packageName.indexOf('.')
            if (first < 0) return packageName
            val second = packageName.indexOf('.', first + 1)
            if (second < 0) return packageName
            val root = packageName.substring(0, second)
            if (root !in GENERIC_ROOTS && packageName.substring(0, first) !in GENERIC_FIRST_SEGMENTS) return root
            val third = packageName.indexOf('.', second + 1)
            return if (third < 0) packageName else packageName.substring(0, third)
        }

        /** True when [className] lives in [appPrefix] or below; an empty prefix (default package) owns everything. */
        fun isAppOwned(className: String, appPrefix: String): Boolean = appPrefix.isEmpty() ||
            (className.length > appPrefix.length && className.startsWith(appPrefix) && className[appPrefix.length] == '.')
    }
}
