package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

interface FakeScreenName {
    fun getScreen(): FakeScreen? = null
}

enum class FakeScreen(var value: String) {
    HOME("homepage"),
    BLANK("  "),
    WITH_BODY("with_body") {
        override fun toString() = "custom"
    },
}

class AliasedFragment : FakeScreenName {
    override fun getScreen() = FakeScreen.HOME
}

class DefaultScreenFragment : FakeScreenName

class BlankAliasFragment : FakeScreenName {
    override fun getScreen() = FakeScreen.BLANK
}

class BodyAliasFragment : FakeScreenName {
    override fun getScreen() = FakeScreen.WITH_BODY
}

open class BaseAliasedActivity : FakeScreenName {
    override fun getScreen(): FakeScreen? = FakeScreen.HOME
}

class InheritedAliasActivity : BaseAliasedActivity()

class ThrowingScreenFragment {
    fun getScreen(): FakeScreen = throw IllegalStateException("not ready")
}

class ArgScreenFragment {
    @Suppress("UNUSED_PARAMETER")
    fun getScreen(flag: Int): FakeScreen = FakeScreen.HOME
}

class NonStringValueFragment {
    class Holder {
        fun getValue(): Int = 42
    }

    fun getScreen(): Holder = Holder()
}

private enum class HiddenScreen(val value: String) { SECRET("secret_page") }

class PrivateEnumFragment {
    fun getScreen(): Any = HiddenScreen.SECRET
}

class PlainActivity

class ScreenNamesTest {

    @Test
    fun usesScreenValueAsAlias() {
        assertEquals("homepage", ScreenNames.nameOf(AliasedFragment()))
    }

    @Test
    fun aliasFromInterfaceDefaultOrSuperclass() {
        assertEquals("homepage", ScreenNames.nameOf(InheritedAliasActivity()))
        assertEquals("DefaultScreenFragment", ScreenNames.nameOf(DefaultScreenFragment()))
    }

    @Test
    fun enumConstantWithBodyStillResolves() {
        assertEquals("with_body", ScreenNames.nameOf(BodyAliasFragment()))
    }

    @Test
    fun nonPublicEnumStillResolves() {
        assertEquals("secret_page", ScreenNames.nameOf(PrivateEnumFragment()))
    }

    @Test
    fun fallsBackToSimpleClassName() {
        assertEquals("PlainActivity", ScreenNames.nameOf(PlainActivity()))
        assertEquals("BlankAliasFragment", ScreenNames.nameOf(BlankAliasFragment()))
        assertEquals("ThrowingScreenFragment", ScreenNames.nameOf(ThrowingScreenFragment()))
        assertEquals("ArgScreenFragment", ScreenNames.nameOf(ArgScreenFragment()))
        assertEquals("NonStringValueFragment", ScreenNames.nameOf(NonStringValueFragment()))
    }

    @Test
    fun repeatedLookupsUseTheCacheAndStayStable() {
        repeat(3) {
            assertEquals("homepage", ScreenNames.nameOf(AliasedFragment()))
            assertNull(ScreenNames.aliasOf(PlainActivity()))
        }
    }

    @Test
    fun anonymousClassesGetANonEmptyName() {
        val anonymous = object : Any() {}
        assertTrue(ScreenNames.nameOf(anonymous).isNotEmpty())
    }
}
