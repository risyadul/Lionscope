package io.github.risyadul.lionscope

/**
 * A body as captured on the app's thread, decoded into an [HttpBody] on the link thread ([HttpBodies.decode]).
 * [bytes] are at most [MAX_HTTP_BODY_BYTES] raw bytes (null when not captured); [cut] means there were more.
 * [encoding] is the Content-Encoding (lower case), null for none or `identity`.
 */
internal class RawBody(
    val size: Long?,
    val contentType: String?,
    val bytes: ByteArray?,
    val cut: Boolean,
    val omitted: HttpBodyOmission?,
    val encoding: String? = null,
)

/** An `httpRequest` waiting to be encoded; [url] and [headers] as captured (redacted and cleaned when encoded). */
internal class HttpRequestRecord(
    val id: Int,
    val ts: Long,
    val method: String,
    val url: String,
    val headers: List<Pair<String, String>>,
    val body: RawBody?,
    val mockId: String?,
    val dropped: Int,
) {
    fun sizeHint(): Int = RECORD_OVERHEAD + url.length + headersSize(headers) + bodySize(body)
}

/** An `httpResponse` waiting to be encoded. */
internal class HttpResponseRecord(
    val id: Int,
    val ts: Long,
    val status: Int?,
    val protocol: String?,
    val headers: List<Pair<String, String>>,
    val body: RawBody?,
    val headersMs: Double?,
    val durationMs: Double,
    val error: HttpFailure?,
) {
    fun sizeHint(): Int = RECORD_OVERHEAD + headersSize(headers) + bodySize(body)
}

private const val RECORD_OVERHEAD = 256

/** JSON escapes make text longer than its raw bytes; twice the bytes keeps the queue's byte budget honest. */
private const val ESCAPED_TEXT_FACTOR = 2

private fun headersSize(headers: List<Pair<String, String>>): Int = headers.sumOf { it.first.length + it.second.length + 8 }

private fun bodySize(body: RawBody?): Int = ESCAPED_TEXT_FACTOR * (body?.bytes?.size ?: 0)

/**
 * Encoders for the v7 network lines (field order = protocol/src/wire.ts = the golden fixtures). They apply the
 * device-side redaction and every bound the server checks, so no line they produce is rejected: headers with names
 * that are not HTTP tokens are dropped, values have control / format characters replaced by spaces and are capped,
 * at most [MAX_HTTP_HEADERS] headers and [MAX_HTTP_HEADER_BYTES] per side; the URL is redacted and capped; a line
 * that would exceed [MAX_HTTP_LINE_BYTES] has its body text cut further (`truncated`).
 */
internal object HttpMessages {
    private const val MAX_STATUS = 999
    private const val MIN_STATUS = 100
    private const val MAX_SIZE = 1e15
    private val PROTOCOL = Regex("[a-z0-9_./-]{1,32}")
    private val MOCK_ID = Regex("m[1-9][0-9]{0,8}")
    private val URL_SCHEME = Regex("^https?://", RegexOption.IGNORE_CASE)

    /** Null when the method is not an HTTP token of at most [MAX_HTTP_METHOD_CHARS] or the URL is not http(s). */
    fun httpRequest(record: HttpRequestRecord, maxLineBytes: Int = MAX_HTTP_LINE_BYTES): String? = httpRequest(
        id = record.id,
        ts = record.ts,
        method = record.method,
        url = record.url,
        headers = record.headers,
        body = record.body?.let(HttpBodies::decode),
        mockId = record.mockId,
        dropped = record.dropped,
        maxLineBytes = maxLineBytes,
    )

