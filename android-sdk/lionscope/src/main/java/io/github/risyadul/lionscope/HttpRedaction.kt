package io.github.risyadul.lionscope

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * Redaction of captured HTTP data, identical to the redaction section of protocol/src/insights/network.ts
 * (`isSensitiveName`, `redactHeaders` one header at a time, `redactPairs`, `redactUrl`, `redactJsonText`, `redactXmlText`,
 * `redactBodyText`, `redactFreeText`): the server re-applies the same rules, so both sides agree on what is hidden.
 * The JS regexes are ported with explicit character classes (JS `\s`, `\w`, `\b`, `/i`, `$`), so ICU on the device and
 * the JVM in tests match exactly what V8 matches.
 */
internal object HttpRedaction {
    /** Names whose values are never kept, whatever their case. */
    private val SENSITIVE_EXACT =
        setOf("authorization", "proxy-authorization", "cookie", "set-cookie", "key", "code", "sig", "pass", "pwd")
    /** Anywhere in the (ASCII-lowercased) name: JS `/i` without `u` folds ASCII letters only. */
    private val SENSITIVE_PART =
        Regex("token|secret|api[-_]?key|auth|session|passw(?:or)?d|credential|signature|appcheck|jwt")
    /** At the end after a separator (`private_key`, `Ocp-Apim-Subscription-Key`, `aws.sig`). */
    private val SENSITIVE_SUFFIX = Regex("[-_.](?:key|sig|pwd|pass)\\z")
    /** At the end of a camelCase name (`accessKey`, `userPwd`); case-sensitive on purpose (not `monkey`). */
    private val SENSITIVE_CAMEL_SUFFIX = Regex("[a-z0-9](?:Key|Sig|Pwd|Pass)\\z")
    /** Headers whose values are URLs (`Link`: `<url>; rel=…`): their query, fragment and userinfo are redacted. */
    private val URL_HEADERS = setOf("location", "content-location", "referer", "link")
    private val LINK_URL = Regex("<([^<>]*)>")

    /** JS `\s`: ECMAScript WhiteSpace and LineTerminator. */
    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    /** JS `\w`. */
    private const val JS_WORD = "A-Za-z0-9_"

    private val XML_ELEMENT =
        Regex("<([A-Za-z_][$JS_WORD.:-]*)([$JS_SPACE][^<>]*)?>([^<]*)</\\1[$JS_SPACE]*>")
    private val XML_ATTRIBUTE =
        Regex("([$JS_SPACE])([A-Za-z_][$JS_WORD.:-]*)([$JS_SPACE]*=[$JS_SPACE]*)(\"[^\"]*\"|'[^']*')")

    private val FREE_TEXT_URL = Regex("${anyCase("http")}[Ss]?://[^$JS_SPACE\"'<>]+")
    private val FREE_TEXT_PAIR = Regex("([$JS_WORD.-]+)=([^$JS_SPACE&;,\"']+)")
    /** `\b` before a word character: the previous character is not one. */
    private val FREE_TEXT_AUTH = Regex(
        "(?<![$JS_WORD])(${anyCase("Bearer")}|${anyCase("Basic")}|${anyCase("Token")})[$JS_SPACE]+[^$JS_SPACE,;\"']+",
    )
    private const val REDACTED_JSON = "\"$HTTP_REDACTED\""

    /** A header, query parameter, form field, JSON key or XML element / attribute whose value is never kept. */
    fun isSensitiveName(name: String): Boolean {
        if (name.lowercase() in SENSITIVE_EXACT) return true
        val folded = asciiLowercase(name)
        return SENSITIVE_PART.containsMatchIn(folded) ||
            SENSITIVE_SUFFIX.containsMatchIn(folded) ||
            SENSITIVE_CAMEL_SUFFIX.containsMatchIn(name)
    }

