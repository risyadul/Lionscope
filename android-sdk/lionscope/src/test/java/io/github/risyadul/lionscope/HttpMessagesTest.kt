package io.github.risyadul.lionscope

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

/** The v7 encoders keep every line inside the server's bounds; bodies decode as the spec says. */
class HttpMessagesTest {
    private val r = HTTP_REDACTED
    private val badChars = Regex("[\\p{Cc}\\p{Cf}]")
    private val token = Regex("[!#$%&'*+.^_`|~0-9A-Za-z-]+")

    private fun request(
        url: String = "https://api.example.com/v1/items",
        headers: List<Pair<String, String>> = emptyList(),
        body: HttpBody? = null,
        method: String = "GET",
        maxLineBytes: Int = MAX_HTTP_LINE_BYTES,
    ): Map<*, *>? = HttpMessages.httpRequest(1, 1_000, method, url, headers, body, "m1", 0, maxLineBytes)
        ?.let { TestJson.parse(it) as Map<*, *> }

    /** What protocol/src/index.ts checks for headers. */
    private fun assertServerHeaders(message: Map<*, *>) {
        val headers = (message["headers"] as List<*>).map { it as List<*> }
        assertTrue(headers.size <= MAX_HTTP_HEADERS)
        var bytes = 0
        for ((name, value) in headers.map { it[0] as String to it[1] as String }) {
            assertTrue(name, token.matches(name) && name.length <= MAX_HTTP_HEADER_NAME_CHARS)
            assertFalse(value, badChars.containsMatchIn(value))
            assertTrue(value.length <= MAX_HTTP_HEADER_VALUE_CHARS)
            bytes += StackFrames.utf8Length(name) + StackFrames.utf8Length(value)
        }
        assertTrue(bytes <= MAX_HTTP_HEADER_BYTES)
    }

    @Test
    fun redactsCleansAndCapsHeaders() {
        val message = checkNotNull(
            request(
                headers = listOf(
                    "Accept" to "application/json",
                    "Authorization" to "Bearer abc",
                    "Cookie" to "sid=1",
                    "X-Api-Key" to "k",
                    "Bad Name" to "dropped",
                    "" to "dropped",
                    "X-Ctl" to "a\u0000b‎c\nd",
                    "X-Long" to "v".repeat(5000),
                ) + List(100) { "X-$it" to "x".repeat(400) },
            ),
        )
        assertServerHeaders(message)
        val headers = (message["headers"] as List<*>).map { (it as List<*>)[0] to it[1] }
        assertEquals(
            listOf("Accept" to "application/json", "Authorization" to r, "Cookie" to r, "X-Api-Key" to r, "X-Ctl" to "a b c d"),
            headers.take(5),
        )
        assertEquals(MAX_HTTP_HEADER_VALUE_CHARS, (headers[5].second as String).length)
    }

    @Test
    fun redactsAndCapsTheUrlAndRefusesNonHttpOnes() {
        val message = checkNotNull(request(url = "https://api.example.com/v1/items?session=abc&q=" + "a".repeat(5000)))
        val url = message["url"] as String
        assertTrue(url.startsWith("https://api.example.com/v1/items?session=$r&q=aaa"))
        assertEquals(MAX_HTTP_URL_CHARS, url.length)
        assertNull(request(url = "ftp://api.example.com/"))
        assertNull(request(method = "GE T"))
        assertNull(request(method = "PROPFINDPROPFIND1"))
        assertEquals("PROPFIND", request(method = "PROPFIND")?.get("method"))
    }

    @Test
    fun cutsTheBodyTextUntilTheLineFits() {
        // Control characters escape to six bytes each: 64 KB of them would make a 384 KB line.
        val text = "\u0001".repeat(MAX_HTTP_BODY_BYTES)
        val body = HttpBody(MAX_HTTP_BODY_BYTES.toLong(), "text/plain", text, truncated = false, omitted = null)
        val line = checkNotNull(HttpMessages.httpRequest(1, 1, "POST", "https://api.example.com/", emptyList(), body, null, 0))
        assertTrue(StackFrames.utf8Length(line) <= MAX_HTTP_LINE_BYTES)
        val sent = (TestJson.parse(line) as Map<*, *>)["body"] as Map<*, *>
        assertEquals(true, sent["truncated"])
        assertTrue((sent["text"] as String).length in 1 until text.length)
        assertEquals(MAX_HTTP_BODY_BYTES.toDouble(), sent["size"])

        val small = request(body = body.copy(text = "x".repeat(10_000)), maxLineBytes = 4_000)?.get("body") as Map<*, *>
        assertEquals(true, small["truncated"])
        assertTrue((small["text"] as String).length < 4_000)
    }

