package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as protocol/test/networkInsights.test.ts: the SDK and the server must agree. */
class NetworkRulesTest {
    private val r = HTTP_REDACTED

    private fun headers(vararg headers: Pair<String, String>) =
        headers.map { (name, value) -> name to HttpRedaction.redactHeaderValue(name, value) }

    @Test
    fun knowsTheSensitiveNames() {
        for (name in listOf(
            "Authorization", "proxy-authorization", "Cookie", "Set-Cookie", "X-Auth-Token", "x-api-key", "X-API_KEY",
            "apikey", "client_secret", "SESSION", "password", "access_token", "key", "code", "sig", "X-Amz-Signature",
            "X-Amz-Credential", "jwt", "pwd", "passwd", "Ocp-Apim-Subscription-Key", "X-Firebase-AppCheck",
            "private_key", "accessKey", "credentials",
        )) {
            assertTrue(name, HttpRedaction.isSensitiveName(name))
        }
        for (name in listOf("Accept", "Content-Type", "page", "X-Request-Id", "monkey", "keyboard", "zipcode", "Location")) {
            assertFalse(name, HttpRedaction.isSensitiveName(name))
        }
        // SDK-side extras. JS `/i` without `u` folds ASCII only: the Kelvin sign is no `k`, but `toLowerCase` maps it.
        assertFalse(HttpRedaction.isSensitiveName("api\u212Aey"))
        assertTrue(HttpRedaction.isSensitiveName("Coo\u212Aie"))
        // JS `$` is the end of the input, not before a final line break.
        assertFalse(HttpRedaction.isSensitiveName("private_key\n"))
        assertFalse(HttpRedaction.isSensitiveName("accessKey\n"))
        for (name in listOf("api key", "Pass-word")) assertFalse(name, HttpRedaction.isSensitiveName(name))
    }

    @Test
    fun redactsHeaderValuesAndKeepsTheirNamesAndOrder() {
        assertEquals(
            listOf("Accept" to "application/json", "Authorization" to r, "Set-Cookie" to r, "Set-Cookie" to r),
            headers("Accept" to "application/json", "Authorization" to "Bearer abc", "Set-Cookie" to "sid=1", "Set-Cookie" to "theme=dark"),
        )
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
        // SDK-side extras. Invalid UTF-8 escapes keep the raw name, as decodeURIComponent throws.
        assertEquals("https://a.example.com/?%74oken%FF=1", HttpRedaction.redactUrl("https://a.example.com/?%74oken%FF=1"))
        assertEquals("https://a.example.com/?%74oken=$r", HttpRedaction.redactUrl("https://a.example.com/?%74oken=1"))
        assertEquals("https://a.example.com/#?token=$r", HttpRedaction.redactUrl("https://a.example.com/#?token=1"))
    }

    @Test
    fun redactsUserinfoAndFragmentParameters() {
        assertEquals(
            "https://$r@api.example.com/v1?page=1#access_token=$r&state=x",
            HttpRedaction.redactUrl("https://ana:hunter2@api.example.com/v1?page=1#access_token=abc&state=x"),
        )
        assertEquals("https://api.example.com/a@b", HttpRedaction.redactUrl("https://api.example.com/a@b"))
    }

    @Test
    fun redactsUrlsInsideUrlValuedHeaders() {
        assertEquals(
            listOf(
                "Location" to "app://callback?code=$r&state=1",
                "Link" to "<https://api.example.com/p?sig=$r>; rel=\"next\"",
                "X-Other" to "https://api.example.com/?token=kept-in-a-non-url-header",
            ),
            headers(
                "Location" to "app://callback?code=abc&state=1",
                "Link" to "<https://api.example.com/p?sig=1>; rel=\"next\"",
                "X-Other" to "https://api.example.com/?token=kept-in-a-non-url-header",
            ),
        )
    }

