package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as protocol/test/networkInsights.test.ts: the SDK and the server must agree. */
class NetworkRulesTest {
    private val r = HTTP_REDACTED

    @Test
    fun knowsTheSensitiveNames() {
        for (name in listOf(
            "Authorization", "proxy-authorization", "Cookie", "Set-Cookie", "X-Auth-Token", "x-api-key", "X-API_KEY",
            "apikey", "client_secret", "SESSION", "password", "access_token",
        )) {
            assertTrue(name, HttpRedaction.isSensitiveName(name))
        }
        for (name in listOf("Accept", "Content-Type", "page", "X-Request-Id", "key", "api key", "Pass-word")) {
            assertFalse(name, HttpRedaction.isSensitiveName(name))
        }
        // JS `/i` without `u` folds ASCII only: the Kelvin sign is no `k`, but `toLowerCase` maps it for header names.
        assertFalse(HttpRedaction.isSensitiveName("apiKey"))
        assertTrue(HttpRedaction.isSensitiveName("CooKie"))
    }

    @Test
    fun redactsQueryParameterValuesByNameDecodedAndKeepsTheRestOfTheUrl() {
        assertEquals(
            "https://api.example.com/v1/items?page=2&token=$r&api%5Fkey=$r&x#top",
            HttpRedaction.redactUrl("https://api.example.com/v1/items?page=2&token=abc&api%5Fkey=k&x#top"),
        )
        assertEquals("https://api.example.com/v1/items", HttpRedaction.redactUrl("https://api.example.com/v1/items"))
        assertEquals("https://a.example.com/?token=$r", HttpRedaction.redactUrl("https://a.example.com/?token=$r"))
        assertEquals("https://a.example.com/?%E0%A4%A=1", HttpRedaction.redactUrl("https://a.example.com/?%E0%A4%A=1"))
        // Invalid UTF-8 escapes keep the raw name, as decodeURIComponent throws.
        assertEquals("https://a.example.com/?%74oken%FF=1", HttpRedaction.redactUrl("https://a.example.com/?%74oken%FF=1"))
        assertEquals("https://a.example.com/?%74oken=$r", HttpRedaction.redactUrl("https://a.example.com/?%74oken=1"))
        assertEquals("https://a.example.com/#?token=1", HttpRedaction.redactUrl("https://a.example.com/#?token=1"))
    }

    @Test
    fun redactsFormFieldsTheSameWay() {
        assertEquals("user=ana&password=$r&remember+me=1", HttpRedaction.redactPairs("user=ana&password=hunter2&remember+me=1"))
        assertEquals("a&&session+id=$r", HttpRedaction.redactPairs("a&&session+id=x=y"))
        assertTrue(HttpRedaction.isFormContentType("Application/X-WWW-Form-Urlencoded; charset=utf-8"))
        assertFalse(HttpRedaction.isFormContentType("application/json"))
        assertFalse(HttpRedaction.isFormContentType(null))
    }

    @Test
    fun globsStarIsAnyRunOfCharacters() {
        assertTrue(MockMatching.globMatches("https://*.example.com/v1/*", "https://api.example.com/v1/items/42"))
        assertFalse(MockMatching.globMatches("https://*.example.com/v1/*", "https://api.example.com/v2/items"))
        assertTrue(MockMatching.globMatches("*", ""))
        assertTrue(MockMatching.globMatches("a*b*c", "axxbyyc"))
        assertFalse(MockMatching.globMatches("a*b*c", "axxbyy"))
        assertFalse(MockMatching.globMatches("abc", "abcd"))
        assertFalse(MockMatching.globMatches("*a".repeat(8) + "b", "a".repeat(4000)))
    }

    private fun rule(
        method: String? = "GET",
        match: MockMatch = MockMatch.PREFIX,
        url: String = "https://api.example.com/v1/items",
        id: String = "m1",
    ) = MockRule(id, method, match, url, MockAction.RESPOND, 200, emptyList(), ByteArray(0), 0)

    @Test
    fun matchesWithoutTheQueryUnlessThePatternHasOne() {
        val url = "https://api.example.com/v1/items?page=2#top"
        assertTrue(MockMatching.matches(rule(match = MockMatch.EXACT), "GET", url))
        assertTrue(MockMatching.matches(rule(match = MockMatch.EXACT, url = "https://api.example.com/v1/items?page=2"), "GET", url))
        assertFalse(MockMatching.matches(rule(match = MockMatch.EXACT, url = "https://api.example.com/v1/items?page=3"), "GET", url))
        assertTrue(MockMatching.matches(rule(), "GET", url))
        assertFalse(MockMatching.matches(rule(), "POST", url))
        assertTrue(MockMatching.matches(rule(method = null), "POST", url))
        assertEquals("https://a.example.com/p", MockMatching.target("https://a.example.com/*", "https://a.example.com/p?q#f"))
        assertEquals("https://a.example.com/p?q", MockMatching.target("https://a.example.com/*?*", "https://a.example.com/p?q#f"))
    }

    @Test
    fun theFirstMatchInTheServersOrderWins() {
        val rules = listOf(
            rule(match = MockMatch.EXACT, url = "https://api.example.com/v1/items/42", id = "m3"),
            rule(id = "m2"),
            rule(method = null, match = MockMatch.GLOB, url = "https://*.example.com/*", id = "m1"),
        )
        assertEquals("m3", MockMatching.find(rules, "GET", "https://api.example.com/v1/items/42")?.id)
        assertEquals("m2", MockMatching.find(rules, "GET", "https://api.example.com/v1/items/7")?.id)
        assertEquals("m1", MockMatching.find(rules, "DELETE", "https://api.example.com/v1/items/42")?.id)
        assertNull(MockMatching.find(rules, "GET", "https://example.org/"))
    }

    @Test
    fun assemblesASetOnlyOnceEveryRuleOfItsRevArrived() {
        val assembler = MockSetAssembler()
        assertNull(assembler.begin(3, 2))
        assertNull(assembler.add(2, 0, rule(id = "old"))) // Another rev: ignored.
        assertNull(assembler.add(3, 5, rule(id = "out"))) // Out of range: ignored.
        assertNull(assembler.add(3, 1, rule(id = "m1")))
        val applied = checkNotNull(assembler.add(3, 0, rule(id = "m2")))
        assertEquals(3, applied.rev)
        assertEquals(listOf("m2", "m1"), applied.rules.map { it.id }) // In index order.
        assertNull(assembler.add(3, 0, rule(id = "late"))) // The set is done.

        // A new `mocks` discards a half-received set.
        assertNull(assembler.begin(4, 2))
        assertNull(assembler.add(4, 0, rule()))
        assertNull(assembler.begin(5, 1))
        assertNull(assembler.add(4, 1, rule()))
        assertEquals(5, assembler.add(5, 0, rule())?.rev)

        // Empty sets apply at once; too many rules clear without a confirmation.
        assertEquals(0, assembler.begin(6, 0)?.rules?.size)
        val tooMany = checkNotNull(assembler.begin(7, MAX_NETWORK_MOCKS + 1))
        assertEquals(MockSetAssembler.UNCONFIRMED, tooMany.rev)
        assertTrue(tooMany.rules.isEmpty())
        assertNull(assembler.add(7, 0, rule()))
    }
}
