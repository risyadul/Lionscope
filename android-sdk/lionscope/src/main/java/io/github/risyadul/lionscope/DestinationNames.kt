package io.github.risyadul.lionscope

/**
 * Screens for navigation destinations, from the destination's route PATTERN (never the arguments of an entry).
 * A type-safe route (`com.example.shop.ProductDetail/{id}?tab={tab}`, the serializable class's name and its argument
 * placeholders) is named after the class (`ProductDetail`); a string route keeps its path (`product/{id}`) without the
 * query part. The class name sent is the whole pattern. A destination without a route (an XML graph) is named by its
 * label, else not reported.
 */
internal object DestinationNames {
    private val QUALIFIED_NAME = Regex("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)+")

    fun screen(route: String?, label: String?, dialog: Boolean): ScreenRef? {
        val pattern = route?.takeIf { it.isNotBlank() } ?: label?.takeIf { it.isNotBlank() } ?: return null
        val kind = if (dialog) ScreenKind.DIALOG else ScreenKind.DESTINATION
        return ScreenRef(nameOf(pattern), pattern, kind)
    }

    fun nameOf(pattern: String): String {
        val path = pattern.substringBefore('?')
        val first = path.substringBefore('/')
        return if (QUALIFIED_NAME.matches(first)) first.substringAfterLast('.') else path.ifEmpty { pattern }
    }
}
