package io.github.risyadul.lionscope

import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Sink
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.PortUnreachableException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The OkHttp side of the network inspector: the only classes of the SDK that reference `okhttp3` / `okio` (OkHttp is
 * `compileOnly`; an app that never calls `Lionscope.okHttpInterceptor()` never loads them). Built against OkHttp
 * 4.12 and tested against 4.12 and 5.x, which keep the JVM signatures used here.
 *
 * As an application interceptor: records each exchange and answers matching mock rules without a network call. As a
 * network interceptor (`chain.connection() != null`) it records but never mocks. Inactive (no v7 profiling session)
 * it costs one volatile read and calls `chain.proceed(chain.request())`. Any SDK failure is contained (the call goes
 * on unchanged); the app's own exceptions from `proceed` and from reading the body are rethrown untouched, and the
 * response body is read only by the app, exactly once.
 */
internal class LionscopeOkHttpInterceptor(private val capture: NetworkCapture) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        if (!capture.isActive) return chain.proceed(chain.request())
        val exchange = capture.guarded("capture", null) { OkHttpExchange.begin(capture, chain) }
            ?: return chain.proceed(chain.request())
        return exchange.run(chain)
    }

    companion object {
        /** The process-wide instance behind `Lionscope.okHttpInterceptor()`. */
        val shared = LionscopeOkHttpInterceptor(NetworkCapture.shared)
    }
}

/**
 * Catches every Throwable except VirtualMachineError, ThreadDeath and LinkageError, logs one line per place and kind,
 * and returns [fallback]: an SDK failure never fails or changes the app's call.
 */
internal inline fun <T> NetworkCapture.guarded(where: String, fallback: T, block: () -> T): T = try {
    block()
} catch (t: Throwable) {
    if (t is VirtualMachineError || t is ThreadDeath || t is LinkageError) throw t
    onSdkFailure(where, t)
    fallback
}