    /** One header's value as kept: sensitive ones replaced, URL-valued ones (`Location`, `Link`, …) redacted as URLs. */
    fun redactHeaderValue(name: String, value: String): String {
        if (isSensitiveName(name)) return HTTP_REDACTED
        if (name.lowercase() !in URL_HEADERS) return value
        return if (value.contains('<')) {
            LINK_URL.replace(value) { "<" + redactUrl(it.groupValues[1]) + ">" }
        } else {
            redactUrl(value)
        }
    }

    /** `a=1&token=x` with the values of sensitive names replaced; pairs without `=` are kept as they are. */
    fun redactPairs(query: String): String = query.split('&').joinToString("&") { pair ->
        val equals = pair.indexOf('=')
        if (equals == -1 || !isSensitiveName(pairName(pair))) pair else pair.substring(0, equals + 1) + HTTP_REDACTED
    }

    /**
     * The URL with its userinfo (`user:pass@`) and the values of sensitive query and fragment parameters
     * (`#access_token=…`) replaced. A display string: not re-encoded.
     */
    fun redactUrl(url: String): String {
        val hash = url.indexOf('#')
        var beforeHash = if (hash == -1) url else url.substring(0, hash)
        val fragment = if (hash == -1) "" else "#" + redactPairs(url.substring(hash + 1))
        val scheme = beforeHash.indexOf("://")
        if (scheme != -1) {
            val authorityStart = scheme + 3
            val ends = listOf('/', '?').map { beforeHash.indexOf(it, authorityStart) }.filter { it != -1 }
            val authorityEnd = ends.minOrNull() ?: beforeHash.length
            val at = beforeHash.lastIndexOf('@', authorityEnd - 1)
            if (at >= authorityStart) {
                beforeHash = beforeHash.substring(0, authorityStart) + HTTP_REDACTED + beforeHash.substring(at)
            }
        }
        val question = beforeHash.indexOf('?')
        if (question == -1) return beforeHash + fragment
        return beforeHash.substring(0, question + 1) + redactPairs(beforeHash.substring(question + 1)) + fragment
    }

    /** The media type of a Content-Type, lower case, without parameters (`application/json`). */
    private fun mediaType(contentType: String?): String = contentType?.substringBefore(';')?.trim()?.lowercase() ?: ""

    /** `application/x-www-form-urlencoded`, any parameters. */
    fun isFormContentType(contentType: String?): Boolean = mediaType(contentType) == "application/x-www-form-urlencoded"

    fun isJsonContentType(contentType: String?): Boolean {
        val type = mediaType(contentType)
        return type == "application/json" || type.endsWith("+json")
    }

    fun isXmlContentType(contentType: String?): Boolean {
        val type = mediaType(contentType)
        return type == "application/xml" || type == "text/xml" || type.endsWith("+xml")
    }

    /** A captured body's text with sensitive values replaced: form fields, JSON keys, XML elements and attributes. */
    fun redactBodyText(contentType: String?, text: String): String = when {
        isFormContentType(contentType) -> redactPairs(text)
        isJsonContentType(contentType) -> redactJsonText(text)
        isXmlContentType(contentType) -> redactXmlText(text)
        else -> text
    }

    /**
     * JSON text with the value of every sensitive key (any depth; strings, numbers, objects, arrays alike) replaced by
     * `"‹redacted›"`. Works on text cut short (a captured body's first 64 KB): a sensitive value that runs past the end
     * is dropped. Anything that is not JSON passes through unchanged, except a `"name": value` that looks like one.
     */
    fun redactJsonText(text: String): String {
        val out = StringBuilder(text.length)
        // The open containers: true for an object.
        val stack = ArrayList<Boolean>()
        var expectKey = false
        var i = 0
        while (i < text.length) {
            val char = text[i]
            if (char != '"') {
                when (char) {
                    '{' -> {
                        stack.add(true)
                        expectKey = true
                    }
                    '[' -> stack.add(false)
                    '}', ']' -> {
                        if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
                        expectKey = false
                    }
                    ',' -> expectKey = stack.lastOrNull() == true
                }
                out.append(char)
                i++
                continue
            }
            val end = jsonStringEnd(text, i)
            val token = text.substring(i, end)
            out.append(token)
            i = end
            if (!expectKey) continue
            expectKey = false
            var colon = i
            while (colon < text.length && isJsonSpace(text[colon])) colon++
            if (colon >= text.length || text[colon] != ':' || !isSensitiveName(jsonKey(token))) continue
            var value = colon + 1
            while (value < text.length && isJsonSpace(text[value])) value++
            out.append(text, i, value)
            // Cut right after the colon: nothing of the value was captured.
            if (value >= text.length) break
            val valueEnd = jsonValueEnd(text, value)
            out.append(REDACTED_JSON)
            i = if (valueEnd == -1) text.length else valueEnd
        }
        return out.toString()
    }