    @Test
    fun redactsJsonKeysAtAnyDepthWhateverTheValueAlsoInTextCutShort() {
        assertEquals(
            "{\"user\":\"ana\",\"password\":\"$r\",\"nested\":{\"refresh_token\":\"$r\",\"list\":[{\"apiKey\":\"$r\"}]},\"ok\":true}",
            HttpRedaction.redactJsonText(
                "{\"user\":\"ana\",\"password\":\"hunter2\",\"nested\":{\"refresh_token\":{\"v\":1},\"list\":[{\"apiKey\":42}]},\"ok\":true}",
            ),
        )
        assertEquals("{\"a\" : \"x\", \"secret\" :  \"$r\"}", HttpRedaction.redactJsonText("{\"a\" : \"x\", \"secret\" :  \"s\\\"q\"}"))
        assertEquals("[{\"token\":\"$r\"", HttpRedaction.redactJsonText("[{\"token\":\"abc"))
        assertEquals("{\"token\":", HttpRedaction.redactJsonText("{\"token\":"))
        assertEquals(
            "{\"items\":[\"token\",\"x\"],\"note\":\"password: kept\"}",
            HttpRedaction.redactJsonText("{\"items\":[\"token\",\"x\"],\"note\":\"password: kept\"}"),
        )
        assertEquals("not json", HttpRedaction.redactJsonText("not json"))
        // SDK-side extras: escaped key names, and a value cut inside an object.
        assertEquals("{\"\\u0074oken\":\"$r\"}", HttpRedaction.redactJsonText("{\"\\u0074oken\":\"x\"}"))
        assertEquals("{\"auth\":\"$r\"", HttpRedaction.redactJsonText("{\"auth\":{\"a\":[1,"))
    }

    @Test
    fun redactsXmlElementsAndAttributes() {
        assertEquals(
            "<login user=\"ana\" auth:token='$r'><ns:password>$r</ns:password><name>Ana</name></login>",
            HttpRedaction.redactXmlText(
                "<login user=\"ana\" auth:token='t'><ns:password>hunter2</ns:password><name>Ana</name></login>",
            ),
        )
    }

    @Test
    fun picksTheBodyRedactionByContentType() {
        assertEquals("{\"jwt\":\"$r\"}", HttpRedaction.redactBodyText("application/json; charset=utf-8", "{\"jwt\":\"x\"}"))
        assertEquals("{\"code\":\"$r\"}", HttpRedaction.redactBodyText("application/problem+json", "{\"code\":\"x\"}"))
        assertEquals("<pwd>$r</pwd>", HttpRedaction.redactBodyText("text/xml", "<pwd>x</pwd>"))
        assertEquals("pass=$r", HttpRedaction.redactBodyText("application/x-www-form-urlencoded", "pass=x"))
        assertEquals("password=x", HttpRedaction.redactBodyText("text/plain", "password=x"))
    }

    @Test
    fun redactsFreeTextUrlsPairsAndBearerCredentials() {
        assertEquals(
            "IOException: failed https://$r@api.example.com/x?token=$r with token=$r, Bearer $r",
            HttpRedaction.redactFreeText("IOException: failed https://u:p@api.example.com/x?token=abc with token=def, Bearer xyz"),
        )
        // SDK-side extra: `\b` before the scheme word, any ASCII case.
        assertEquals("xBearer abc, basic $r", HttpRedaction.redactFreeText("xBearer abc, basic abc"))
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
    fun aRuleOutOfBoundsNeverMatches() {
        val url = "https://api.example.com/v1/items"
        assertFalse(MockMatching.matches(rule(url = url + "a".repeat(MAX_MOCK_URL_CHARS)), "GET", url + "a".repeat(MAX_MOCK_URL_CHARS)))
        assertFalse(MockMatching.matches(rule(match = MockMatch.GLOB, url = "*".repeat(MAX_MOCK_GLOB_STARS + 1)), "GET", url))
        assertTrue(MockMatching.matches(rule(match = MockMatch.GLOB, url = "*".repeat(MAX_MOCK_GLOB_STARS)), "GET", url))
        // `*` is literal in a prefix rule.
        assertTrue(MockMatching.matches(rule(url = "https://api.example.com/*********"), "GET", "https://api.example.com/*********"))
        // Such a rule still counts toward its set, so the set completes and the next rule answers.
        val assembler = MockSetAssembler()
        assertNull(assembler.begin(1, 2))
        assertNull(assembler.add(1, 0, rule(match = MockMatch.GLOB, url = "*".repeat(9), id = "m1")))
        val applied = checkNotNull(assembler.add(1, 1, rule(id = "m2")))
        assertEquals("m2", MockMatching.find(applied.rules, "GET", url)?.id)
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