    @Test
    fun responseFieldsAreClampedToTheServersBounds() {
        val line = HttpMessages.httpResponse(
            id = 0,
            ts = 5,
            status = 42,
            protocol = "HTTP/1.1",
            headers = emptyList(),
            body = HttpBody(-1, "", null, truncated = false, omitted = HttpBodyOmission.TYPE),
            headersMs = Double.NaN,
            durationMs = 9e9,
            error = HttpFailure(HttpFailureKind.IO, "IOException: a\n\n" + "b".repeat(400)),
        )
        val message = TestJson.parse(line) as Map<*, *>
        assertEquals(1.0, message["id"])
        assertNull(message["status"])
        assertNull(message["protocol"]) // Not lower case: not sent.
        assertEquals(0.0, message["headersMs"])
        assertEquals(MAX_HTTP_DURATION_MS, message["durationMs"])
        val body = message["body"] as Map<*, *>
        assertNull(body["size"])
        assertNull(body["contentType"])
        assertEquals("type", body["omitted"])
        val error = message["error"] as Map<*, *>
        assertEquals("io", error["kind"])
        assertTrue((error["message"] as String).startsWith("IOException: a b"))
        assertTrue((error["message"] as String).length <= MAX_HTTP_ERROR_CHARS)
        assertEquals(
            "{\"type\":\"mocksApplied\",\"rev\":0,\"count\":32}",
            HttpMessages.mocksApplied(-4, 99),
        )
    }

    private fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    @Test
    fun decodesTextTypesOnly() {
        for (type in listOf(
            "application/json", "application/problem+json; charset=utf-8", "application/xml", "image/svg+xml",
            "text/plain", "text/html", "application/x-www-form-urlencoded", "application/graphql",
            "application/graphql-response+json", "application/vnd.api+graphql", "Text/CSV",
        )) {
            assertTrue(type, HttpBodies.isTextType(type))
        }
        for (type in listOf(
            null, "", "text/event-stream", "multipart/form-data; boundary=x", "image/png", "application/octet-stream",
            "application/x-protobuf", "application/jsonx",
        )) {
            assertFalse(type.toString(), HttpBodies.isTextType(type))
        }
        assertEquals(HttpBodyOmission.ENCODING, HttpBodies.omission("application/json", "br"))
        assertEquals(HttpBodyOmission.TYPE, HttpBodies.omission("image/png", "br"))
        assertNull(HttpBodies.omission("application/json", HttpBodies.encoding("GZIP")))
        assertNull(HttpBodies.encoding(" identity "))
    }

    @Test
    fun gunzipsCharsetDecodesAndRedactsForms() {
        val json = "{\"name\":\"Kopi ✓\"}"
        val zipped = gzip(json.toByteArray())
        val body = HttpBodies.decode(RawBody(zipped.size.toLong(), "application/json", zipped, false, null, "gzip"))
        assertEquals(HttpBody(zipped.size.toLong(), "application/json", json, false, null), body)

        val latin1 = HttpBodies.decode(
            RawBody(3, "text/plain; charset=ISO-8859-1", byteArrayOf(0x63, 0x61, 0xE9.toByte()), false, null),
        )
        assertEquals("caé", latin1.text)
        val unknownCharset = HttpBodies.decode(RawBody(2, "text/plain; charset=\"nope\"", "ok".toByteArray(), false, null))
        assertEquals("ok", unknownCharset.text)
        val malformed = HttpBodies.decode(RawBody(2, "text/plain", byteArrayOf(0x61, 0xFF.toByte()), false, null))
        assertEquals("a�", malformed.text)

        val form = HttpBodies.decode(
            RawBody(30, "application/x-www-form-urlencoded", "user=ana&password=hunter2".toByteArray(), false, null),
        )
        assertEquals("user=ana&password=$r", form.text)
    }

    @Test
    fun cutBodiesKeepTheirPrefix() {
        // A UTF-8 character cut by the 64 KB limit is left out rather than replaced.
        val cut = HttpBodies.decode(RawBody(9_999, "text/plain", "ab".toByteArray() + byteArrayOf(0xE2.toByte(), 0x9C.toByte()), true, null))
        assertEquals(HttpBody(9_999, "text/plain", "ab", true, null), cut)

        // A cut gzip stream yields what inflates.
        val text = (1..20_000).joinToString(",")
        val zipped = gzip(text.toByteArray())
        val prefix = HttpBodies.decode(RawBody(zipped.size.toLong(), "text/plain", zipped.copyOf(zipped.size / 2), true, null, "gzip"))
        assertTrue(prefix.truncated)
        assertTrue(prefix.text!!.isNotEmpty() && text.startsWith(prefix.text!!))

        // More than 64 KB once inflated: cut, flagged.
        val big = "x".repeat(MAX_HTTP_BODY_BYTES * 3)
        val bigZipped = gzip(big.toByteArray())
        val inflated = HttpBodies.decode(RawBody(bigZipped.size.toLong(), "text/plain", bigZipped, false, null, "gzip"))
        assertEquals(MAX_HTTP_BODY_BYTES, inflated.text!!.length)
        assertTrue(inflated.truncated)

        // Not gzip at all: an error, not garbage.
        val broken = HttpBodies.decode(RawBody(4, "text/plain", "nope".toByteArray(), false, null, "gzip"))
        assertEquals(HttpBodyOmission.ERROR, broken.omitted)
        assertNull(broken.text)

        // Decoding can grow text (Latin-1 → UTF-8): it is capped to 64 KB of UTF-8 again.
        val wide = HttpBodies.decode(
            RawBody(MAX_HTTP_BODY_BYTES.toLong(), "text/plain; charset=ISO-8859-1", ByteArray(MAX_HTTP_BODY_BYTES) { 0xE9.toByte() }, false, null),
        )
        assertEquals(MAX_HTTP_BODY_BYTES, StackFrames.utf8Length(wide.text!!))
        assertTrue(wide.truncated)
    }
}