    /** XML text with the text of sensitive elements (`<password>…</password>`) and sensitive attribute values replaced. */
    fun redactXmlText(text: String): String {
        val elements = XML_ELEMENT.replace(text) { match ->
            val name = match.groupValues[1]
            if (isSensitiveName(localName(name))) "<$name${match.groupValues[2]}>$HTTP_REDACTED</$name>" else match.value
        }
        return XML_ATTRIBUTE.replace(elements) { match ->
            val (space, name, equals, value) = match.destructured
            if (isSensitiveName(localName(name))) "$space$name$equals${value[0]}$HTTP_REDACTED${value[0]}" else match.value
        }
    }

    /** Free text (an exception message): URLs, sensitive `name=value` pairs and `Bearer …` credentials redacted. */
    fun redactFreeText(text: String): String {
        val urls = FREE_TEXT_URL.replace(text) { redactUrl(it.value) }
        val pairs = FREE_TEXT_PAIR.replace(urls) { match ->
            val name = match.groupValues[1]
            if (isSensitiveName(name)) "$name=$HTTP_REDACTED" else match.value
        }
        return FREE_TEXT_AUTH.replace(pairs) { it.groupValues[1] + " " + HTTP_REDACTED }
    }

    /** Index after the JSON string starting at [start] (a `"`), or `text.length` when it is cut off. */
    private fun jsonStringEnd(text: String, start: Int): Int {
        var i = start + 1
        while (i < text.length) {
            if (text[i] == '\\') {
                i++
            } else if (text[i] == '"') {
                return i + 1
            }
            i++
        }
        return text.length
    }

    /** Index after the JSON value starting at [start], or -1 when the text ends inside it. */
    private fun jsonValueEnd(text: String, start: Int): Int {
        val first = text[start]
        if (first == '"') {
            val end = jsonStringEnd(text, start)
            return if (end == text.length && text[end - 1] != '"') -1 else end
        }
        if (first == '{' || first == '[') {
            var depth = 0
            var i = start
            while (i < text.length) {
                val char = text[i]
                if (char == '"') {
                    i = jsonStringEnd(text, i) - 1
                } else if (char == '{' || char == '[') {
                    depth++
                } else if ((char == '}' || char == ']') && --depth == 0) {
                    return i + 1
                }
                i++
            }
            return -1
        }
        for (i in start until text.length) if (",}] \t\r\n".indexOf(text[i]) >= 0) return i
        return -1
    }

    private fun isJsonSpace(char: Char): Boolean = char == ' ' || char == '\t' || char == '\n' || char == '\r'

    /** A JSON string token's text (`"a\u0062"` → `ab`); the raw characters when it doesn't decode (JSON.parse). */
    private fun jsonKey(token: String): String =
        FlatJson.parse("{\"k\":$token}")?.string("k")
            ?: token.substring(1, if (token.endsWith('"') && token.length > 1) token.length - 1 else token.length)

    private fun localName(name: String): String = name.substring(name.lastIndexOf(':') + 1)

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

    /** A regex matching [word] in any ASCII case (JS `/i` without `u`). */
    private fun anyCase(word: String): String =
        word.map { if (it.isLetter()) "[${it.uppercaseChar()}${it.lowercaseChar()}]" else it.toString() }.joinToString("")
}
