package io.github.risyadul.lionscope

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import java.io.Closeable
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** A MockWebServer on 127.0.0.1, a [FakeLink] in a (proven) v7 session and an interceptor recording into it. */
internal class NetworkHarness(nanoTime: () -> Long = System::nanoTime) : Closeable {
    val server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
    val link = FakeLink()
    val logs = CopyOnWriteArrayList<String>()
    val capture = NetworkCapture(nanoTime = nanoTime, log = { _, message -> logs += message })
    val interceptor = LionscopeOkHttpInterceptor(capture)

    /** Bytes the network handed to OkHttp for response bodies (read below the interceptor). */
    val networkBodyBytes = AtomicLong()

    init {
        capture.attach(link)
    }

    /** [proven]: the welcome carried a valid link proof. */
    fun session(version: Int = DEVICE_PROTOCOL_V7, inspectOnly: Boolean = false, proven: Boolean = true) {
        link.welcome(true, version, inspectOnly, proven)
    }

    fun endSession() {
        link.welcome(false)
    }

    /** The interceptor as the app's last application interceptor (or as a network interceptor). */
    fun client(network: Boolean = false, configure: OkHttpClient.Builder.() -> Unit = {}): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .readTimeout(5, TimeUnit.SECONDS)
            .addNetworkInterceptor(CountingInterceptor(networkBodyBytes))
        builder.configure()
        if (network) builder.addNetworkInterceptor(interceptor) else builder.addInterceptor(interceptor)
        return builder.build()
    }

    fun url(path: String = "/") = server.url(path)

    /** The base URL as OkHttp prints it (`http://127.0.0.1:port/`), for mock patterns. */
    val base: String
        get() = url("/").toString()

    fun messages(type: String): List<Map<*, *>> =
        link.v7Lines.map { TestJson.parse(it) as Map<*, *> }.filter { it["type"] == type }

    fun request(): Map<*, *> = messages("httpRequest").single()

    fun response(): Map<*, *> = messages("httpResponse").single()

    /** Applies [rules] as set [rev], as the server would send them. */
    fun mocks(rev: Int, vararg rules: MockRule) {
        link.gateway(GatewayMessage.Mocks(rev, rules.size))
        rules.forEachIndexed { index, rule -> link.gateway(GatewayMessage.Mock(rev, index, rule)) }
    }

    override fun close() {
        server.shutdown()
    }
}

/** The key protocol/fixtures/gateway-messages.ndjson's golden welcome proof was made with: bytes 0x00..0x1f. */
internal val TEST_LINK_KEY = ByteArray(LINK_KEY_BYTES) { it.toByte() }
/** The nonce of the golden v7 hello (protocol/fixtures/device-messages.ndjson). */
internal const val GOLDEN_NONCE = "9f86d081884c7d659a2feaa0c55ad015"
/** The golden welcome: its proof is over [GOLDEN_NONCE] with [TEST_LINK_KEY]. */
internal const val GOLDEN_WELCOME = "{\"type\":\"welcome\",\"protocolVersion\":7,\"mode\":\"session\"," +
    "\"proof\":\"f2d88543b6cc93f29e7d04d3c7239f4bbcbd8b40566ba077664e2729f885a0e4\"}"

internal fun mockRule(
    id: String = "m1",
    method: String? = "GET",
    match: MockMatch = MockMatch.PREFIX,
    url: String,
    action: MockAction = MockAction.RESPOND,
    status: Int = 200,
    headers: List<Pair<String, String>> = listOf("Content-Type" to "application/json"),
    body: String = "{\"mocked\":true}",
    delayMs: Int = 0,
) = MockRule(id, method, match, url, action, status, headers, body.toByteArray(Charsets.UTF_8), delayMs)

/** Counts response body bytes as they come off the network, below every application interceptor. */
internal class CountingInterceptor(private val bytes: AtomicLong) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        val body = response.body ?: return response
        return response.newBuilder().body(CountingBody(body, bytes)).build()
    }

    private class CountingBody(private val delegate: ResponseBody, private val bytes: AtomicLong) : ResponseBody() {
        private val source by lazy {
            object : ForwardingSource(delegate.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    val read = super.read(sink, byteCount)
                    if (read > 0) bytes.addAndGet(read)
                    return read
                }
            }.buffer()
        }

        override fun contentType() = delegate.contentType()

        override fun contentLength() = delegate.contentLength()

        override fun source(): BufferedSource = source
    }
}