/** One call through the interceptor: [recording] null when it is not recorded (rate cap), [rule] the mock to answer. */
private class OkHttpExchange(
    private val capture: NetworkCapture,
    private val recording: NetworkCapture.Recording?,
    private val request: Request,
    private val rule: MockRule?,
    private val mockResponse: Response?,
) {
    fun run(chain: Interceptor.Chain): Response {
        val prepared = mockResponse
        return if (rule != null && (prepared != null || rule.action != MockAction.RESPOND)) {
            answer(chain, rule, prepared)
        } else {
            proceed(chain)
        }
    }

    private fun proceed(chain: Interceptor.Chain): Response {
        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            failed(chain, e)
            throw e
        } catch (e: RuntimeException) {
            failed(chain, e)
            throw e
        }
        return capture.guarded("response", response) { onResponse(response, mocked = false) }
    }

    /** Delay (cancellable), then the rule's response or failure. */
    private fun answer(chain: Interceptor.Chain, rule: MockRule, prepared: Response?): Response {
        capture.guarded("mock log", Unit) { capture.logMocked(request.method, request.url.toString(), rule) }
        try {
            delay(chain, rule.delayMs)
            when (rule.action) {
                MockAction.TIMEOUT -> throw SocketTimeoutException("timeout (Lionscope mock ${rule.id})")
                MockAction.CONNECTION_ERROR -> throw ConnectException("Failed to connect (Lionscope mock ${rule.id})")
                MockAction.RESPOND -> Unit
            }
        } catch (e: IOException) {
            failed(chain, e)
            throw e
        }
        // Only `respond` gets here, always with its prepared response.
        prepared ?: return proceed(chain)
        val response = capture.guarded("mock", prepared) {
            val now = System.currentTimeMillis()
            prepared.newBuilder().sentRequestAtMillis(now).receivedResponseAtMillis(now).build()
        }
        return capture.guarded("response", response) { onResponse(response, mocked = true) }
    }

    /** Waits [delayMs] in [DELAY_SLICE_MS] slices; a cancelled (or call-timed-out) call throws `IOException("Canceled")`. */
    private fun delay(chain: Interceptor.Chain, delayMs: Int) {
        if (delayMs <= 0) return
        val end = System.nanoTime() + delayMs * NANOS_PER_MS
        while (true) {
            if (chain.call().isCanceled()) throw IOException("Canceled")
            val remainingMs = (end - System.nanoTime() + NANOS_PER_MS - 1) / NANOS_PER_MS
            if (remainingMs <= 0) return
            try {
                Thread.sleep(minOf(remainingMs, DELAY_SLICE_MS))
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                throw InterruptedIOException("interrupted")
            }
        }
    }

    private fun failed(chain: Interceptor.Chain, e: Throwable) {
        val recording = recording ?: return
        capture.guarded("failure", Unit) {
            val canceled = capture.guarded("failure", false) { chain.call().isCanceled() }
            val durationMs = capture.elapsedMs(recording)
            capture.sendResponse(
                recording,
                HttpResponseRecord(
                    id = recording.id,
                    ts = endTs(recording, durationMs),
                    status = null,
                    protocol = null,
                    headers = emptyList(),
                    body = null,
                    headersMs = null,
                    durationMs = durationMs,
                    error = failureOf(e, canceled),
                ),
            )
        }
    }

    /** Records the response; wraps its body unless the exchange ends at its headers (bodiless, streaming). */
    private fun onResponse(response: Response, mocked: Boolean): Response {
        val recording = recording ?: return response
        val headersMs = capture.elapsedMs(recording)
        val status = response.code
        val headers = snapshot(response.headers)
        val protocol = if (mocked) null else response.protocol.toString()
        val body: ResponseBody? = response.body
        val contentType = body?.contentType()?.toString() ?: response.header(CONTENT_TYPE)
        val encoding = HttpBodies.encoding(response.header(CONTENT_ENCODING))
        val atHeaders = { raw: RawBody? ->
            capture.sendResponse(
                recording,
                HttpResponseRecord(
                    recording.id, endTs(recording, headersMs), status, protocol, headers, raw, headersMs, headersMs, null,
                ),
            )
            response
        }
        if (body == null) return atHeaders(null)
        val length = body.contentLength()
        val streaming = status == SWITCHING_PROTOCOLS || HttpBodies.isEventStream(contentType) ||
            request.body?.isDuplex() == true
        if (streaming) {
            return atHeaders(RawBody(length.takeIf { it >= 0 }, contentType, null, false, HttpBodyOmission.STREAMING))
        }
        val bodiless = request.method == HEAD || status == NO_CONTENT || status == NOT_MODIFIED ||
            status in INFORMATIONAL || length == 0L
        if (bodiless) return atHeaders(RawBody(0, contentType, null, false, null))
        val tap = BodyTap(capture, recording, status, protocol, headers, headersMs, contentType, encoding)
        return response.newBuilder().body(TappedResponseBody(body, tap)).build()
    }

    companion object {
        private const val NANOS_PER_MS = 1_000_000L
        private const val DELAY_SLICE_MS = 50L
        private const val SWITCHING_PROTOCOLS = 101
        private const val NO_CONTENT = 204
        private const val NOT_MODIFIED = 304
        private val INFORMATIONAL = 100..199
        private const val HEAD = "HEAD"
        private const val CONTENT_TYPE = "Content-Type"
        private const val CONTENT_ENCODING = "Content-Encoding"
        /** Headers kept per side before encoding; the encoder keeps at most [MAX_HTTP_HEADERS] of them. */
        private const val MAX_SNAPSHOT_HEADERS = 2 * MAX_HTTP_HEADERS

        /** Null when there is nothing to do: not recorded (rate cap) and no mock answers it. */
        fun begin(capture: NetworkCapture, chain: Interceptor.Chain): OkHttpExchange? {
            val request = chain.request()
            val networkInterceptor = chain.connection() != null
            if (networkInterceptor) {
                capture.noticeOnce(
                    "network-interceptor",
                    "Lionscope.okHttpInterceptor() was added with addNetworkInterceptor: it records but never mocks; " +
                        "add it with addInterceptor (last) instead",
                )
            }
            val url = request.url.toString()
            var rule = if (networkInterceptor) null else capture.findMock(request.method, url)
            // Built before anything is recorded: if the SDK can't build the answer, the call goes to the network.
            val mockResponse = if (rule?.action == MockAction.RESPOND) {
                capture.guarded("mock", null) { mockResponse(request, rule) }
            } else {
                null
            }
            if (rule?.action == MockAction.RESPOND && mockResponse == null) rule = null
            val recording = capture.begin()
            if (recording == null && rule == null) return null
            if (recording != null) {
                capture.sendRequest(
                    recording,
                    HttpRequestRecord(
                        id = recording.id,
                        ts = recording.ts,
                        method = request.method,
                        url = url,
                        headers = snapshot(request.headers),
                        body = request.body?.let { requestBody(request, it) },
                        mockId = rule?.id,
                        dropped = capture.takeDropped(),
                    ),
                )
            }
            return OkHttpExchange(capture, recording, request, rule, mockResponse)
        }

        private fun mockResponse(request: Request, rule: MockRule): Response {
            val headers = Headers.Builder()
            for ((name, value) in rule.headers) headers.addUnsafeNonAscii(name, value)
            val built = headers.build()
            val contentType: MediaType? = built[CONTENT_TYPE]?.toMediaTypeOrNull()
            val now = System.currentTimeMillis()
            return Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(rule.status)
                .message(reasonPhrase(rule.status))
                .headers(built)
                .body(rule.body.toResponseBody(contentType))
                .sentRequestAtMillis(now)
                .receivedResponseAtMillis(now)
                .build()
        }

        /**
         * Duplex → streaming; not a text type or an encoding the SDK can't decode → type / encoding; one-shot →
         * one_shot; otherwise written once more into a sink that keeps the first [MAX_HTTP_BODY_BYTES] and counts the
         * rest (repeatable bodies may be written any number of times). A failing write → error.
         */
        private fun requestBody(request: Request, body: RequestBody): RawBody {
            val contentType = body.contentType()?.toString() ?: request.header(CONTENT_TYPE)
            val encoding = HttpBodies.encoding(request.header(CONTENT_ENCODING))
            val size = try {
                body.contentLength().takeIf { it >= 0 }
            } catch (e: IOException) {
                null
            }
            if (body.isDuplex()) return RawBody(size, contentType, null, false, HttpBodyOmission.STREAMING)
            HttpBodies.omission(contentType, encoding)?.let { return RawBody(size, contentType, null, false, it) }
            if (body.isOneShot()) return RawBody(size, contentType, null, false, HttpBodyOmission.ONE_SHOT)
            val sink = CappingSink()
            try {
                val buffered = sink.buffer()
                body.writeTo(buffered)
                buffered.flush()
            } catch (e: Exception) {
                return RawBody(size, contentType, null, false, HttpBodyOmission.ERROR)
            }
            return RawBody(sink.total, contentType, sink.bytes(), sink.total > MAX_HTTP_BODY_BYTES, null, encoding)
        }

        fun snapshot(headers: Headers): List<Pair<String, String>> {
            val count = minOf(headers.size, MAX_SNAPSHOT_HEADERS)
            return List(count) { headers.name(it) to headers.value(it) }
        }

        fun endTs(recording: NetworkCapture.Recording, durationMs: Double): Long = recording.ts + Math.round(durationMs)

        /** `timeout`, `connection`, `canceled` or `io`, with `SimpleClassName: message`. */
        fun failureOf(e: Throwable, canceled: Boolean): HttpFailure {
            val kind = when {
                canceled || (e is IOException && e.message == "Canceled") -> HttpFailureKind.CANCELED
                e is SocketTimeoutException || (e is InterruptedIOException && e.message == "timeout") ->
                    HttpFailureKind.TIMEOUT
                e is ConnectException || e is UnknownHostException || e is NoRouteToHostException ||
                    e is PortUnreachableException -> HttpFailureKind.CONNECTION
                else -> HttpFailureKind.IO
            }
            val name = e.javaClass.simpleName.ifEmpty { e.javaClass.name }
            val message = e.message?.let { "$name: $it" } ?: name
            return HttpFailure(kind, capLength(message, MAX_HTTP_ERROR_CHARS))
        }

        private fun reasonPhrase(status: Int): String = REASONS[status] ?: ""

        private val REASONS = mapOf(
            200 to "OK", 201 to "Created", 202 to "Accepted", 204 to "No Content", 206 to "Partial Content",
            301 to "Moved Permanently", 302 to "Found", 303 to "See Other", 304 to "Not Modified",
            307 to "Temporary Redirect", 308 to "Permanent Redirect",
            400 to "Bad Request", 401 to "Unauthorized", 403 to "Forbidden", 404 to "Not Found",
            405 to "Method Not Allowed", 408 to "Request Timeout", 409 to "Conflict", 410 to "Gone",
            413 to "Content Too Large", 415 to "Unsupported Media Type", 422 to "Unprocessable Content",
            429 to "Too Many Requests",
            500 to "Internal Server Error", 501 to "Not Implemented", 502 to "Bad Gateway",
            503 to "Service Unavailable", 504 to "Gateway Timeout",
        )
    }
}

