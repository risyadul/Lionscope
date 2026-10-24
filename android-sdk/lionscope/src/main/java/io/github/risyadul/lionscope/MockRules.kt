package io.github.risyadul.lionscope

/**
 * Mock rule matching, identical to `mockTarget`, `globMatches` and `mockMatches` in
 * protocol/src/insights/network.ts. The server sends the rules in precedence order; the first match answers.
 */
internal object MockMatching {

    /** The part of a request URL a pattern is compared with: without `?query` and `#fragment` unless it has a `?`. */
    fun target(pattern: String, requestUrl: String): String {
        val hash = requestUrl.indexOf('#')
        val url = if (hash == -1) requestUrl else requestUrl.substring(0, hash)
        if (pattern.contains('?')) return url
        val question = url.indexOf('?')
        return if (question == -1) url else url.substring(0, question)
    }

    /** `*` matches any run of characters (`/` included); everything else is literal. Linear in practice (≤ 8 stars). */
    fun globMatches(pattern: String, text: String): Boolean {
        var p = 0
        var t = 0
        var star = -1
        var resume = 0
        while (t < text.length) {
            if (p < pattern.length && pattern[p] != '*' && pattern[p] == text[t]) {
                p++
                t++
            } else if (p < pattern.length && pattern[p] == '*') {
                star = p++
                resume = t
            } else if (star != -1) {
                p = star + 1
                t = ++resume
            } else {
                return false
            }
        }
        while (p < pattern.length && pattern[p] == '*') p++
        return p == pattern.length
    }

    /** [url] is the request URL as OkHttp prints it (`HttpUrl.toString()`); a rule out of bounds never matches. */
    fun matches(rule: MockRule, method: String, url: String): Boolean {
        if (!rule.matchable) return false
        if (rule.method != null && rule.method != method) return false
        val target = target(rule.url, url)
        return when (rule.match) {
            MockMatch.EXACT -> target == rule.url
            MockMatch.PREFIX -> target.startsWith(rule.url)
            MockMatch.GLOB -> globMatches(rule.url, target)
        }
    }

    /** The first rule (in the server's order) that matches, or null. */
    fun find(rules: List<MockRule>, method: String, url: String): MockRule? =
        rules.firstOrNull { matches(it, method, url) }
}

/**
 * Collects one rule set from the server: `mocks {rev, count}` then `count` `mock` lines of that rev. Not thread-safe:
 * the caller serialises. A set is complete once every index 0..count-1 arrived; a new `mocks` discards a set still
 * arriving, a `mock` of another rev (or out of range) is ignored, and `count` over [MAX_NETWORK_MOCKS] clears.
 */
internal class MockSetAssembler {
    private var rev = 0
    private var pending: Array<MockRule?>? = null
    private var received = 0

    /** A finished set: [rules] in precedence order. */
    class Applied(val rev: Int, val rules: List<MockRule>)

    /**
     * Starts set [rev]. Returns it at once when it is empty; a [count] over [MAX_NETWORK_MOCKS] (or negative) returns
     * an empty set with [Applied.rev] -1: the active set is cleared, but nothing is confirmed.
     */
    fun begin(rev: Int, count: Int): Applied? {
        pending = null
        received = 0
        if (count !in 0..MAX_NETWORK_MOCKS) return Applied(UNCONFIRMED, emptyList())
        if (count == 0) return Applied(rev, emptyList())
        this.rev = rev
        pending = arrayOfNulls(count)
        return null
    }

    /** Adds rule [index] of set [rev]; returns the set once its last rule arrived. */
    fun add(rev: Int, index: Int, rule: MockRule): Applied? {
        val rules = pending ?: return null
        if (rev != this.rev || index !in rules.indices) return null
        if (rules[index] == null) received++
        rules[index] = rule
        if (received < rules.size) return null
        pending = null
        received = 0
        return Applied(rev, rules.map { it!! })
    }

    fun reset() {
        pending = null
        received = 0
    }

    companion object {
        /** [Applied.rev] of a set that clears the active rules without a `mocksApplied`. */
        const val UNCONFIRMED = -1
    }
}

/** Decoding of the flat `mock` line's compact fields. */
internal object MockWire {
    private const val BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    /**
     * `Name: value` lines joined by `\n` (empty = none); a line without `:`, a name that is not an HTTP token and a
     * value with a control character other than a tab (CR, LF, NUL, …) are skipped, so no rule can inject a header.
     */
    fun headers(compact: String): List<Pair<String, String>> {
        if (compact.isEmpty()) return emptyList()
        return compact.split('\n').mapNotNull { line ->
            val colon = line.indexOf(':')
            if (colon <= 0) return@mapNotNull null
            val name = line.substring(0, colon).trim()
            val value = line.substring(colon + 1).trim()
            if (!HttpText.isToken(name) || value.any { it != '\t' && Character.isISOControl(it) }) null else name to value
        }
    }

    /** Standard base64 (padding optional); null when malformed. java.util.Base64 is API 26+. */
    fun base64(text: String): ByteArray? {
        val trimmed = text.trimEnd('=')
        val padding = text.length - trimmed.length
        if (padding > 2 || trimmed.length % 4 == 1 || (padding > 0 && text.length % 4 != 0)) return null
        val out = java.io.ByteArrayOutputStream(trimmed.length * 3 / 4)
        var buffer = 0
        var bits = 0
        for (c in trimmed) {
            val value = BASE64.indexOf(c)
            if (value < 0) return null
            buffer = ((buffer shl 6) or value) and 0xFFFF
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((buffer shr bits) and 0xFF)
            }
        }
        return out.toByteArray()
    }
}
