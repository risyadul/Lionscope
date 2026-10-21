package io.github.risyadul.lionscope.sample

/**
 * Example of the screen-alias convention Lionscope understands: a public zero-arg `getScreen()` returning an
 * object with a String `value` (`getScreen()?.value`). Lionscope reads it via reflection; no dependency needed.
 */
interface ScreenName {
    fun getScreen(): Screen? = null
}

enum class Screen(var value: String) {
    HOME("home_tab"),
    HOME_ALT("home_tab_alt"),
    PAGE_1("legacy_page_1"),
    PAGE_2("legacy_page_2"),
    PAGE_3("legacy_page_3"),
    DETAIL("detail_page"),
}
