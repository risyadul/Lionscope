package io.github.risyadul.lionscope

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.zip.GZIPInputStream

/**
 * Which bodies are captured as text, and how captured bytes become [HttpBody.text]: gunzipped (`Content-Encoding:
 * gzip`), decoded with the Content-Type's charset (UTF-8 by default, malformed bytes replaced), form fields redacted,
 * cut to [MAX_HTTP_BODY_BYTES]. [decode] runs on the link thread.
 */
internal object HttpBodies {
    private const val GZIP_BUFFER = 8 * 1024
    private val TEXT_TYPES = setOf(
        "application/json",
        "application/xml",
        "application/x-www-form-urlencoded",
        "application/graphql",
    )
    private val TEXT_SUFFIXES = listOf("+json", "+xml", "+graphql")
    private const val EVENT_STREAM = "text/event-stream"

    /** `type/subtype` in lower case, without parameters; null when missing. */
    fun mimeType(contentType: String?): String? =
        contentType?.substringBefore(';')?.trim()?.lowercase()?.ifEmpty { null }

    /** JSON, XML, form, GraphQL and `text/` types (except server-sent events). */
    fun isTextType(contentType: String?): Boolean {
        val mime = mimeType(contentType) ?: return false
        if (mime in TEXT_TYPES) return true
        if (TEXT_SUFFIXES.any { mime.endsWith(it) }) return true
        return mime.startsWith("text/") && mime != EVENT_STREAM
    }

    fun isEventStream(contentType: String?): Boolean = mimeType(contentType) == EVENT_STREAM

    /** A Content-Encoding as compared ([RawBody.encoding]): lower case, null for none or `identity`. */
    fun encoding(contentEncoding: String?): String? =
        contentEncoding?.trim()?.lowercase()?.takeIf { it.isNotEmpty() && it != "identity" }

    /** Why the text of a body with these headers is not captured, or null when it is. */
    fun omission(contentType: String?, encoding: String?): HttpBodyOmission? = when {
        !isTextType(contentType) -> HttpBodyOmission.TYPE
        encoding != null && !isGzip(encoding) -> HttpBodyOmission.ENCODING
        else -> null
    }

    fun decode(raw: RawBody): HttpBody {
        val bytes = raw.bytes
        if (raw.omitted != null || bytes == null) {
            return HttpBody(raw.size, raw.contentType, null, truncated = false, omitted = raw.omitted)
        }
        var cut = raw.cut
        val plain = if (raw.encoding != null && isGzip(raw.encoding)) {
            val gunzipped = gunzip(bytes)
                ?: return HttpBody(raw.size, raw.contentType, null, truncated = false, omitted = HttpBodyOmission.ERROR)
            if (gunzipped.second) cut = true
            gunzipped.first
        } else {
            bytes
        }
        var text = decodeText(plain, charsetOf(raw.contentType), complete = !cut)
        if (HttpRedaction.isFormContentType(raw.contentType)) text = HttpRedaction.redactPairs(text)
        val capped = HttpText.capUtf8(text, MAX_HTTP_BODY_BYTES)
        return HttpBody(raw.size, raw.contentType, capped, truncated = cut || capped.length != text.length, omitted = null)
    }

    private fun isGzip(encoding: String): Boolean = encoding == "gzip" || encoding == "x-gzip"

    /**
     * At most [MAX_HTTP_BODY_BYTES] of output and whether it is only a prefix (input cut or corrupt, or more output);
     * null when not even a prefix could be read.
     */
    private fun gunzip(bytes: ByteArray): Pair<ByteArray, Boolean>? {
        val out = ByteArrayOutputStream()
        var partial = false
        try {
            GZIPInputStream(ByteArrayInputStream(bytes), GZIP_BUFFER).use { input ->
                val buffer = ByteArray(GZIP_BUFFER)
                while (true) {
                    val room = MAX_HTTP_BODY_BYTES - out.size()
                    if (room == 0) {
                        partial = input.read() != -1
                        break
                    }
                    val read = input.read(buffer, 0, minOf(room, buffer.size))
                    if (read == -1) break
                    out.write(buffer, 0, read)
                }
            }
        } catch (e: IOException) {
            // A cut stream (EOFException) or corrupt data: keep what was inflated.
            if (out.size() == 0) return null
            partial = true
        }
        return out.toByteArray() to partial
    }

    /** `charset=` of [contentType], UTF-8 when missing or unknown. */
    private fun charsetOf(contentType: String?): Charset {
        val parameter = contentType?.split(';')?.drop(1)?.map { it.trim() }
            ?.firstOrNull { it.startsWith("charset=", ignoreCase = true) }
            ?: return Charsets.UTF_8
        val name = parameter.substringAfter('=').trim().trim('"')
        return try {
            Charset.forName(name)
        } catch (e: IllegalArgumentException) {
            Charsets.UTF_8
        }
    }

    /** Malformed input is replaced; an incomplete sequence at the end of a cut body is left out. */
    private fun decodeText(bytes: ByteArray, charset: Charset, complete: Boolean): String {
        val decoder = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
        val input = ByteBuffer.wrap(bytes)
        val output = CharBuffer.allocate((bytes.size * decoder.maxCharsPerByte().toDouble()).toInt() + 1)
        decoder.decode(input, output, complete)
        if (complete) decoder.flush(output)
        output.flip()
        return output.toString()
    }
}
