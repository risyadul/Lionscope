package io.github.risyadul.lionscope

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Redaction of captured HTTP data, identical to protocol/src/insights/network.ts (`isSensitiveName`, `redactPairs`,
 * `redactUrl`, `isFormContentType`): the server re-applies the same rules, so both sides agree on what is hidden.
 */
internal object HttpRedaction {
    private val SENSITIVE_HEADERS = setOf("authorization", "proxy-authorization", "cookie", "set-cookie")
    /** `/token|secret|api[-_]?key|auth|session|password/i`: JS `/i` folds ASCII letters only. */
    private val SENSITIVE_WORDS = listOf("token", "secret", "apikey", "api-key", "api_key", "auth", "session", "password")

    /** A header, query parameter or form field whose value is never kept. */
    fun isSensitiveName(name: String): Boolean {
        if (name.lowercase() in SENSITIVE_HEADERS) return true
        val folded = asciiLowercase(name)
        return SENSITIVE_WORDS.any { folded.contains(it) }
    }

    /** `a=1&token=x` with the values of sensitive names replaced; pairs without `=` are kept as they are. */
    fun redactPairs(query: String): String = query.split('&').joinToString("&") { pair ->
        val equals = pair.indexOf('=')
        if (equals == -1 || !isSensitiveName(pairName(pair))) pair else pair.substring(0, equals + 1) + HTTP_REDACTED
    }

    /** The URL with the values of sensitive query parameters replaced (a display string: not re-encoded). */
    fun redactUrl(url: String): String {
        val hash = url.indexOf('#')
        val beforeHash = if (hash == -1) url else url.substring(0, hash)
        val fragment = if (hash == -1) "" else url.substring(hash)
        val question = beforeHash.indexOf('?')
        if (question == -1) return url
        return beforeHash.substring(0, question + 1) + redactPairs(beforeHash.substring(question + 1)) + fragment
    }

    /** `application/x-www-form-urlencoded`, any parameters. */
    fun isFormContentType(contentType: String?): Boolean =
        contentType?.substringBefore(';')?.trim()?.lowercase() == "application/x-www-form-urlencoded"

    /** The name of a `name=value` pair as written (percent- and `+`-decoded when it can be, like decodeURIComponent). */
    private fun pairName(pair: String): String {
        val equals = pair.indexOf('=')
        val raw = (if (equals == -1) pair else pair.substring(0, equals)).replace('+', ' ')
        return percentDecode(raw) ?: raw
    }

    /** decodeURIComponent: null for a malformed `%` escape or escapes that are not valid UTF-8. */
    private fun percentDecode(value: String): String? {
        if (value.indexOf('%') == -1) return value
        val out = StringBuilder(value.length)
        val bytes = ByteArrayOutputStream()
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c != '%') {
                if (bytes.size() > 0) out.append(decodeUtf8(bytes) ?: return null)
                out.append(c)
                i++
                continue
            }
            if (i + 2 >= value.length) return null
            val high = hexValue(value[i + 1])
            val low = hexValue(value[i + 2])
            if (high < 0 || low < 0) return null
            bytes.write(high * 16 + low)
            i += 3
        }
        if (bytes.size() > 0) out.append(decodeUtf8(bytes) ?: return null)
        return out.toString()
    }

    private fun decodeUtf8(bytes: ByteArrayOutputStream): String? {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        return try {
            decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (e: CharacterCodingException) {
            null
        } finally {
            bytes.reset()
        }
    }

    /** ASCII hex digits only, like decodeURIComponent. */
    private fun hexValue(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    private fun asciiLowercase(value: String): String {
        val chars = value.toCharArray()
        for (i in chars.indices) if (chars[i] in 'A'..'Z') chars[i] = chars[i] + ('a' - 'A')
        return String(chars)
    }
}