    fun httpRequest(
        id: Int,
        ts: Long,
        method: String,
        url: String,
        headers: List<Pair<String, String>>,
        body: HttpBody?,
        mockId: String?,
        dropped: Int,
        maxLineBytes: Int = MAX_HTTP_LINE_BYTES,
    ): String? {
        if (method.length > MAX_HTTP_METHOD_CHARS || !HttpText.isToken(method)) return null
        val wireUrl = wireUrl(url) ?: return null
        val wireHeaders = wireHeaders(headers)
        return fitted(body, maxLineBytes) { fittedBody ->
            val json = JsonWriter().beginObject()
                .name("type").value("httpRequest")
                .name("id").value(id.coerceAtLeast(1))
                .name("ts").value(ts)
                .name("method").value(method)
                .name("url").value(wireUrl)
            writeHeaders(json, wireHeaders)
            json.name("body")
            writeBody(json, fittedBody)
            json.name("mockId").value(mockId?.takeIf { MOCK_ID.matches(it) })
                .name("dropped").value(dropped.coerceIn(0, MAX_HTTP_DROPPED))
                .endObject().toString()
        }
    }

    fun httpResponse(record: HttpResponseRecord, maxLineBytes: Int = MAX_HTTP_LINE_BYTES): String = httpResponse(
        id = record.id,
        ts = record.ts,
        status = record.status,
        protocol = record.protocol,
        headers = record.headers,
        body = record.body?.let(HttpBodies::decode),
        headersMs = record.headersMs,
        durationMs = record.durationMs,
        error = record.error,
        maxLineBytes = maxLineBytes,
    )

    fun httpResponse(
        id: Int,
        ts: Long,
        status: Int?,
        protocol: String?,
        headers: List<Pair<String, String>>,
        body: HttpBody?,
        headersMs: Double?,
        durationMs: Double,
        error: HttpFailure?,
        maxLineBytes: Int = MAX_HTTP_LINE_BYTES,
    ): String {
        val wireHeaders = wireHeaders(headers)
        return fitted(body, maxLineBytes) { fittedBody ->
            val json = JsonWriter().beginObject()
                .name("type").value("httpResponse")
                .name("id").value(id.coerceAtLeast(1))
                .name("ts").value(ts)
                .name("status")
            val wireStatus = status?.takeIf { it in MIN_STATUS..MAX_STATUS }
            if (wireStatus == null) json.nullValue() else json.value(wireStatus)
            json.name("protocol").value(protocol?.takeIf { PROTOCOL.matches(it) })
            writeHeaders(json, wireHeaders)
            json.name("body")
            writeBody(json, fittedBody)
            json.name("headersMs")
            if (headersMs == null) json.nullValue() else json.value(clampMs(headersMs))
            json.name("durationMs").value(clampMs(durationMs))
                .name("error")
            if (error == null) {
                json.nullValue()
            } else {
                json.beginObject()
                    .name("kind").value(error.kind.wire)
                    .name("message").value(WireText.clean(error.message, MAX_HTTP_ERROR_CHARS))
                    .endObject()
            }
            json.endObject().toString()
        }
    }

    /** The mock rule set [rev] with [count] rules is now the active one. */
    fun mocksApplied(rev: Int, count: Int): String = JsonWriter().beginObject()
        .name("type").value("mocksApplied")
        .name("rev").value(rev.coerceAtLeast(0))
        .name("count").value(count.coerceIn(0, MAX_NETWORK_MOCKS))
        .endObject().toString()

