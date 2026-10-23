package io.github.risyadul.lionscope

import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import okio.BufferedSink
import okio.GzipSink
import okio.buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

/** The interceptor against a real OkHttp and MockWebServer, recording into a v7 session [FakeLink]. */
class OkHttpCaptureTest {
    private val net = NetworkHarness()
    private val r = HTTP_REDACTED
    private val json = "application/json".toMediaType()

    @After
    fun tearDown() = net.close()

    private fun Map<*, *>.body(): Map<*, *> = this["body"] as Map<*, *>

    private fun Map<*, *>.headers(): List<Pair<Any?, Any?>> = (this["headers"] as List<*>).map { (it as List<*>)[0] to it[1] }

    @Test
    fun recordsARequestAndItsResponseWithRedactionAndTiming() {
        net.session()
        val body = "{\"items\":[{\"id\":42,\"name\":\"Coffee beans\"}],\"next\":\"page3\"}"
        net.server.enqueue(
            MockResponse().setBody(body)
                .setHeader("Content-Type", "application/json; charset=utf-8")
                .addHeader("Set-Cookie", "sid=secret")
                .addHeader("X-Session-Id", "abc"),
        )
        val before = System.currentTimeMillis()
        val request = Request.Builder().url(net.url("/v1/items?page=2&token=abc"))
            .header("Accept", "application/json")
            .header("Authorization", "Bearer abc")
            .build()
        val text = net.client().newCall(request).execute().use { it.body!!.string() }
        val after = System.currentTimeMillis()
        assertEquals(body, text)

        val sent = net.request()
        assertEquals(1.0, sent["id"])
        assertTrue((sent["ts"] as Double).toLong() in before..after)
        assertEquals("GET", sent["method"])
        assertEquals("${net.base}v1/items?page=2&token=$r", sent["url"])
        assertEquals(listOf("Accept" to "application/json", "Authorization" to r), sent.headers())
        assertNull(sent["body"])
        assertNull(sent["mockId"])
        assertEquals(0.0, sent["dropped"])

        val received = net.response()
        assertEquals(1.0, received["id"])
        assertEquals(200.0, received["status"])
        assertEquals("http/1.1", received["protocol"])
        assertTrue(received.headers().containsAll(listOf("Set-Cookie" to r, "X-Session-Id" to r)))
        assertEquals(body, received.body()["text"])
        assertEquals(body.length.toDouble(), received.body()["size"])
        assertEquals("application/json; charset=utf-8", received.body()["contentType"])
        assertEquals(false, received.body()["truncated"])
        val headersMs = received["headersMs"] as Double
        val durationMs = received["durationMs"] as Double
        assertTrue(headersMs <= durationMs)
        assertTrue((received["ts"] as Double) - (sent["ts"] as Double) - durationMs in -1.0..1.0)
        assertNull(received["error"])
    }

    @Test
    fun aSlowBodyEndsLaterThanItsHeaders() {
        net.session()
        net.server.enqueue(MockResponse().setBody("x".repeat(64)).throttleBody(16, 100, TimeUnit.MILLISECONDS))
        net.client().newCall(Request.Builder().url(net.url("/slow")).build()).execute().use { it.body!!.string() }
        val received = net.response()
        assertTrue((received["durationMs"] as Double) - (received["headersMs"] as Double) >= 250.0)
        assertEquals(64.0, received.body()["size"])
    }

    @Test
    fun requestBodiesByType() {
        net.session()
        repeat(8) { net.server.enqueue(MockResponse()) }
        val client = net.client()
        fun post(body: RequestBody) = client.newCall(Request.Builder().url(net.url("/v1/cart")).post(body).build()).execute().close()

        post("{\"sku\":\"A-1\",\"qty\":2}".toRequestBody(json))
        post(FormBody.Builder().add("user", "ana").add("password", "hunter2").build())
        post(MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("note", "hi").build())
        post(ByteArray(10) { it.toByte() }.toRequestBody("application/octet-stream".toMediaType()))
        val large = "[" + "1,".repeat(50_000) + "1]"
        post(large.toRequestBody(json))
        val oneShot = object : RequestBody() {
            override fun contentType() = json
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                sink.writeUtf8("{\"once\":true}")
            }
        }
        post(oneShot)
        // Not one-shot, but of unknown length: never written a second time.
        val unknownLength = object : RequestBody() {
            override fun contentType() = json
            override fun writeTo(sink: BufferedSink) {
                sink.writeUtf8("{\"stream\":true}")
            }
        }
        post(unknownLength)
        val huge = "[" + "2,".repeat(600_000) + "2]"
        post(huge.toRequestBody(json))