/** Keeps the first [MAX_HTTP_BODY_BYTES] written and counts everything. */
private class CappingSink : Sink {
    private val kept = Buffer()
    var total = 0L
        private set

    override fun write(source: Buffer, byteCount: Long) {
        val keep = minOf(byteCount, MAX_HTTP_BODY_BYTES - kept.size)
        if (keep > 0) kept.write(source, keep)
        if (byteCount > keep) source.skip(byteCount - keep)
        total += byteCount
    }

    fun bytes(): ByteArray = kept.readByteArray()

    override fun flush() = Unit

    override fun timeout(): Timeout = Timeout.NONE

    override fun close() = Unit
}

/** The app's response body, read through [TapSource]; nothing else changes. */
private class TappedResponseBody(private val delegate: ResponseBody, private val tap: BodyTap) : ResponseBody() {
    private val source: BufferedSource by lazy { TapSource(delegate.source(), tap).buffer() }

    override fun contentType(): MediaType? = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun source(): BufferedSource = source
}

/** Forwards every read unchanged and lets [tap] see the bytes; the delegate's exceptions pass through untouched. */
private class TapSource(delegate: Source, private val tap: BodyTap) : ForwardingSource(delegate) {
    override fun read(sink: Buffer, byteCount: Long): Long {
        val read = try {
            super.read(sink, byteCount)
        } catch (e: IOException) {
            tap.failed(e)
            throw e
        } catch (e: RuntimeException) {
            tap.failed(e)
            throw e
        }
        tap.onRead(sink, read)
        return read
    }