    /**
     * Headers as sent: redacted (URL-valued ones as URLs), names that are not HTTP tokens (or too long) dropped, values cleaned and capped, and
     * only the first ones that fit [MAX_HTTP_HEADERS] / [MAX_HTTP_HEADER_BYTES] (a header that doesn't fit is skipped).
     */
    fun wireHeaders(headers: List<Pair<String, String>>): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>(minOf(headers.size, MAX_HTTP_HEADERS))
        var bytes = 0
        for ((name, value) in headers) {
            if (out.size == MAX_HTTP_HEADERS) break
            if (name.length > MAX_HTTP_HEADER_NAME_CHARS || !HttpText.isToken(name)) continue
            val redacted = HttpRedaction.redactHeaderValue(name, value)
            val wireValue = if (redacted === HTTP_REDACTED) {
                redacted
            } else {
                capLength(HttpText.replaceControls(redacted), MAX_HTTP_HEADER_VALUE_CHARS)
            }
            val size = StackFrames.utf8Length(name) + StackFrames.utf8Length(wireValue)
            if (bytes + size > MAX_HTTP_HEADER_BYTES) continue
            bytes += size
            out += name to wireValue
        }
        return out
    }

    /** The URL as sent (redacted, cleaned, capped), or null when it is not http(s). */
    fun wireUrl(url: String): String? {
        val wire = capLength(HttpText.replaceControls(HttpRedaction.redactUrl(url)), MAX_HTTP_URL_CHARS)
        return wire.takeIf { URL_SCHEME.containsMatchIn(it) }
    }

    /**
     * Encodes with [body], cutting its text in half while the line is longer than [maxLineBytes] (JSON escapes can
     * make a 64 KB text up to six times longer). Headers and URL alone always fit.
     */
    private inline fun fitted(body: HttpBody?, maxLineBytes: Int, encode: (HttpBody?) -> String): String {
        var current = body
        while (true) {
            val line = encode(current)
            val text = current?.text
            if (current == null || text.isNullOrEmpty() || StackFrames.utf8Length(line) <= maxLineBytes) return line
            current = current.copy(text = capLength(text, text.length / 2), truncated = true)
        }
    }

    private fun writeHeaders(json: JsonWriter, headers: List<Pair<String, String>>) {
        json.name("headers").beginArray()
        for ((name, value) in headers) json.beginArray().value(name).value(value).endArray()
        json.endArray()
    }

    private fun writeBody(json: JsonWriter, body: HttpBody?) {
        if (body == null) {
            json.nullValue()
            return
        }
        json.beginObject().name("size")
        val size = body.size?.takeIf { it >= 0 && it <= MAX_SIZE }
        if (size == null) json.nullValue() else json.value(size)
        val text = body.text?.let { HttpText.capUtf8(it, MAX_HTTP_BODY_BYTES) }
        json.name("contentType").value(HttpText.contentType(body.contentType))
            .name("text").value(text)
            .name("truncated").value(body.truncated || text?.length != body.text?.length)
            .name("omitted").value(body.omitted?.wire)
            .endObject()
    }

    private fun clampMs(value: Double): Double = if (value.isNaN()) 0.0 else value.coerceIn(0.0, MAX_HTTP_DURATION_MS)
}

/** Wire-safety helpers for HTTP text. */
internal object HttpText {
    private const val TOKEN_SYMBOLS = "!#$%&'*+.^_`|~-"

    /** An RFC 9110 token (header names, methods). */
    fun isToken(value: String): Boolean = value.isNotEmpty() && value.all { c ->
        c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || TOKEN_SYMBOLS.indexOf(c) >= 0
    }

    /** Control (Cc) and format (Cf) code points replaced with one space each (nothing collapsed or trimmed). */
    fun replaceControls(value: String): String {
        var out: StringBuilder? = null
        var i = 0
        while (i < value.length) {
            val codePoint = value.codePointAt(i)
            val count = Character.charCount(codePoint)
            val type = Character.getType(codePoint)
            if (type == Character.CONTROL.toInt() || type == Character.FORMAT.toInt()) {
                if (out == null) out = StringBuilder(value.length).append(value, 0, i)
                out.append(' ')
            } else {
                out?.appendCodePoint(codePoint)
            }
            i += count
        }
        return out?.toString() ?: value
    }

    /** A Content-Type as sent: cleaned, at most [MAX_HTTP_CONTENT_TYPE_CHARS], null when empty. */
    fun contentType(value: String?): String? =
        value?.let { capLength(replaceControls(it).trim(), MAX_HTTP_CONTENT_TYPE_CHARS).trim() }?.ifEmpty { null }

    /** [value] cut to at most [maxBytes] UTF-8 bytes, never inside a code point. */
    fun capUtf8(value: String, maxBytes: Int): String {
        if (value.length * 3 <= maxBytes) return value
        var bytes = 0
        var i = 0
        while (i < value.length) {
            val codePoint = value.codePointAt(i)
            val size = when {
                codePoint < 0x80 -> 1
                codePoint < 0x800 -> 2
                codePoint < 0x10000 -> 3
                else -> 4
            }
            if (bytes + size > maxBytes) return value.substring(0, i)
            bytes += size
            i += Character.charCount(codePoint)
        }
        return value
    }
}