        val bodies = net.messages("httpRequest").map { it.body() }
        assertEquals("{\"sku\":\"A-1\",\"qty\":2}", bodies[0]["text"])
        assertEquals(21.0, bodies[0]["size"])
        assertEquals("user=ana&password=$r", bodies[1]["text"])
        assertEquals("type", bodies[2]["omitted"])
        assertTrue((bodies[2]["contentType"] as String).startsWith("multipart/form-data"))
        assertEquals("type", bodies[3]["omitted"])
        assertEquals(10.0, bodies[3]["size"])
        assertEquals(large.length.toDouble(), bodies[4]["size"])
        assertEquals(MAX_HTTP_BODY_BYTES, (bodies[4]["text"] as String).length)
        assertEquals(true, bodies[4]["truncated"])
        assertEquals("one_shot", bodies[5]["omitted"])
        assertNull(bodies[5]["text"])
        assertEquals("one_shot", bodies[6]["omitted"])
        assertNull(bodies[6]["size"])
        assertEquals("one_shot", bodies[7]["omitted"]) // Over 1 MB.
        assertEquals(huge.length.toDouble(), bodies[7]["size"])
        assertNull(bodies[7]["text"])

        // The server got every body intact, the one-shot one written once.
        val received = List(8) { net.server.takeRequest().body.readUtf8() }
        assertEquals("password=hunter2", received[1].substringAfter('&'))
        assertEquals(large, received[4])
        assertEquals("{\"once\":true}", received[5])
        assertEquals("{\"stream\":true}", received[6])
        assertEquals(huge, received[7])
    }

    @Test
    fun responseBodiesAreCappedAndTheAppGetsEveryByte() {
        net.session()
        val large = "[" + "1,".repeat(50_000) + "1]"
        net.server.enqueue(MockResponse().setBody(large).setHeader("Content-Type", "application/json"))
        val png = ByteArray(48_213) { (it * 7).toByte() }
        net.server.enqueue(MockResponse().setBody(Buffer().write(png)).setHeader("Content-Type", "image/png"))
        val client = net.client()
        val text = client.newCall(Request.Builder().url(net.url("/large")).build()).execute().use { it.body!!.string() }
        val bytes = client.newCall(Request.Builder().url(net.url("/png")).build()).execute().use { it.body!!.bytes() }
        assertEquals(large, text)
        assertArrayEquals(png, bytes)

        val (json, image) = net.messages("httpResponse").map { it.body() }
        assertEquals(large.length.toDouble(), json["size"])
        assertEquals(large.substring(0, MAX_HTTP_BODY_BYTES), json["text"])
        assertEquals(true, json["truncated"])
        assertEquals(48_213.0, image["size"])
        assertEquals("type", image["omitted"])
        assertNull(image["text"])
    }

    private fun gzip(text: String): Buffer {
        val out = Buffer()
        GzipSink(out).buffer().use { it.writeUtf8(text) }
        return out
    }

    @Test
    fun gzipIsDecodedWhenTheAppAskedForItItself() {
        net.session()
        val body = "{\"name\":\"Kopi ✓\"}"
        val zipped = gzip(body)
        val zippedSize = zipped.size
        net.server.enqueue(
            MockResponse().setBody(zipped).setHeader("Content-Encoding", "gzip").setHeader("Content-Type", "application/json"),
        )
        // A long text whose compressed form is over 64 KB: only its first 64 KB are kept and inflated.
        val random = java.util.Random(7)
        val noisy = (1..60_000).joinToString(",") { random.nextInt().toString(36) }
        val noisyZipped = gzip(noisy)
        assertTrue(noisyZipped.size > MAX_HTTP_BODY_BYTES)
        net.server.enqueue(
            MockResponse().setBody(noisyZipped).setHeader("Content-Encoding", "gzip").setHeader("Content-Type", "text/plain"),
        )
        // OkHttp's own (transparent) gzip: the interceptor sees the plain body.
        net.server.enqueue(
            MockResponse().setBody(gzip(body)).setHeader("Content-Encoding", "gzip").setHeader("Content-Type", "application/json"),
        )
        val client = net.client()
        fun get(path: String, appGzip: Boolean): ByteArray {
            val request = Request.Builder().url(net.url(path))
            if (appGzip) request.header("Accept-Encoding", "gzip")
            return client.newCall(request.build()).execute().use { it.body!!.bytes() }
        }
        assertEquals(zippedSize.toInt(), get("/gzip", appGzip = true).size) // The app inflates it itself.
        get("/noisy", appGzip = true)
        assertEquals(body, String(get("/transparent", appGzip = false), Charsets.UTF_8))

        val (small, cut, transparent) = net.messages("httpResponse").map { it.body() }
        assertEquals(body, small["text"])
        assertEquals(zippedSize.toDouble(), small["size"]) // Bytes as the app saw them.
        assertEquals(false, small["truncated"])
        assertEquals(true, cut["truncated"])
        assertTrue(noisy.startsWith(cut["text"] as String) && (cut["text"] as String).isNotEmpty())
        assertEquals(body, transparent["text"])
        assertEquals(StackFrames.utf8Length(body).toDouble(), transparent["size"])
    }

    @Test
    fun unsupportedEncodingsAreFlaggedNotDecoded() {
        net.session()
        net.server.enqueue(
            MockResponse().setBody(Buffer().write(byteArrayOf(1, 2, 3, 4))).setHeader("Content-Encoding", "br")
                .setHeader("Content-Type", "application/json"),
        )
        val request = Request.Builder().url(net.url("/br")).header("Accept-Encoding", "br").build()
        val bytes = net.client().newCall(request).execute().use { it.body!!.bytes() }
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), bytes)
        val body = net.response().body()
        assertEquals("encoding", body["omitted"])
        assertEquals(4.0, body["size"])
        assertNull(body["text"])
    }

    @Test
    fun streamingAndBodilessResponsesAreReportedAtTheirHeaders() {
        net.session()
        net.server.enqueue(MockResponse().setBody("data: 1\n\n").setHeader("Content-Type", "text/event-stream"))
        net.server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setHeader("Content-Length", "123"))
        net.server.enqueue(MockResponse().setResponseCode(204))
        val client = net.client()
        client.newCall(Request.Builder().url(net.url("/events")).build()).execute().use { response ->
            // Reported before the app reads anything.
            val events = net.response().body()
            assertEquals("streaming", events["omitted"])
            assertEquals(net.response()["headersMs"], net.response()["durationMs"])
            assertEquals("data: 1\n\n", response.body!!.string())
        }
        client.newCall(Request.Builder().url(net.url("/head")).head().build()).execute().close()
        client.newCall(Request.Builder().url(net.url("/none")).delete().build()).execute().close()
        val (_, head, noContent) = net.messages("httpResponse")
        assertEquals(0.0, head.body()["size"])
        assertNull(head.body()["omitted"])
        assertEquals(204.0, noContent["status"])
        assertEquals(0.0, noContent.body()["size"])
        assertEquals(noContent["headersMs"], noContent["durationMs"])
        assertEquals(3, net.messages("httpRequest").size)
    }

    @Test
    fun aBodyClosedBeforeItsEndIsTruncatedWithWhatTheAppRead() {
        net.session()
        net.server.enqueue(MockResponse().setBody("x".repeat(100_000)).setHeader("Content-Type", "text/plain"))
        net.client().newCall(Request.Builder().url(net.url("/")).build()).execute().use { response ->
            response.body!!.source().readUtf8(10)
            assertTrue(net.messages("httpResponse").isEmpty()) // Not ended yet.
        }
        val body = net.response().body()
        assertEquals(100_000.0, body["size"]) // The Content-Length, not what was read.
        assertEquals(true, body["truncated"])
        assertTrue((body["text"] as String).startsWith("xxxxxxxxxx"))
        assertTrue((body["text"] as String).length < 100_000)
        assertEquals(1, net.messages("httpResponse").size)

        // Chunked: no Content-Length, so no size.
        net.server.enqueue(MockResponse().setChunkedBody("y".repeat(50_000), 1024).setHeader("Content-Type", "text/plain"))
        net.client().newCall(Request.Builder().url(net.url("/chunked")).build()).execute().use { it.body!!.source().readUtf8(5) }
        val chunked = net.messages("httpResponse").last().body()
        assertNull(chunked["size"])
        assertEquals(true, chunked["truncated"])
        assertTrue((chunked["text"] as String).startsWith("yyyyy"))

        // Every byte of the Content-Length read, then closed without reading EOF: complete.
        net.server.enqueue(MockResponse().setBody("{\"a\":1}").setHeader("Content-Type", "application/json"))
        net.client().newCall(Request.Builder().url(net.url("/exact")).build()).execute().use { it.body!!.source().readUtf8(7) }
        val exact = net.messages("httpResponse").last().body()
        assertEquals(7.0, exact["size"])
        assertEquals(false, exact["truncated"])
        assertEquals("{\"a\":1}", exact["text"])
    }

    @Test
    fun anSdkFailureNeverFailsOrChangesTheCall() {
        net.session()
        for (failure in listOf<Throwable>(IllegalStateException("link broke"), AssertionError("encoder broke"))) {
            net.link.v7Failure = failure
            net.server.enqueue(
                MockResponse().setBody("{\"ok\":true}").setHeader("Content-Type", "application/json").setHeader("X-Kept", "1"),
            )
            net.client().newCall(Request.Builder().url(net.url("/safe")).build()).execute().use { response ->
                assertEquals(200, response.code)
                assertEquals("1", response.header("X-Kept"))
                assertEquals("{\"ok\":true}", response.body!!.string())
            }
        }
        assertTrue(net.link.v7Lines.isEmpty())
        assertTrue(net.logs.any { it.contains("IllegalStateException") })
        assertTrue(net.logs.none { it.contains("link broke") }) // Class names only: a message can hold request data.

        // The request was recorded, then the link fails while the response is recorded (at its headers or its end).
        net.link.v7Failure = null
        val body = "{\"ok\":true}"
        for (contentType in listOf("application/json", "text/event-stream")) {
            net.server.enqueue(MockResponse().setBody(body).setHeader("Content-Type", contentType))
            val failingLater = net.client {
                addNetworkInterceptor { chain ->
                    net.link.v7Failure = IllegalStateException("link broke later")
                    chain.proceed(chain.request())
                }
            }
            failingLater.newCall(Request.Builder().url(net.url("/later")).build()).execute().use { response ->
                assertEquals(200, response.code)
                assertEquals(body, response.body!!.string())
            }
            net.link.v7Failure = null
        }
        assertEquals(2, net.messages("httpRequest").size)
        assertTrue(net.messages("httpResponse").isEmpty())
    }

    @Test
    fun theResponseBodyIsReadOnlyByTheAppAndOnlyOnce() {
        net.session()
        val body = "y".repeat(200_000)
        net.server.enqueue(MockResponse().setBody(body).setHeader("Content-Type", "text/plain"))
        net.server.enqueue(MockResponse().setBody(body).setHeader("Content-Type", "text/plain"))
        val client = net.client()
        assertEquals(body, client.newCall(Request.Builder().url(net.url("/a")).build()).execute().use { it.body!!.string() })
        assertEquals(body.length.toLong(), net.networkBodyBytes.get())
        assertEquals(1, net.server.requestCount)

        // An app that closes without reading: the SDK reads nothing either.
        net.networkBodyBytes.set(0)
        client.newCall(Request.Builder().url(net.url("/b")).build()).execute().close()
        assertEquals(0L, net.networkBodyBytes.get())
        val unread = net.messages("httpResponse").last().body()
        assertEquals(body.length.toDouble(), unread["size"]) // Not read, so not complete: the Content-Length.
        assertEquals("", unread["text"])
        assertEquals(true, unread["truncated"])
    }

    @Test
    fun theAppsOwnExceptionsPropagateUnchanged() {
        net.session()
        val thrown = IOException("boom")
        net.server.enqueue(MockResponse())
        val client = net.client {
            addNetworkInterceptor { throw thrown }
        }
        try {
            client.newCall(Request.Builder().url(net.url("/fail")).build()).execute()
            fail("expected the app's exception")
        } catch (e: IOException) {
            assertSame(thrown, e)
        }
        val error = net.response()["error"] as Map<*, *>
        assertEquals("io", error["kind"])
        assertEquals("IOException: boom", error["message"])
        assertNull(net.response()["status"])

        // Exception messages are redacted as free text and capped.
        val leaky = IOException("failed https://ana:pw@api.example.com/x?token=abc with Bearer xyz " + "z".repeat(500))
        try {
            net.client { addNetworkInterceptor { throw leaky } }.newCall(Request.Builder().url(net.url("/fail")).build()).execute()
            fail("expected the app's exception")
        } catch (e: IOException) {
            assertSame(leaky, e)
        }
        val message = (net.messages("httpResponse").last()["error"] as Map<*, *>)["message"] as String
        assertTrue(message, message.startsWith("IOException: failed https://$r@api.example.com/x?token=$r with Bearer $r zzz"))
        assertEquals(160, message.length)

        val runtime = IllegalArgumentException("bad header")
        val failing = net.client { addNetworkInterceptor { throw runtime } }
        try {
            failing.newCall(Request.Builder().url(net.url("/fail")).build()).execute()
            fail("expected the app's exception")
        } catch (e: IllegalArgumentException) {
            assertSame(runtime, e)
        }
    }

    @Test
    fun failuresAreClassified() {
        net.session()
        // Timeout: the server never answers.
        net.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val timeouts = net.client { readTimeout(200, TimeUnit.MILLISECONDS) }
        expectIOException { timeouts.newCall(Request.Builder().url(net.url("/timeout")).build()).execute() }
        // Connection refused: a port nobody listens on.
        val closedPort = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        expectIOException { net.client().newCall(Request.Builder().url("http://127.0.0.1:$closedPort/").build()).execute() }
        // Canceled while waiting for headers.
        net.server.enqueue(MockResponse().setHeadersDelay(2, TimeUnit.SECONDS))
        val call = net.client().newCall(Request.Builder().url(net.url("/cancel")).build())
        Thread {
            Thread.sleep(200)
            call.cancel()
        }.start()
        expectIOException { call.execute() }
        // A body cut by the server: the read fails in the app, the record keeps the status.
        net.server.enqueue(
            MockResponse().setBody("z".repeat(50_000)).setHeader("Content-Type", "text/plain")
                .setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY),
        )
        expectIOException {
            net.client().newCall(Request.Builder().url(net.url("/cut")).build()).execute().use { it.body!!.string() }
        }

        val errors = net.messages("httpResponse").map { it["error"] as Map<*, *> }
        assertEquals(listOf("timeout", "connection", "canceled", "io"), errors.map { it["kind"] })
        assertTrue((errors[0]["message"] as String).startsWith("SocketTimeoutException"))
        assertTrue((errors[1]["message"] as String).startsWith("ConnectException"))
        assertEquals(200.0, net.messages("httpResponse")[3]["status"])
    }

    private fun expectIOException(block: () -> Unit) {
        try {
            block()
            fail("expected an IOException")
        } catch (e: IOException) {
            // Expected.
        }
    }

    @Test
    fun nothingIsRecordedOutsideAV7Session() {
        val client = net.client()
        fun call() {
            net.server.enqueue(MockResponse().setBody("ok"))
            assertEquals("ok", client.newCall(Request.Builder().url(net.url("/")).build()).execute().use { it.body!!.string() })
        }
        call() // Never connected.
        net.session(inspectOnly = true)
        call() // An inspect-only link.
        net.endSession()
        net.session(version = DEVICE_PROTOCOL_V5)
        call() // A session below v7.
        net.endSession()
        net.session(proven = false)
        call() // A v7 session without a valid link proof.
        net.endSession()
        net.session()
        net.endSession()
        call() // After the session ended.
        assertTrue(net.link.v7Lines.isEmpty())
        assertTrue(!net.capture.isActive)
    }

    @Test
    fun overTheRateCapExchangesAreCountedAndReportedAsDropped() {
        var now = 0L
        NetworkHarness(nanoTime = { now }).use { capped ->
            capped.session()
            repeat(HTTP_EXCHANGE_BURST + 3) { capped.server.enqueue(MockResponse()) }
            val client = capped.client()
            repeat(HTTP_EXCHANGE_BURST + 2) { client.newCall(Request.Builder().url(capped.url("/")).build()).execute().close() }
            assertEquals(HTTP_EXCHANGE_BURST, capped.messages("httpRequest").size)
            now += 1_000_000_000L / HTTP_EXCHANGES_PER_SECOND // One token later.
            client.newCall(Request.Builder().url(capped.url("/")).build()).execute().close()
            val last = capped.messages("httpRequest").last()
            assertEquals(2.0, last["dropped"])
            assertEquals((HTTP_EXCHANGE_BURST + 1).toDouble(), last["id"])
        }
    }

    @Test
    fun aNetworkInterceptorRecordsToo() {
        net.session()
        net.server.enqueue(MockResponse().setBody("{}").setHeader("Content-Type", "application/json"))
        net.client(network = true).newCall(Request.Builder().url(net.url("/n")).build()).execute().use { it.body!!.string() }
        assertEquals("{}", net.response().body()["text"])
        // Below OkHttp's bridge: it sees the headers OkHttp adds.
        assertTrue(net.request().headers().any { it.first == "Host" })
    }
}