    override fun close() {
        try {
            super.close()
        } finally {
            tap.finish(null)
        }
    }
}

/**
 * Copies up to [MAX_HTTP_BODY_BYTES] of what the app reads (text types only) and counts every byte; sends the
 * exchange's `httpResponse` once, at EOF, at close or when a read fails, whichever comes first.
 */
private class BodyTap(
    private val capture: NetworkCapture,
    private val recording: NetworkCapture.Recording,
    private val status: Int,
    private val protocol: String?,
    private val headers: List<Pair<String, String>>,
    private val headersMs: Double,
    private val contentType: String?,
    private val encoding: String?,
) {
    private val omission = HttpBodies.omission(contentType, encoding)
    private val kept = Buffer()
    private var total = 0L
    private val finished = AtomicBoolean(false)

    fun onRead(sink: Buffer, read: Long) {
        capture.guarded("body", Unit) {
            if (read == -1L) {
                finish(null)
                return@guarded
            }
            synchronized(this) {
                total += read
                val keep = if (omission == null) minOf(read, MAX_HTTP_BODY_BYTES - kept.size) else 0L
                if (keep > 0) sink.copyTo(kept, sink.size - read, keep)
            }
        }
    }

    fun failed(e: Throwable) {
        finish(e)
    }

    fun finish(error: Throwable?) {
        if (!finished.compareAndSet(false, true)) return
        capture.guarded("body", Unit) {
            val durationMs = capture.elapsedMs(recording)
            val raw = synchronized(this) {
                val bytes = if (omission == null) kept.readByteArray() else null
                RawBody(total, contentType, bytes, total > (bytes?.size ?: 0), omission, encoding)
            }
            capture.sendResponse(
                recording,
                HttpResponseRecord(
                    id = recording.id,
                    ts = recording.ts + Math.round(durationMs),
                    status = status,
                    protocol = protocol,
                    headers = headers,
                    body = raw,
                    headersMs = headersMs,
                    durationMs = durationMs,
                    error = error?.let { OkHttpExchange.failureOf(it, canceled = false) },
                ),
            )
        }
    }
}
